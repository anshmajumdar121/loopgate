import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { selectTask } from "./selectTask";
import type { Task } from "@/types/loop";

const originalFetch = globalThis.fetch;

function fullTask(id: string): Task {
  return { id, title: id, prompt: "p", plan: { steps: 1 }, logs: [], history: [] } as unknown as Task;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("selectTask", () => {
  let loadTask: Mock<(task: Task) => void>;
  let subscribe: Mock<(id: string) => void>;
  beforeEach(() => {
    loadTask = vi.fn<(task: Task) => void>();
    subscribe = vi.fn<(id: string) => void>();
  });

  it("fetches the full task, loads it, then subscribes", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ task: fullTask("a") }), { status: 200 })
    ) as unknown as typeof fetch;
    await selectTask("a", loadTask, subscribe);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tasks/a");
    expect(loadTask).toHaveBeenCalledWith(expect.objectContaining({ id: "a", plan: { steps: 1 } }));
    expect(subscribe).toHaveBeenCalledWith("a");
  });

  it("drops a slow response when a newer task was selected meanwhile", async () => {
    let releaseA: () => void = () => {};
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith("/a")) {
        return new Promise<Response>((resolve) => {
          releaseA = () => resolve(new Response(JSON.stringify({ task: fullTask("a") }), { status: 200 }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ task: fullTask("b") }), { status: 200 }));
    }) as unknown as typeof fetch;

    const first = selectTask("a", loadTask, subscribe);
    await selectTask("b", loadTask, subscribe);
    releaseA();
    await first;

    expect(loadTask).toHaveBeenCalledTimes(1);
    expect(loadTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("does nothing (and does not throw) when the fetch fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await selectTask("gone", loadTask, subscribe);
    expect(loadTask).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
