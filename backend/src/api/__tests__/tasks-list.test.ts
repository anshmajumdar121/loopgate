import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { loadTasksFromDisk } from "../../store/tasks.js";

// The list endpoint feeds the sidebar, which only needs a row's worth of
// data. Sending every task's prompt/logs/plan/diff made one call ~240 KB at
// 900 tasks and stalled the server's event loop under load.
function heavyTask(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${id}`,
    prompt: "x".repeat(5_000),
    workdir: `/tmp/${id}`,
    status: "done",
    attempt: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    projectId: "p1",
    sessionId: "s1",
    plan: { steps: 2, filesToTouch: ["a.js"], criteria: [], rawGoal: "g".repeat(5_000) },
    diff: { files: [], summary: "d".repeat(5_000) },
    verdict: { outcome: "APPROVE", reason: "r".repeat(1_000) },
    history: Array.from({ length: 50 }, (_, i) => ({ status: "done", at: now, message: `h${i}` })),
    logs: Array.from({ length: 500 }, (_, i) => ({ agent: "planner", stream: "stdout", text: `line ${i}`, at: now })),
    attempts: [{ attempt: 1 }],
    contextFiles: ["/tmp/ref.md"],
  } as never;
}

describe("GET /tasks (summary list)", () => {
  beforeEach(() => {
    loadTasksFromDisk([heavyTask("t1"), heavyTask("t2")]);
  });

  const app = () => new Hono().route("/", tasksApi);

  it("returns row-sized summaries without the heavy fields", async () => {
    const res = await app().request("/tasks");
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as { tasks: Record<string, unknown>[] };
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      for (const heavy of ["prompt", "plan", "diff", "verdict", "history", "logs", "attempts", "runtimeCheck", "contextFiles"]) {
        expect(t).not.toHaveProperty(heavy);
      }
      expect(t).toMatchObject({
        status: "done",
        attempt: 1,
        maxAttempts: 3,
        projectId: "p1",
        sessionId: "s1",
      });
      expect(typeof t.title).toBe("string");
      expect(typeof t.workdir).toBe("string");
    }
  });

  it("keeps each summary tiny", async () => {
    const res = await app().request("/tasks");
    const body = await res.text();
    expect(body.length / 2).toBeLessThan(1_000); // bytes per task; was ~100 KB for these fixtures
  });

  it("GET /tasks/:id still returns the full task", async () => {
    const res = await app().request("/tasks/t1");
    const { task } = (await res.json()) as { task: Record<string, unknown> };
    expect(task.prompt).toHaveLength(5_000);
    expect((task.logs as unknown[]).length).toBe(500);
    expect(task).toHaveProperty("plan");
  });
});
