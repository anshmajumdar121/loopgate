import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RuntimeCheckPanel } from "./RuntimeCheckPanel.js";
import type { Task } from "@/types/loop";

// Minimal stand-in — RuntimeCheckPanel only reads .previewUrl + .runtimeCheck
// off the task. The rest of Task is noise for these tests.
function mkTask(rc: Task["runtimeCheck"], previewUrl: string | null = "http://x/t1/"): Task {
  return {
    id: "t1",
    status: "done",
    prompt: "",
    title: "",
    workdir: "/tmp",
    history: [],
    logs: [],
    previewUrl: previewUrl ?? undefined,
    runtimeCheck: rc,
  } as unknown as Task;
}

describe("RuntimeCheckPanel", () => {
  it("renders nothing when task is undefined", () => {
    const { container } = render(<RuntimeCheckPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when runtimeCheck is missing", () => {
    const { container } = render(<RuntimeCheckPanel task={mkTask(undefined)} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when previewUrl is missing", () => {
    const { container } = render(
      <RuntimeCheckPanel task={mkTask({ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: null }, null)} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders pass badge when ok=true", () => {
    render(<RuntimeCheckPanel task={mkTask({ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: null })} />);
    expect(screen.getByText(/Runtime check passed/i)).toBeTruthy();
  });

  it("renders fail badge + error counts when ok=false", () => {
    render(
      <RuntimeCheckPanel
        task={mkTask({ attempt: 2, ok: false, pageErrorCount: 3, consoleErrorCount: 1, screenshotRelPath: null })}
      />
    );
    expect(screen.getByText(/Runtime check found errors/i)).toBeTruthy();
    expect(screen.getByText(/3 page errors/i)).toBeTruthy();
    expect(screen.getByText(/1 console error/i)).toBeTruthy();
  });

  it("composes screenshot URL from previewUrl + relPath", () => {
    render(
      <RuntimeCheckPanel
        task={mkTask({ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: ".loop/foo.png" }, "http://x/t1/")}
      />
    );
    const img = screen.getByAltText(/screenshot/i) as HTMLImageElement;
    expect(img.src).toBe("http://x/t1/.loop/foo.png");
  });
});
