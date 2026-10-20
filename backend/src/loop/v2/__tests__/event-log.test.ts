import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteEventLog } from "../event-log.js";

let workdir: string;
let log: SQLiteEventLog;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-v2-events-"));
  log = new SQLiteEventLog(join(workdir, "events.sqlite"), {
    now: () => "2026-10-20T00:00:00.000Z",
  });
});

afterEach(async () => {
  log.close();
  await rm(workdir, { recursive: true, force: true });
});

function createItem(): void {
  log.createRun({ id: "run-1", metadata: { source: "test" } });
  log.createItem({ id: "item-1", runId: "run-1", metadata: { prompt: "hello" } });
}

describe("SQLite event log", () => {
  it("opens SQLite in WAL mode and creates the run/item event foundation", () => {
    createItem();

    expect(log.journalMode()).toBe("wal");
    expect(log.getRun("run-1")).toMatchObject({
      id: "run-1",
      status: "queued",
      metadata: { source: "test" },
    });
    expect(log.getItem("item-1")).toMatchObject({
      id: "item-1",
      runId: "run-1",
      status: "queued",
      attempt: 0,
      metadata: { prompt: "hello" },
    });
    expect(log.readEvents({ itemId: "item-1" }).map((event) => event.type)).toEqual([
      "item.created",
    ]);
  });

  it("appends transitions, records attempts, and rebuilds state only from events", () => {
    createItem();

    for (const to of ["planning", "making", "checking", "verifying", "rejected"] as const) {
      log.appendItemTransition({ itemId: "item-1", to });
    }
    log.appendItemTransition({ itemId: "item-1", to: "making", reason: "fix review findings" });
    for (const to of ["checking", "verifying", "approved"] as const) {
      log.appendItemTransition({ itemId: "item-1", to });
    }

    const state = log.rebuildItemState("item-1");
    expect(state).toMatchObject({
      itemId: "item-1",
      runId: "run-1",
      status: "approved",
      attempt: 2,
      reason: undefined,
    });

    const events = log.readEvents({ itemId: "item-1" });
    expect(events.map((event) => event.type)).toEqual([
      "item.created",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
      "item.transitioned",
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((a, b) => a - b)
    );
    expect(events.map((event) => event.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const attempts = log.readAttempts("item-1");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ number: 1, status: "rejected" });
    expect(attempts[1]).toMatchObject({ number: 2, status: "approved" });
  });

  it("keeps arbitrary event payloads readable without affecting the item projection", () => {
    createItem();
    log.appendEvent({
      eventId: "note-1",
      runId: "run-1",
      itemId: "item-1",
      type: "item.note",
      payload: { message: "durable note", tags: ["test"] },
    });

    expect(log.readEvents({ itemId: "item-1" }).at(-1)).toMatchObject({
      eventId: "note-1",
      type: "item.note",
      payload: { message: "durable note", tags: ["test"] },
    });
    expect(log.rebuildItemState("item-1")).toMatchObject({
      status: "queued",
      version: 1,
    });
  });

  it("rejects illegal transitions without appending an event", () => {
    createItem();
    const before = log.readEvents({ itemId: "item-1" }).length;

    expect(() => log.appendItemTransition({ itemId: "item-1", to: "checking" })).toThrow(
      /illegal item transition/i
    );
    expect(log.readEvents({ itemId: "item-1" })).toHaveLength(before);
  });

  it("supports filtered event reads and an explicit expected version", () => {
    createItem();
    const planning = log.appendItemTransition({ itemId: "item-1", to: "planning" });
    log.appendEvent({
      eventId: "run-note-1",
      runId: "run-1",
      type: "run.note",
      payload: { ok: true },
    });

    expect(
      log.readEvents({ runId: "run-1", afterSequence: planning.sequence, limit: 1 })
    ).toHaveLength(1);
    expect(() =>
      log.appendEvent({
        eventId: "stale-1",
        runId: "run-1",
        itemId: "item-1",
        type: "item.note",
        expectedVersion: 1,
        payload: {},
      })
    ).toThrow(/expected item version/i);
  });

  it("does not append duplicate run-status events for an unchanged projection", () => {
    const run = log.createRun({ id: "run-1" });
    const first = log.setRunStatus({ runId: run.id, status: "running", metadata: { taskStatus: "planning" } });
    const before = log.readEvents({ runId: run.id }).length;
    const second = log.setRunStatus({ runId: run.id, status: "running", metadata: { taskStatus: "planning" } });

    expect(second).toEqual(first);
    expect(log.readEvents({ runId: run.id })).toHaveLength(before);
  });

  it("rebuilds the same state after reopening the database", () => {
    createItem();
    for (const to of ["planning", "making", "checking", "verifying", "escalated"] as const) {
      log.appendItemTransition({ itemId: "item-1", to });
    }
    const beforeClose = log.rebuildItemState("item-1");
    log.close();

    const reopened = new SQLiteEventLog(join(workdir, "events.sqlite"));
    try {
      expect(reopened.rebuildItemState("item-1")).toEqual(beforeClose);
      expect(reopened.readEvents({ itemId: "item-1" })).toHaveLength(6);
    } finally {
      reopened.close();
    }
    log = reopened;
  });
});
