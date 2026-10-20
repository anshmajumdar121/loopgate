import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";

// Keep this focused component test independent from React Flow's browser
// runtime; the node's own handles are mocked while the real Zustand stores
// and Testing Library rendering remain under test.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
  applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
  addEdge: (connection: unknown, edges: unknown[]) => [...edges, connection],
}));
import { MapNode } from "./MapNode";
import { useBatchStore } from "@/lib/batchStore";
import { useWorkflow } from "@/lib/store";
import type { Batch } from "@/types/batch";
import type { TaskSummary } from "@/types/loop";

const SAMPLE_BATCH: Batch = {
  id: "batch-live",
  title: "Nightly refactor sweep",
  promptTemplate: "Review {{item}}",
  workdirRoot: "/tmp/batches/batch-live",
  maxAttempts: 3,
  status: "running",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:05:00.000Z",
  items: [
    { index: 0, input: "format.ts", status: "done", taskId: "task-done", attempts: 1 },
    { index: 1, input: "layout.ts", status: "running", taskId: "task-running", attempts: 2 },
    { index: 2, input: "store.ts", status: "pending", attempts: 0 },
    { index: 3, input: "parser.ts", status: "escalated", attempts: 3, reason: "Needs a human" },
    { index: 4, input: "socket.ts", status: "failed", attempts: 2, reason: "spawn error" },
    { index: 5, input: "types.ts", status: "cancelled", attempts: 1 },
  ],
};

function nodeProps(): NodeProps {
  return {
    id: "map",
    type: "map",
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: false,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    isConnectable: true,
    data: {
      spec: { id: "map", title: "Map", subtitle: "Run one loop across many items." },
      status: "idle",
    },
  } as NodeProps;
}

beforeEach(() => {
  useBatchStore.setState({ batches: [], loaded: true, selectedBatchId: null });
  useWorkflow.setState({ activeTask: null });
});

afterEach(() => {
  cleanup();
});

describe("MapNode", () => {
  it("renders a useful idle state when no batch exists", () => {
    render(<MapNode {...nodeProps()} />);

    expect(screen.getByTestId("map-node-empty")).toBeTruthy();
    expect(screen.getByText("No batch runs yet")).toBeTruthy();
    expect(screen.getByText(/Start a batch to see each item/)).toBeTruthy();
  });

  it("renders the latest batch with live item emphasis, statuses, and attempts", () => {
    useBatchStore.setState({ batches: [SAMPLE_BATCH], loaded: true, selectedBatchId: null });
    useWorkflow.setState({
      activeTask: { id: "task-running", batchId: "batch-live" } as TaskSummary,
    });

    render(<MapNode {...nodeProps()} />);

    expect(screen.getByRole("heading", { name: "Nightly refactor sweep" })).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Batch progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("6");
    expect(screen.getByTestId("map-batch-counts").textContent).toContain("1/6 done");

    const running = screen.getByTestId("map-item-1");
    expect(running.getAttribute("data-status")).toBe("running");
    expect(running.getAttribute("data-live")).toBe("true");
    expect(running.getAttribute("data-active-task")).toBe("true");
    expect(within(running).getByLabelText("Running item 2")).toBeTruthy();
    expect(within(running).getByText("Running")).toBeTruthy();
    expect(within(running).getByText("attempt 2/3")).toBeTruthy();

    const expectedStatuses: Array<[number, string]> = [
      [0, "Done"],
      [2, "Pending"],
      [3, "Escalated"],
      [4, "Failed"],
      [5, "Cancelled"],
    ];
    for (const [index, label] of expectedStatuses) {
      expect(within(screen.getByTestId(`map-item-${index}`)).getByText(label)).toBeTruthy();
    }
  });
});
