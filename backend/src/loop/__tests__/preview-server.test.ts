import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vitest runs each test file in its own worker; sibling test files (e.g.
// runtime-check.test.ts) also bind the preview server. Set port 0 so the
// OS picks a free one — no env-var juggling between files. Env must be
// set BEFORE the dynamic import because preview-server.ts reads it at
// module load.
process.env.LOOP_PREVIEW_PORT = "0";
const { registerPreview, stopPreviewServer } = await import(
  "../preview-server.js"
);

describe("preview-server", () => {
  afterAll(() => stopPreviewServer());

  it("serves a registered workdir's index.html at /t/<taskId>/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview-"));
    await writeFile(join(dir, "index.html"), "<h1>hello preview</h1>", "utf8");
    const url = await registerPreview("task123", dir);
    expect(url).toMatch(/^http:\/\/localhost:\d+\/t\/task123\/$/);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello preview");
  });

  it("blocks path traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview2-"));
    await writeFile(join(dir, "index.html"), "x", "utf8");
    const url = await registerPreview("task456", dir);
    const res = await fetch(url + "..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(404);
  });

  it("404s unknown task ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview3-"));
    const base = (await registerPreview("known", dir)).replace("/t/known/", "");
    const res = await fetch(`${base}/t/unknown/index.html`);
    expect(res.status).toBe(404);
  });
});
