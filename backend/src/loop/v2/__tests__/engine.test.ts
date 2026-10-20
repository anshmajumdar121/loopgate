import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V2RunModel,
  closeV2EventLogs,
  getV2EventLog,
  isV2EngineEnabled,
  resolveEventLogPath,
  runLoopV2,
} from "../engine.js";
import { SQLiteEventLog } from "../event-log.js";
import type { Task } from "../../../types.js";

let workdir: string;
let databasePath: string;

function makeTask(status: Task["status"] = "draft"): Task {
  const now = "2026-10-20T00:00:00.000Z";
  return {
    id: "task-1",
    title: "test task",
    prompt: "test task",
    workdir,
    status,
    attempt: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    history: [],
    logs: [],
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-v2-engine-"));
  databasePath = join(workdir, "events.sqlite");
});

afterEach(async () => {
  closeV2EventLogs();
  // createTask persists asynchronously; give its best-effort write a chance
  // to settle before removing the isolated fixture directory.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(workdir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
});

describe("v2 engine projection", () => {
  it("records the legacy plan -> make -> check -> verify -> approve path", () => {
    const log = new SQLiteEventLog(databasePath, {
      now: () => "2026-10-20T00:00:00.000Z",
    });
    try {
      const model = new V2RunModel(log);
      const task = makeTask();
      model.ensureTask(task);

      for (const status of ["planning", "plan_review", "implementing", "verifying"] as const) {
        task.status = status;
        task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
        model.sync(task);
      }
      task.status = "done";
      task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
      model.sync(task);

      const events = log.readItemEvents("item:task-1");
      expect(events.map((event) => event.type === "item.created" ? event.type : event.to)).toEqual([
        "item.created",
        "planning",
        "making",
        "checking",
        "verifying",
        "approved",
      ]);
      expect(log.rebuildItemState("item:task-1")).toMatchObject({
        status: "approved",
        attempt: 1,
      });
      expect(log.getRun("run:task-1")?.status).toBe("approved");
    } finally {
      log.close();
    }
  });

  it("preserves verifier rejection before a retry attempt", () => {
    const log = new SQLiteEventLog(databasePath);
    try {
      const model = new V2RunModel(log);
      const task = makeTask("verifying");
      model.ensureTask({ ...task, status: "draft" });
      model.sync(task);
      task.status = "implementing";
      task.verdict = {
        attempt: 1,
        outcome: "REJECT",
        buildExit: 1,
        testsPassed: 0,
        testsFailed: 1,
        scopePass: true,
        intentPass: false,
        noCheatingPass: true,
        risk: "LOW",
        criteriaWalk: [],
        requiredFixes: ["fix the failing test"],
        oneLineReason: "test failed",
      };
      model.sync(task);

      expect(log.rebuildItemState("item:task-1")).toMatchObject({
        status: "making",
        attempt: 2,
      });
      expect(log.readAttempts("item:task-1")).toHaveLength(2);
      expect(log.readItemEvents("item:task-1").map((event) =>
        event.type === "item.created" ? event.type : `${event.from}->${event.to}`
      )).toContain("verifying->rejected");
    } finally {
      log.close();
    }
  });

  it("allows cancellation before a maker attempt exists", () => {
    const log = new SQLiteEventLog(databasePath);
    try {
      const model = new V2RunModel(log);
      const task = makeTask("planning");
      model.ensureTask({ ...task, status: "draft" });
      model.sync(task);
      task.status = "cancelled";
      model.sync(task);
      expect(log.rebuildItemState("item:task-1").status).toBe("cancelled");
    } finally {
      log.close();
    }
  });
});

describe("v2 feature flag and dispatcher", () => {
  it("only enables the v2 engine for LOOP_ENGINE=v2", () => {
    expect(isV2EngineEnabled({ LOOP_ENGINE: "v2" })).toBe(true);
    expect(isV2EngineEnabled({ LOOP_ENGINE: "legacy" })).toBe(false);
    expect(isV2EngineEnabled({})).toBe(false);
  });

  it("wraps the legacy runner and leaves the final behavior unchanged", async () => {
    const previousDataDir = process.env.LOOP_DATA_DIR;
    const previousEventLog = process.env.LOOP_EVENT_LOG_PATH;
    process.env.LOOP_DATA_DIR = join(workdir, "tasks");
    process.env.LOOP_EVENT_LOG_PATH = databasePath;
    try {
      const { createTask, getTask, updateTask } = await import("../../../store/tasks.js");
      const task = createTask({ prompt: "demo", workdir });
      await runLoopV2(task.id, async (taskId) => {
        updateTask(taskId, { status: "done" });
      });

      expect(getTask(task.id)?.status).toBe("done");
      expect(getV2EventLog().rebuildItemState(`item:${task.id}`).status).toBe("approved");
    } finally {
      if (previousDataDir === undefined) delete process.env.LOOP_DATA_DIR;
      else process.env.LOOP_DATA_DIR = previousDataDir;
      if (previousEventLog === undefined) delete process.env.LOOP_EVENT_LOG_PATH;
      else process.env.LOOP_EVENT_LOG_PATH = previousEventLog;
    }
  });

  it("resolves an explicit event-log path without touching the default data tree", () => {
    expect(resolveEventLogPath({ LOOP_EVENT_LOG_PATH: databasePath })).toBe(databasePath);
  });
});
