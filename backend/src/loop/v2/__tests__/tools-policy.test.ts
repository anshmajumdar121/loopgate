import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createToolRegistry, type ToolContext } from "../tools/index.js";

const workdirs: string[] = [];

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkdir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "loop-v2-tool-policy-"));
  workdirs.push(path);
  return path;
}

function context(workdir: string, role: ToolContext["role"] = "maker"): ToolContext {
  return {
    workdir,
    role,
    runId: "run-tool-policy",
    plan: {
      criteria: [],
      filesToTouch: ["src/"],
      checks: [{ id: "ok", cmd: ["node", "check.mjs"], timeoutMs: 5_000 }],
    },
  };
}

describe("v2 tool policy boundaries", () => {
  it("blocks absolute, traversal, and escaping symlink reads", async () => {
    const root = await makeWorkdir();
    const outside = await makeWorkdir();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "ok.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    await symlink(outside, join(root, "src", "escape"), "junction");

    const registry = createToolRegistry(context(root, "verifier"));
    await expect(registry.invoke("read_file", { path: "../secret.ts" }, "path-1")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:path-escape" },
    });
    await expect(registry.invoke("list_dir", { path: "/tmp" }, "path-2")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:path-escape" },
    });
    await expect(registry.invoke("read_file", { path: "src/escape/secret.ts" }, "path-3")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:path-escape" },
    });
  });

  it("keeps writes maker-only and applies reserved, denylist, and plan policies", async () => {
    const root = await makeWorkdir();
    await mkdir(join(root, "src"));
    const maker = createToolRegistry(context(root, "maker"));
    const verifier = createToolRegistry(context(root, "verifier"));

    await expect(verifier.invoke("write_file", { path: "src/no.ts", content: "x" }, "role-1")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:tool-not-available" },
    });
    await expect(maker.invoke("write_file", { path: "STATE.md", content: "x" }, "write-1")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:reserved-file" },
    });
    await expect(maker.invoke("write_file", { path: ".env", content: "SECRET=x" }, "write-2")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:write" },
    });
    await expect(maker.invoke("write_file", { path: "other.ts", content: "x" }, "write-3")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:not-in-allowlist" },
    });
    await expect(maker.invoke("write_file", { path: "src/ok.ts", content: "x" }, "write-4")).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(root, "src", "ok.ts"), "utf8")).resolves.toBe("x");
  });

  it("caps bounded observations instead of returning whole large lines", async () => {
    const root = await makeWorkdir();
    const long = "x".repeat(100_000);
    await writeFile(join(root, "large.txt"), long, "utf8");
    await writeFile(join(root, "large.ts"), `export const needle = "${long}";\n`, "utf8");
    const registry = createToolRegistry(context(root, "verifier"));

    const read = await registry.invoke("read_file", { path: "large.txt" }, "cap-1");
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.value).length).toBeLessThan(70_000);

    const search = await registry.invoke("search", { pattern: "needle" }, "cap-2");
    expect(search.ok).toBe(true);
    if (search.ok) {
      const value = search.value as { matches?: Array<{ context?: string }> };
      expect(value.matches?.[0]?.context?.length).toBeLessThanOrEqual(1_024);
    }
  });

  it("only runs declared allowlisted checks and records CHECK_RESULT with the call id", async () => {
    const root = await makeWorkdir();
    await writeFile(join(root, "check.mjs"), "console.log('ok');\n", "utf8");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const maker = createToolRegistry({
      ...context(root, "maker"),
      eventLog: { appendEvent: (event) => events.push(event as typeof events[number]) },
    });
    await expect(maker.invoke("run_check", { id: "missing" }, "check-0")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy:check-not-declared" },
    });
    await expect(maker.invoke("run_check", { id: "ok" }, "check-1")).resolves.toMatchObject({
      ok: true,
      value: { id: "ok", passed: true },
    });
    expect(events.at(-1)).toMatchObject({
      type: "CHECK_RESULT",
      payload: { toolCallId: "check-1", toolName: "run_check", id: "ok" },
    });
  });
});
