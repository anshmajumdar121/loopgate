import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { TopBar } from "@/components/TopBar";
import { useWorkflow } from "@/lib/store";
import { useBatchStore } from "@/lib/batchStore";
import { useSelectTask } from "@/lib/selectTask";
import { useFollowActiveTask } from "@/lib/useFollowActiveTask";
import type { Batch } from "@/types/batch";
import type { Task, TaskSummary } from "@/types/loop";

vi.mock("@/hooks/useLoopSocket", () => ({
  useLoopSocket: () => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(),
  }),
}));

type FetchRoute = (url: string) => { status?: number; body: unknown };

function mockFetch(route: FetchRoute) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = route(url);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    } as unknown as Response;
  });
}

function fullTask(id: string, status: Task["status"] = "implementing"): Task {
  return {
    id,
    title: `Task ${id}`,
    prompt: "p",
    workdir: "/tmp/workdir",
    status,
    attempt: status === "planning" ? 0 : 1,
    maxAttempts: 3,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    history: [],
    logs: [],
  };
}

function summary(task: Task): TaskSummary {
  return task as TaskSummary;
}

function FollowHarness({ subscribe }: { subscribe: (taskId: string) => void }) {
  useFollowActiveTask({ subscribe });
  return null;
}

const originalFetch = globalThis.fetch;

const BATCH: Batch = {
  id: "batch-1",
  title: "Batch",
  promptTemplate: "Fix {{item}}",
  items: [
    { index: 0, input: "a.ts", status: "done", taskId: "old" },
    { index: 1, input: "b.ts", status: "running", taskId: "live-2" },
    { index: 2, input: "c.ts", status: "pending" },
  ],
  workdirRoot: "/tmp/batch",
  status: "running",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
  useWorkflow.setState({
    currentTaskId: "old",
    taskMirror: fullTask("old", "done"),
    activeTask: null,
    followLive: true,
    phase: "done",
    isRunning: false,
    logs: [],
  });
  useBatchStore.setState({ batches: [], loaded: true, selectedBatchId: null });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Follow live", () => {
  it("switches through selectTask when the active task changes", async () => {
    const next = fullTask("live-2", "implementing");
    const subscribe = vi.fn();
    globalThis.fetch = mockFetch((url) => {
      if (url === "/api/tasks/active") return { body: { task: summary(next) } };
      if (url === "/api/tasks/live-2") return { body: { task: next } };
      return { status: 404, body: {} };
    });

    render(<FollowHarness subscribe={subscribe} />);

    await waitFor(() => {
      expect(useWorkflow.getState().currentTaskId).toBe("live-2");
    });
    expect(useWorkflow.getState().taskMirror?.title).toBe("Task live-2");
    expect(subscribe).toHaveBeenCalledWith("live-2");
    expect(useWorkflow.getState().followLive).toBe(true);
  });

  it("hydrates a task started elsewhere even when its id is already selected", async () => {
    const next = fullTask("created-elsewhere", "planning");
    const subscribe = vi.fn();
    useWorkflow.setState({
      currentTaskId: next.id,
      taskMirror: null,
      phase: null,
      isRunning: true,
      followLive: true,
    });
    globalThis.fetch = mockFetch((url) => {
      if (url === "/api/tasks/active") return { body: { task: summary(next) } };
      if (url === "/api/tasks/created-elsewhere") return { body: { task: next } };
      return { status: 404, body: {} };
    });

    render(<FollowHarness subscribe={subscribe} />);

    await waitFor(() => expect(useWorkflow.getState().taskMirror?.id).toBe(next.id));
    expect(subscribe).toHaveBeenCalledWith(next.id);
    expect(useWorkflow.getState().phase).toBe("planning");
  });

  it("polls immediately after a batch_update event", async () => {
    const next = fullTask("live-2", "verifying");
    let activeCalls = 0;
    const subscribe = vi.fn();
    globalThis.fetch = mockFetch((url) => {
      if (url === "/api/tasks/active") {
        activeCalls += 1;
        return activeCalls === 1
          ? { body: { task: null } }
          : { body: { task: summary(next) } };
      }
      if (url === "/api/tasks/live-2") return { body: { task: next } };
      return { status: 404, body: {} };
    });

    render(<FollowHarness subscribe={subscribe} />);
    await waitFor(() => expect(activeCalls).toBe(1));

    act(() => {
      window.dispatchEvent(new CustomEvent("loop:batch-update"));
    });

    await waitFor(() => expect(useWorkflow.getState().currentTaskId).toBe("live-2"));
    expect(activeCalls).toBe(2);
  });

  it("turns Follow live off before a manual sidebar selection", async () => {
    const selected = fullTask("manual", "done");
    globalThis.fetch = mockFetch((url) => {
      if (url === "/api/tasks/manual") return { body: { task: selected } };
      return { body: { connections: [] } };
    });

    const { result } = renderHook(() => useSelectTask());
    act(() => result.current("manual"));

    expect(useWorkflow.getState().followLive).toBe(false);
    await waitFor(() => expect(useWorkflow.getState().currentTaskId).toBe("manual"));
    expect(localStorage.getItem("followLive")).toBe("false");
  });

  it("shows LIVE with batch position, then toggles to Follow live and Idle", async () => {
    useBatchStore.setState({ batches: [BATCH], loaded: true, selectedBatchId: null });
    useWorkflow.setState({
      currentTaskId: "live-2",
      activeTask: {
        ...summary(fullTask("live-2", "verifying")),
        batchId: "batch-1",
      },
      followLive: true,
      phase: "verifying",
      taskMirror: fullTask("live-2", "verifying"),
      isRunning: true,
    });
    globalThis.fetch = mockFetch((url) => {
      if (url === "/api/connections") return { body: { connections: [] } };
      return { body: {} };
    });

    render(<TopBar onToggleSidebar={() => {}} onNewTask={() => {}} />);

    const chip = screen.getByTestId("follow-live-chip");
    await waitFor(() => expect(chip.textContent ?? "").toContain("LIVE"));
    expect(chip.textContent ?? "").toContain("Task live-2");
    expect(chip.textContent ?? "").toContain("Verifying");
    expect(chip.textContent ?? "").toContain("batch item 2 of 3");

    fireEvent.click(chip);
    expect(screen.getByTestId("follow-live-chip").textContent ?? "").toContain("Follow live");

    act(() => {
      useWorkflow.setState({
        activeTask: null,
        isRunning: false,
        taskMirror: fullTask("live-2", "done"),
        phase: "done",
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("follow-live-chip").textContent ?? "").toContain("Idle")
    );
  });
});
