// Tests for the HTML syntax gate (Task 2 of
// 2026-07-11-loop-resilience-and-real-build). Covers: valid HTML passes,
// unclosed non-omittable elements fail with line numbers, forgiving-parse
// quirks do NOT fail, truncated markup fails, non-HTML files unaffected.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHtmlSyntax, runValidation } from "../validation.js";

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-html-gate-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  await writeFile(join(workdir, name), content, "utf8");
  return name;
}

describe("checkHtmlSyntax", () => {
  it("passes well-formed HTML", async () => {
    const f = await write(
      "valid.html",
      `<!doctype html><html><head><title>t</title></head><body><div id="a"><span>hi</span></div></body></html>`
    );
    expect(await checkHtmlSyntax(workdir, f)).toEqual([]);
  });

  it("fails an unclosed <div> with a line number", async () => {
    const f = await write(
      "unclosed.html",
      `<!doctype html>\n<body>\n<div class="panel">\n<span>content</span>\n</body>`
    );
    const errs = await checkHtmlSyntax(workdir, f);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("unclosed <div>");
    expect(errs[0]).toContain("unclosed.html:3");
  });

  it("does NOT fail benign forgiving-parse quirks", async () => {
    const f = await write(
      "quirks.html",
      // no doctype, unquoted attr, implied </p>, implied </li>
      `<body><p>one<p>two<ul><li>a<li>b</ul><div data-x=unquoted></div></body>`
    );
    expect(await checkHtmlSyntax(workdir, f)).toEqual([]);
  });

  it("fails truncated markup (unterminated attribute)", async () => {
    const f = await write("truncated.html", `<body><div class="never-closed`);
    const errs = await checkHtmlSyntax(workdir, f);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/eof-/);
  });

  it("passes svg self-closing foreign content", async () => {
    const f = await write(
      "svg.html",
      `<!doctype html><body><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></body>`
    );
    expect(await checkHtmlSyntax(workdir, f)).toEqual([]);
  });

  it("returns empty for a missing file (gate-a territory)", async () => {
    expect(await checkHtmlSyntax(workdir, "does-not-exist.html")).toEqual([]);
  });
});

describe("runValidation with HTML files", () => {
  it("rejects broken HTML through the main gate", async () => {
    const f = await write(
      "gate-broken.html",
      `<!doctype html>\n<body>\n<section>\n<h1>title</h1>\n</body>`
    );
    const result = await runValidation(workdir, [
      { path: f, reason: "test" },
    ]);
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toContain("unclosed <section>");
  });

  it("still passes clean JS alongside clean HTML (JS path untouched)", async () => {
    const html = await write("gate-ok.html", `<!doctype html><body><div>x</div></body>`);
    const js = await write("gate-ok.js", `console.log("fine");\n`);
    const result = await runValidation(workdir, [
      { path: html, reason: "test" },
      { path: js, reason: "test" },
    ]);
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
