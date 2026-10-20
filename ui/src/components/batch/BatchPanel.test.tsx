import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { BatchPanel } from "./BatchPanel";
import { useBatchStore } from "@/lib/batchStore";
import { useWorkflow } from "@/lib/store";
import type { Batch } from "@/types/batch";

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockFetch(handler: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    const r = handler(u, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  });
}

const SAMPLE_BATCH: Batch = {
  id: "b1",
  title: "Test every util",
  promptTemplate: "Write tests for {{item}}",
  workdirRoot: "/tmp/batches/b1",
  maxAttempts: 3,
  status: "running",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:05:00.000Z",
  items: [
    { index: 0, input: "format.ts", status: "done", taskId: "t-0", attempts: 1 },
    { index: 1, input: "layout.ts", status: "escalated", taskId: "t-1", attempts: 3, reason: "max attempts reached" },
    { index: 2, input: "utils.ts", status: "running", taskId: "t-2", attempts: 2 },
    { index: 3, input: "store.ts", status: "failed", reason: "spawn error" },
    { index: 4, input: "nodeGroups.ts", status: "pending" },
  ],
};

function baseRoutes(batches: Batch[]): Handler {
  return (url) => {
    if (url.startsWith("/api/connections")) return { status: 200, body: { connections: [] } };
    if (url === "/api/batches") return { status: 200, body: { batches } };
    return { status: 404, body: { error: "not found" } };
  };
}

describe("BatchPanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    useBatchStore.setState({ batches: [], loaded: false, selectedBatchId: null });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("renders as a dialog and requires {{item}} in the template", async () => {
    const fetchMock = mockFetch(baseRoutes([]));
    globalThis.fetch = fetchMock;
    render(<BatchPanel onClose={() => {}} onSelectTask={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Batch runs" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Refactor this file" },
    });
    fireEvent.change(screen.getByLabelText("Items (one per line)"), {
      target: { value: "a.ts\nb.ts" },
    });
    expect(screen.getByTestId("batch-item-count").textContent).toBe("2 items");
    fireEvent.click(screen.getByRole("button", { name: "Start batch" }));

    expect(screen.getByRole("alert").textContent).toMatch(/must contain \{\{item\}\}/);
    const posted = fetchMock.mock.calls.some(([, init]) => init?.method === "POST");
    expect(posted).toBe(false);
  });

  it("requires at least one item", () => {
    globalThis.fetch = mockFetch(baseRoutes([]));
    render(<BatchPanel onClose={() => {}} onSelectTask={() => {}} />);
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Fix {{item}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start batch" }));
    expect(screen.getByRole("alert").textContent).toMatch(/at least one item/);
  });

  it("POSTs the expected body and opens the new batch", async () => {
    const nodeModels = useWorkflow.getState().nodeModels;
    let postedBody: unknown = null;
    const fetchMock = mockFetch((url, init) => {
      if (url === "/api/batches" && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        return {
          status: 201,
          body: {
            batch: {
              ...SAMPLE_BATCH,
              id: "new1",
              title: "My batch",
              status: "queued",
              items: [
                { index: 0, input: "a.ts", status: "pending" },
                { index: 1, input: "b.ts", status: "pending" },
              ],
            },
          },
        };
      }
      return baseRoutes([])(url, init);
    });
    globalThis.fetch = fetchMock;
    render(<BatchPanel onClose={() => {}} onSelectTask={() => {}} />);

    fireEvent.change(screen.getByLabelText("Title (optional)"), { target: { value: "My batch" } });
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Add tests for {{item}} (#{{index}})" },
    });
    fireEvent.change(screen.getByLabelText("Items (one per line)"), {
      target: { value: "a.ts\n\n  b.ts  \n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start batch" }));

    await waitFor(() => expect(postedBody).not.toBeNull());
    expect(postedBody).toEqual({
      promptTemplate: "Add tests for {{item}} (#{{index}})",
      items: ["a.ts", "b.ts"],
      title: "My batch",
      maxAttempts: 3,
      modelOverrides: {
        planning: nodeModels.planning,
        implementation: nodeModels.implementation,
        review: nodeModels.review,
      },
    });
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[1]?.headers).toEqual({ "Content-Type": "application/json" });

    // Detail view for the created batch.
    await waitFor(() => expect(screen.getByRole("list", { name: "Batch items" })).toBeTruthy());
    expect(screen.getByText("My batch")).toBeTruthy();
  });

  it("shows server errors inline", async () => {
    globalThis.fetch = mockFetch((url, init) => {
      if (url === "/api/batches" && init?.method === "POST") {
        return { status: 409, body: { error: "another batch is running" } };
      }
      return baseRoutes([])(url, init);
    });
    render(<BatchPanel onClose={() => {}} onSelectTask={() => {}} />);
    fireEvent.change(screen.getByLabelText("Prompt template"), { target: { value: "Fix {{item}}" } });
    fireEvent.change(screen.getByLabelText("Items (one per line)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Start batch" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("another batch is running"));
  });

  it("renders item statuses from a mocked batch and selects tasks on click", async () => {
    globalThis.fetch = mockFetch(baseRoutes([SAMPLE_BATCH]));
    const onSelectTask = vi.fn();
    render(<BatchPanel onClose={() => {}} onSelectTask={onSelectTask} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open batch Test every util" }));

    const list = await screen.findByRole("list", { name: "Batch items" });
    const statuses = SAMPLE_BATCH.items.map(
      (it) => within(list).getByTestId(`batch-item-${it.index}`).getAttribute("data-status")
    );
    expect(statuses).toEqual(["done", "escalated", "running", "failed", "pending"]);

    const escalated = within(list).getByTestId("batch-item-1");
    expect(within(escalated).getByText("Escalated")).toBeTruthy();
    expect(within(escalated).getByText("max attempts reached")).toBeTruthy();
    expect(within(escalated).getByText("attempt 3/3")).toBeTruthy();
    expect(within(within(list).getByTestId("batch-item-3")).getByText("Failed")).toBeTruthy();
    expect(within(within(list).getByTestId("batch-item-4")).getByText("Pending")).toBeTruthy();

    const progress = screen.getByRole("progressbar", { name: "Batch progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("5");

    // Running batch → Cancel available, Resume hidden.
    expect(screen.getByRole("button", { name: "Cancel batch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume batch" })).toBeNull();

    fireEvent.click(within(escalated).getByRole("button"));
    expect(onSelectTask).toHaveBeenCalledWith("t-1");
    // Items without a task id aren't clickable.
    expect(within(within(list).getByTestId("batch-item-4")).queryByRole("button")).toBeNull();
  });

  it("applies batch_update-style upserts and shows the report path", async () => {
    globalThis.fetch = mockFetch(baseRoutes([SAMPLE_BATCH]));
    render(<BatchPanel onClose={() => {}} onSelectTask={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open batch Test every util" }));

    useBatchStore.getState().upsertBatch({
      ...SAMPLE_BATCH,
      status: "partial",
      reportPath: "/tmp/batches/b1/REPORT.md",
      items: SAMPLE_BATCH.items.map((i) => (i.status === "running" ? { ...i, status: "done" } : i)),
    });

    await waitFor(() => expect(screen.getByText("/tmp/batches/b1/REPORT.md")).toBeTruthy());
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume batch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel batch" })).toBeNull();
  });
});
