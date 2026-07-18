import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RuntimeCheckPanel } from "./RuntimeCheckPanel.js";

describe("RuntimeCheckPanel", () => {
  it("renders nothing when previewUrl and runtimeCheck are undefined", () => {
    const { container } = render(<RuntimeCheckPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when runtimeCheck is missing", () => {
    const { container } = render(
      <RuntimeCheckPanel previewUrl="http://x/t1/" runtimeCheck={undefined} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when previewUrl is missing", () => {
    const { container } = render(
      <RuntimeCheckPanel
        previewUrl={undefined}
        runtimeCheck={{ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: null }}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders pass badge when ok=true", () => {
    render(
      <RuntimeCheckPanel
        previewUrl="http://x/t1/"
        runtimeCheck={{ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: null }}
      />
    );
    expect(screen.getByText(/Runtime check passed/i)).toBeTruthy();
  });

  it("renders fail badge + error counts when ok=false", () => {
    render(
      <RuntimeCheckPanel
        previewUrl="http://x/t1/"
        runtimeCheck={{ attempt: 2, ok: false, pageErrorCount: 3, consoleErrorCount: 1, screenshotRelPath: null }}
      />
    );
    expect(screen.getByText(/Runtime check found errors/i)).toBeTruthy();
    expect(screen.getByText(/3 page errors/i)).toBeTruthy();
    expect(screen.getByText(/1 console error/i)).toBeTruthy();
  });

  it("composes screenshot URL from previewUrl + relPath", () => {
    render(
      <RuntimeCheckPanel
        previewUrl="http://x/t1/"
        runtimeCheck={{ attempt: 1, ok: true, pageErrorCount: 0, consoleErrorCount: 0, screenshotRelPath: ".loop/foo.png" }}
      />
    );
    const img = screen.getByAltText(/screenshot/i) as HTMLImageElement;
    expect(img.src).toBe("http://x/t1/.loop/foo.png");
  });
});
