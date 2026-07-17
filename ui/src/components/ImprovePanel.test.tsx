import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImprovePanel } from "./ImprovePanel.js";

const SAMPLE_FINDINGS = [
  {
    kind: "repeated-reject" as const,
    pattern: "criteria missing",
    count: 7,
    examples: [
      { taskId: "t1", attempt: 1 },
      { taskId: "t2", attempt: 1 },
    ],
    role: "verifier" as const,
    suggestedFix: "prompt" as const,
  },
];

const SAMPLE_SNAPSHOTS = [
  {
    id: "2026-07-16T17-53-13Z-a3f2",
    path: "/tmp/agents-2026-07-16T17-53-13Z-a3f2",
    createdAt: "2026-07-16T17:53:13.000Z",
    fileCount: 3,
  },
];

const SAMPLE_RECIPE =
  "# Recursive Improve — Agent Prompt Patches (2026-07-16)\n\n## Task\n...";

function mockFetch(
  handler: (url: string) => { ok: boolean; body: unknown; contentType?: string }
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input.toString();
    const r = handler(u);
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      json: async () => r.body,
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      headers: {
        get: (k: string) =>
          k === "content-type" ? r.contentType ?? "application/json" : null,
      },
    } as unknown as Response;
  });
}

describe("ImprovePanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders the title and three section headers", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: [] } };
      }
      // useTaskList + snapshots both no-op.
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    expect(screen.getByText("Recursive Improve")).toBeTruthy();
    expect(screen.getByText("Insights")).toBeTruthy();
    expect(screen.getByText("Recipe")).toBeTruthy();
    expect(screen.getByText("Snapshots")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/No patterns detected/)).toBeTruthy()
    );
  });

  it("renders a finding row with count badge", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: SAMPLE_FINDINGS } };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    await waitFor(() => expect(screen.getByText('"criteria missing"')).toBeTruthy());
    expect(screen.getByText("7 ×")).toBeTruthy();
    expect(screen.getByText(/role: verifier/)).toBeTruthy();
  });

  it("renders a kind label for each finding", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return {
          ok: true,
          body: {
            findings: [
              {
                ...SAMPLE_FINDINGS[0],
                kind: "criteria-miss",
                pattern: "button has color",
              },
              {
                ...SAMPLE_FINDINGS[0],
                kind: "stall-cluster",
                pattern: "3 stalls in maker",
              },
            ],
          },
        };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    await waitFor(() =>
      expect(screen.getByText("Criteria miss")).toBeTruthy()
    );
    expect(screen.getByText("Stall cluster")).toBeTruthy();
    expect(screen.getByText('"button has color"')).toBeTruthy();
    expect(screen.getByText('"3 stalls in maker"')).toBeTruthy();
  });

  it("renders a generic empty state (not 'repeated patterns' specific)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: [] } };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    await waitFor(() =>
      expect(screen.getByText(/No patterns detected/)).toBeTruthy()
    );
    // Make sure the old "repeated" wording is gone.
    expect(screen.queryByText(/No repeated patterns/)).toBeNull();
  });

  it("Get recipe button fetches and renders the recipe text", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: SAMPLE_FINDINGS } };
      }
      if (url.includes("/api/improve-recipe")) {
        return {
          ok: true,
          body: SAMPLE_RECIPE,
          contentType: "text/markdown",
        };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    fireEvent.click(screen.getByText("Get recipe"));
    await waitFor(() =>
      expect(
        screen.getByDisplayValue(/Recursive Improve — Agent Prompt Patches/)
      ).toBeTruthy()
    );
  });

  it("Run as task button creates a new task and fires onTaskCreated", async () => {
    const onTaskCreated = vi.fn();
    const seenBodies: Array<Record<string, unknown>> = [];
    // Inline mock that records POST bodies — avoids the wrap-and-replace
    // indirection that confused tsc last time.
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (init?.method === "POST" && init.body) {
          seenBodies.push(JSON.parse(String(init.body)));
        }
        if (url.includes("/api/insights")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ findings: SAMPLE_FINDINGS }),
            text: async () => "",
            headers: { get: () => "application/json" },
          } as unknown as Response;
        }
        if (url.includes("/api/improve-recipe")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => SAMPLE_RECIPE,
            headers: { get: () => "text/markdown" },
          } as unknown as Response;
        }
        if (init?.method === "POST" && url.endsWith("/api/tasks")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "t_new_recipe" }),
            text: async () => "",
            headers: { get: () => "application/json" },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ tasks: [], snapshots: [] }),
          text: async () => "",
          headers: { get: () => "application/json" },
        } as unknown as Response;
      }
    );

    render(<ImprovePanel onTaskCreated={onTaskCreated} />);
    const input = screen.getByPlaceholderText(/path\/to\/project/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/tmp/recipe-workdir" } });
    fireEvent.click(screen.getByText("Get recipe"));
    await waitFor(() =>
      expect(screen.getByDisplayValue(/Recursive Improve/)).toBeTruthy()
    );
    fireEvent.click(screen.getByText("Run as task"));
    await waitFor(() =>
      expect(onTaskCreated).toHaveBeenCalledWith("t_new_recipe")
    );
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({
      workdir: "/tmp/recipe-workdir",
      autoApprovePlan: true,
    });
    expect((seenBodies[0] as { prompt: string }).prompt).toContain(
      "Recursive Improve"
    );
    expect(screen.getByText(/t_new_recipe/)).toBeTruthy();
  });

  it("Run as task button is disabled when workdir is empty", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: SAMPLE_FINDINGS } };
      }
      if (url.includes("/api/improve-recipe")) {
        return {
          ok: true,
          body: SAMPLE_RECIPE,
          contentType: "text/markdown",
        };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    fireEvent.click(screen.getByText("Get recipe"));
    await waitFor(() =>
      expect(screen.getByDisplayValue(/Recursive Improve/)).toBeTruthy()
    );
    const runBtn = screen.getByText("Run as task").closest("button") as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
  });

  it("Diff button fetches and renders file changes", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: [] } };
      }
      if (url.includes("/api/ratchet/snapshots")) {
        return { ok: true, body: { snapshots: SAMPLE_SNAPSHOTS } };
      }
      if (url.includes("/api/ratchet/diff")) {
        return {
          ok: true,
          body: {
            changes: [
              {
                path: "loop-planner.md",
                status: "modified",
                beforeBytes: 16,
                afterBytes: 30,
              },
              {
                path: "loop-maker.md",
                status: "unchanged",
                beforeBytes: 12,
                afterBytes: 12,
              },
            ],
          },
        };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    const input = screen.getByPlaceholderText(/path\/to\/project/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/tmp/diff-workdir" } });
    await waitFor(() =>
      expect(screen.getByText("2026-07-16T17-53-13Z-a3f2")).toBeTruthy()
    );
    fireEvent.click(screen.getByText("Diff"));
    await waitFor(() =>
      expect(screen.getByText(/loop-planner\.md/)).toBeTruthy()
    );
    // Modified file shows ~ label and byte counts.
    expect(screen.getByText(/~ modified/)).toBeTruthy();
    expect(screen.getByText(/16 → 30 bytes/)).toBeTruthy();
    // Unchanged files are summarized, not listed individually.
    expect(screen.getByText(/1 unchanged file/)).toBeTruthy();
  });

  it("Diff button shows 'no changes' when snapshot matches current", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: [] } };
      }
      if (url.includes("/api/ratchet/snapshots")) {
        return { ok: true, body: { snapshots: SAMPLE_SNAPSHOTS } };
      }
      if (url.includes("/api/ratchet/diff")) {
        return {
          ok: true,
          body: {
            changes: [
              { path: "loop-planner.md", status: "unchanged", beforeBytes: 10, afterBytes: 10 },
            ],
          },
        };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    const input = screen.getByPlaceholderText(/path\/to\/project/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/tmp/diff-workdir" } });
    await waitFor(() =>
      expect(screen.getByText("2026-07-16T17-53-13Z-a3f2")).toBeTruthy()
    );
    fireEvent.click(screen.getByText("Diff"));
    await waitFor(() =>
      expect(screen.getByText(/No changes — current prompts match/)).toBeTruthy()
    );
  });

  it("renders existing snapshots with a Revert button each", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/api/insights")) {
        return { ok: true, body: { findings: [] } };
      }
      if (url.includes("/api/ratchet/snapshots")) {
        return { ok: true, body: { snapshots: SAMPLE_SNAPSHOTS } };
      }
      return { ok: true, body: { tasks: [], snapshots: [] } };
    });
    render(<ImprovePanel />);
    const input = screen.getByPlaceholderText(/path\/to\/project/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/tmp/test-workdir" } });
    await waitFor(() =>
      expect(screen.getByText("2026-07-16T17-53-13Z-a3f2")).toBeTruthy()
    );
    expect(screen.getByText(/3 files/)).toBeTruthy();
    expect(screen.getByText("Revert")).toBeTruthy();
  });

  it("shows an error banner when insights fetch fails", async () => {
    globalThis.fetch = mockFetch(() => ({
      ok: false,
      body: { error: "down" },
    }));
    render(<ImprovePanel />);
    await waitFor(() =>
      expect(screen.getByText(/HTTP 500/)).toBeTruthy()
    );
  });
});
