import { describe, it, expect, afterEach, vi } from "vitest";
import { createDemoSocketClass, StaticBackend, MAX_GAP_MS, type Recording } from "./player";
import recordingJson from "./recording.json";

function fixture(): Recording {
  return {
    version: 1,
    recordedAt: "2026-10-21T00:00:00.000Z",
    durationMs: 12_000,
    batch: { title: "Landing pages", promptTemplate: "Build {{item}}", items: ["A", "B"] },
    events: [
      { t: 100, msg: { type: "batch_update", batchId: "b1" } },
      { t: 200, taskId: "t1", msg: { type: "phase_change", taskId: "t1" } },
      { t: 300, taskId: "t2", msg: { type: "phase_change", taskId: "t2" } },
      // A 10 s idle stretch that playback must shorten to MAX_GAP_MS.
      { t: 10_300, taskId: "t1", msg: { type: "done", taskId: "t1" } },
    ],
    snapshots: [
      { t: 0, path: "/api/tasks/active", status: 200, body: { task: null } },
      { t: 0, path: "/api/batches", status: 200, body: { batches: [] } },
      { t: 150, path: "/api/batches", status: 200, body: { batches: [{ id: "b1", status: "running" }] } },
      { t: 250, path: "/api/tasks/active", status: 200, body: { task: { id: "t1", status: "planning" } } },
      { t: 260, path: "/api/tasks/t1", status: 200, body: { task: { id: "t1", status: "planning" } } },
    ],
    statics: {
      "/api/connections": { status: 200, body: { connections: [{ id: "public-demo-llm" }] } },
      "/api/improve-recipe": { status: 200, text: "# recipe" },
    },
  };
}

const body = async (r: Response) => r.json();

afterEach(() => {
  vi.useRealTimers();
});

describe("StaticBackend", () => {
  it("answers from the snapshot that was current at the playback position", async () => {
    let now = 0;
    const be = new StaticBackend(fixture(), () => now);
    expect(await body(be.handle("GET", "/api/tasks/active"))).toEqual({ task: null });
    expect(be.handle("GET", "/api/tasks/t1").status).toBe(404);

    be.start();
    now = 270;
    expect(await body(be.handle("GET", "/api/tasks/active"))).toEqual({ task: { id: "t1", status: "planning" } });
    expect(await body(be.handle("GET", "/api/tasks/t1"))).toEqual({ task: { id: "t1", status: "planning" } });
    expect(await body(be.handle("GET", "/api/batches/b1"))).toEqual({ batch: { id: "b1", status: "running" } });
    expect(await be.handle("GET", "/api/improve-recipe").text()).toBe("# recipe");
    expect((await body(be.handle("GET", "/api/connections"))).connections[0].id).toBe("public-demo-llm");
  });

  it("shortens idle gaps and freezes on the final state", () => {
    let now = 0;
    const be = new StaticBackend(fixture(), () => now);
    expect(be.duration).toBeLessThan(300 + MAX_GAP_MS + 1_000);
    be.start();
    now = 1_000_000;
    expect(be.isPlaying()).toBe(false);
    expect(be.position()).toBe(be.duration);
  });

  it("refuses every write with the preview notice, but replays on batch submit", async () => {
    let now = 0;
    const be = new StaticBackend(fixture(), () => now);
    for (const [m, p] of [
      ["POST", "/api/tasks"],
      ["POST", "/api/connections"],
      ["DELETE", "/api/tasks/t1"],
      ["POST", "/api/ratchet/snapshot"],
    ]) {
      const r = be.handle(m, p);
      expect(r.status).toBe(403);
      expect((await body(r)).error).toMatch(/static demo preview/);
    }
    const created = be.handle("POST", "/api/batches");
    expect(created.status).toBe(201);
    expect((await body(created)).batch).toEqual({ id: "b1", status: "running" });
    now = 10;
    expect(be.handle("POST", "/api/batches").status).toBe(409); // still playing
    expect((await body(be.handle("GET", "/api/demo"))).staticPreview).toBe(true);
  });
});

describe("DemoSocket", () => {
  it("opens, honours subscriptions and answers pings", async () => {
    vi.useFakeTimers();
    let now = 0;
    const be = new StaticBackend(fixture(), () => now);
    const Socket = createDemoSocketClass(be);
    const ws = new Socket("ws://localhost/ws");
    const got: Array<{ type: string; taskId?: string }> = [];
    ws.onmessage = (ev) => got.push(JSON.parse(ev.data));
    let opened = false;
    ws.onopen = () => (opened = true);
    vi.advanceTimersByTime(50);
    expect(opened).toBe(true);
    expect(ws.readyState).toBe(Socket.OPEN);
    expect(got).toEqual([{ type: "pong" }]);

    ws.send(JSON.stringify({ type: "subscribe", taskId: "t1" }));
    be.start();
    now = 400;
    be.tick();
    // Global batch_update + t1's event; t2's event is filtered out.
    expect(got.slice(1).map((m) => `${m.type}:${m.taskId ?? "-"}`)).toEqual(["batch_update:-", "phase_change:t1"]);

    ws.send(JSON.stringify({ type: "ping" }));
    expect(got[got.length - 1]).toEqual({ type: "pong" });

    let closed = false;
    ws.onclose = () => (closed = true);
    ws.close();
    expect(closed).toBe(true);
    expect(be.sockets.size).toBe(0);
  });
});

describe("the committed recording", () => {
  const rec = recordingJson as unknown as Recording;

  it("is a complete run of the README batch", () => {
    expect(rec.batch.items).toEqual(["Acme Coffee", "Nimbus Cloud", "FAIL-ME Corp", "Orbit Bikes"]);
    const types = new Set(rec.events.map((e) => e.msg.type));
    for (const t of ["batch_update", "task_update", "phase_change", "plan_ready", "diff_ready", "verdict", "escalation", "done"]) {
      expect(types).toContain(t);
    }
    const lastBatches = [...rec.snapshots].reverse().find((s) => s.path === "/api/batches")!.body as {
      batches: Array<{ items: Array<{ status: string }> }>;
    };
    expect(lastBatches.batches[0].items.map((i) => i.status)).toEqual(["done", "done", "escalated", "done"]);
  });

  it("contains no machine-specific paths", () => {
    const text = JSON.stringify(rec);
    expect(text).not.toMatch(/[A-Za-z]:\\\\/); // C:\ style
    expect(text).not.toMatch(/\\\\Users\\\\|\/Users\/|AppData/);
  });
});
