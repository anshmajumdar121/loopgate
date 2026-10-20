import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

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

  // Regression: the traversal guard compared against `workdir + "/"`,
  // so on Windows (backslash paths) every file under a workdir 404'd.
  it("serves nested files under the workdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview4-"));
    await mkdir(join(dir, "assets", "js"), { recursive: true });
    await writeFile(join(dir, "assets", "js", "app.js"), "console.log('nested')", "utf8");
    await writeFile(join(dir, "style.css"), "body{}", "utf8");
    const url = await registerPreview("nested", dir);
    const js = await fetch(url + "assets/js/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("nested");
    const css = await fetch(url + "style.css");
    expect(css.status).toBe(200);
  });

  it("blocks backslash-encoded traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview5-"));
    await writeFile(join(dir, "index.html"), "x", "utf8");
    const url = await registerPreview("bslash", dir);
    const res = await fetch(url + "..%5C..%5Csecret.txt");
    expect(res.status).toBe(404);
  });

  it("returns 400 (not a crash) for malformed percent-encoding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview6-"));
    await writeFile(join(dir, "index.html"), "ok", "utf8");
    const url = await registerPreview("badenc", dir);
    const res = await fetch(url + "%E0%A4%A");
    expect(res.status).toBe(400);
    // Server still alive afterwards.
    const again = await fetch(url);
    expect(again.status).toBe(200);
  });

  it("listens on loopback only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview7-"));
    await writeFile(join(dir, "index.html"), "ok", "utf8");
    const url = await registerPreview("loopback", dir);
    const port = Number(new URL(url).port);
    const viaLoopback = await fetch(`http://127.0.0.1:${port}/t/loopback/`);
    expect(viaLoopback.status).toBe(200);
    // If the machine has a non-loopback IPv4, connecting through it must fail.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!external) return;
    const reachable = await new Promise<boolean>((resolveP) => {
      const sock = connect({ host: external.address, port });
      sock.setTimeout(2000);
      sock.once("connect", () => {
        sock.destroy();
        resolveP(true);
      });
      sock.once("error", () => resolveP(false));
      sock.once("timeout", () => {
        sock.destroy();
        resolveP(false);
      });
    });
    expect(reachable).toBe(false);
  });
});
