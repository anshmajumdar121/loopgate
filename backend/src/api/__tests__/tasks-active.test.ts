import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { loadTasksFromDisk } from "../../store/tasks.js";
import type { Task } from "../../types.js";

function app() {
  const a = new Hono();
  a.route("/api", tasksApi);
  return a;
}

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    title: "Live task",
    prompt: "build it",
    workdir: "/tmp/task-1",
    status: "done",
    attempt: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    history: [],
    logs: [],
    ...overrides,
  };
}

describe("GET /api/tasks/active", () => {
  beforeEach(() => {
    loadTasksFromDisk([]);
  });

  it("returns null when no task is active", async () => {
    loadTasksFromDisk([task()]);

    const res = await app().request("/api/tasks/active");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task: null });
  });

  it("returns the active task snapshot before the id route", async () => {
    loadTasksFromDisk([
      task({
        status: "implementing",
        batchId: "batch-1",
        history: [
          {
            ts: new Date().toISOString(),
            phase: "implementing",
            message: "maker started",
          },
        ],
      }),
    ]);

    const res = await app().request("/api/tasks/active");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      task: {
        id: "task-1",
        status: "implementing",
        title: "Live task",
        batchId: "batch-1",
        phase: "implementing",
      },
    });
  });
});
