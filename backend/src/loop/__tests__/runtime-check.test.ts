import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vitest runs each test file in its own worker; sibling test files (e.g.
// preview-server.test.ts) also bind the preview server. Port 0 lets the
// OS pick a free one — no env-var juggling. Env must be set BEFORE the
// dynamic import because preview-server.ts reads it at module load.
process.env.LOOP_PREVIEW_PORT = "0";
const { registerPreview, stopPreviewServer } = await import(
  "../preview-server.js"
);
const { runRuntimeCheck } = await import("../runtime-check.js");

describe("runtime-check", () => {
  afterAll(() => stopPreviewServer());

  it("captures a thrown script error and reports ok=false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-bad-"));
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html><title>bad</title><script>throw new Error("boom-at-load")</script>`,
      "utf8"
    );
    const url = await registerPreview("rt-bad", dir);
    const result = await runRuntimeCheck(url, dir, 1);
    expect(result.ok).toBe(false);
    expect(result.pageErrors.join("\n")).toContain("boom-at-load");
  }, 60_000);

  it("reports ok=true for a clean page and takes a screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-good-"));
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html><title>good</title><button id="b">Click</button><script>document.getElementById("b").addEventListener("click",()=>{document.title="clicked"})</script>`,
      "utf8"
    );
    const url = await registerPreview("rt-good", dir);
    const result = await runRuntimeCheck(url, dir, 1);
    expect(result.ok).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.screenshotPath).toBeTruthy();
    expect(result.interactionLog.length).toBeGreaterThan(0); // clicked the button
  }, 60_000);
});
