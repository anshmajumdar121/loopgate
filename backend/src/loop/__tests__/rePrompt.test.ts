import { describe, it, expect, beforeEach } from "vitest";
import { rePrompt } from "../orchestrator.js";
import { createTask, getTask, listTasks, removeTask } from "../../store/tasks.js";

beforeEach(() => {
  for (const t of listTasks()) removeTask(t.id);
});

describe("rePrompt", () => {
  it("returns false when task does not exist", () => {
    expect(rePrompt("nonexistent", "new prompt")).toBe(false);
  });

  it("overwrites the prompt and increments attempt on a draft task", () => {
    const task = createTask({ prompt: "old", workdir: "/tmp" });
    expect(task.prompt).toBe("old");
    expect(task.attempt ?? 0).toBe(0);

    const ok = rePrompt(task.id, "new prompt");
    expect(ok).toBe(true);

    const updated = getTask(task.id);
    expect(updated?.prompt).toBe("new prompt");
    expect(updated?.attempt).toBe(1);
  });

  it("clears plan, diff, verdict, history, logs", () => {
    const task = createTask({ prompt: "old", workdir: "/tmp" });
    rePrompt(task.id, "new");
    const updated = getTask(task.id);
    expect(updated?.plan).toBeUndefined();
    expect(updated?.diff).toBeUndefined();
    expect(updated?.verdict).toBeUndefined();
    expect(updated?.history).toEqual([]);
    expect(updated?.logs).toEqual([]);
  });
});