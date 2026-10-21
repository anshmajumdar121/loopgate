import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createToolRegistry,
  applyUnifiedDiff,
  checkWritePolicy,
  collectSearchMatches,
  formatLineWindow,
  isContainedRelativePath,
  repoMap,
  resolveContainedPath,
} from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loop-v2-tools-"));
  dirs.push(dir);
  return dir;
}

function context(root: string, role: ToolContext["role"] = "maker"): ToolContext {
  return {
    workdir: root,
    role,
    runId: "run-tools",
    itemId: "item-tools",
    plan: {
      criteria: [],
      filesToTouch: ["src/", "package.json"],
      checks: [{ id: "unit", cmd: ["node", "check.mjs"], timeoutMs: 5_000 }],
    },
  };
}

describe("v2 tool layer", () => {
  it("rejects unsafe paths and symlink escapes", async () => {
    const root = await workdir();
    await mkdir(join(root, "src"));
    const outside = await mkdtemp(join(tmpdir(), "loop-v2-outside-"));
    dirs.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "src", "escape"), "junction");

    expect(isContainedRelativePath("../x")).toBe(false);
    expect(isContainedRelativePath("C:\\x")).toBe(false);
    expect(isContainedRelativePath("src/\0x")).toBe(false);
    await expect(resolveContainedPath(root, "src/escape/secret.txt", "read")).rejects.toMatchObject({ code: "policy:path-escape" });
    expect((await resolveContainedPath(root, "src/new.ts", "write")).relative).toBe("src/new.ts");
  });

  it("formats bounded line windows and search matches", () => {
    const source = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join("\n");
    const window = formatLineWindow(source, 3, 300);
    expect(window.lines[0]).toBe("3: line 3");
    expect(window.lines).toHaveLength(200);
    expect(window.truncated).toBe(true);
    expect(collectSearchMatches([{ path: "a.ts", content: "one\nneedle here\nthree" }], /needle/)).toEqual([
      { path: "a.ts", line: 2, context: "2: needle here" },
    ]);
  });

  it("builds a capped repo map from exported symbols", () => {
    const map = repoMap([{ path: "src/a.ts", content: "export function hello() {}\nexport const answer = 42;" }]);
    expect(map.files[0]).toEqual({ path: "src/a.ts", symbols: ["function hello", "const answer"] });
  });

  it("fails closed for reserved and non-allowlisted writes", () => {
    expect(checkWritePolicy("STATE.md", ["src/"])).toMatchObject({ code: expect.stringMatching(/^policy:/) });
    expect(checkWritePolicy("src/app.ts", [], { allowlistRequired: true })).toMatchObject({ code: expect.stringMatching(/^policy:/) });
    expect(checkWritePolicy("src/app.ts", ["src/"])).toBeUndefined();
    expect(checkWritePolicy(".env", [".env"])).toMatchObject({ code: "policy:write" });
  });

  it("applies a single-file unified diff", () => {
    expect(applyUnifiedDiff("one\ntwo\n", "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n")).toEqual({
      content: "one\nchanged\n",
      changedLines: 1,
    });
  });

  it("registers role-limited tools and records bounded observations", async () => {
    const root = await workdir();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const x = 1;", "utf8");
    const events: unknown[] = [];
    const verifier = createToolRegistry({ ...context(root, "verifier"), eventLog: { appendEvent: (e) => events.push(e) } });
    expect(verifier.has("write_file")).toBe(false);
    const result = await verifier.invoke("read_file", { path: "src/a.ts", startLine: 1, endLine: 5 }, "call-1");
    expect(result.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("secret");
  });

  it("exercises list_dir, search, repo_map, and verifier role boundaries", async () => {
    const root = await workdir();
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".loop"));
    await writeFile(join(root, "src", "a.ts"), "export const needle = 1;", "utf8");
    const planner = createToolRegistry(context(root, "planner"));
    const listed = await planner.invoke("list_dir", { path: ".", depth: 2 }, "list-1");
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.value)).toContain("src/a.ts");
    expect(JSON.stringify(listed.value)).not.toContain(".loop");
    const searched = await planner.invoke("search", { pattern: "needle", glob: "**/*.ts" }, "search-1");
    expect(searched.ok).toBe(true);
    expect(JSON.stringify(searched.value)).toContain("src/a.ts");
    const mapped = await planner.invoke("repo_map", {}, "map-1");
    expect(mapped.ok).toBe(true);
    expect(JSON.stringify(mapped.value)).toContain("const needle");
    const denied = await planner.invoke("run_check", { id: "unit" }, "check-denied");
    expect(denied).toMatchObject({ ok: false, error: { code: "policy:tool-not-available" } });
  });

  it("returns bounded read and regex errors", async () => {
    const root = await workdir();
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const verifier = createToolRegistry(context(root, "verifier"));
    const binary = await verifier.invoke("read_file", { path: "binary.bin" }, "read-binary");
    expect(binary).toMatchObject({ ok: false, error: { code: "policy:binary-file" } });
    const invalid = await verifier.invoke("search", { pattern: "[" }, "search-invalid");
    expect(invalid).toMatchObject({ ok: false, error: { code: "tool:invalid-regex" } });
  });

  it("writes through policy and runs only a declared check", async () => {
    const root = await workdir();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "check.mjs"), "process.exit(0);", "utf8");
    const maker = createToolRegistry(context(root));
    const written = await maker.invoke("write_file", { path: "src/new.ts", content: "export const ok = true;" }, "write-1");
    expect(written.ok).toBe(true);
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toContain("ok");
    const check = await maker.invoke("run_check", { id: "unit" }, "check-1");
    expect(check.ok).toBe(true);
    const denied = await maker.invoke("run_check", { id: "missing" }, "check-2");
    expect(denied).toMatchObject({ ok: false, error: { code: "policy:check-not-declared" } });
    const patched = await maker.invoke("apply_patch", {
      path: "src/new.ts",
      unifiedDiff: "@@ -1,1 +1,1 @@\n-export const ok = true;\n+export const ok = false;\n",
    }, "patch-1");
    expect(patched.ok).toBe(true);
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toContain("false");
  });
});
