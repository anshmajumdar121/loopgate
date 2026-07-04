import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { createTask, getTask, listTasks, removeTask } from "../../store/tasks.js";

function app() {
  const a = new Hono();
  a.route("/api", tasksApi);
  return a;
}

beforeEach(() => {
  for (const t of listTasks()) removeTask(t.id);
});

describe("POST /api/tasks/:id/re-prompt", () => {
  it("returns 400 when prompt is missing", async () => {
    const res = await app().request("/api/tasks/abc/re-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when task does not exist", async () => {
    const res = await app().request("/api/tasks/nonexistent/re-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "new" }),
    });
    expect(res.status).toBe(404);
  });

  it("overwrites prompt and bumps attempt on a draft task", async () => {
    const task = createTask({ prompt: "old", workdir: "/tmp" });
    const res = await app().request(`/api/tasks/${task.id}/re-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "new prompt" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.attempt).toBe(1);

    const updated = getTask(task.id);
    expect(updated?.prompt).toBe("new prompt");
    expect(updated?.attempt).toBe(1);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("returns 404 for missing task", async () => {
    const res = await app().request("/api/tasks/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes an existing task", async () => {
    const task = createTask({ prompt: "p", workdir: "/tmp" });
    const res = await app().request(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(getTask(task.id)).toBeUndefined();
  });
});