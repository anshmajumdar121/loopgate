// Regression: the module-load `opencode --version` probe used
// spawnSync(..., { shell: false }), which can't run the npm `.cmd` shim
// that `opencode` installs as on Windows — so every task silently ran
// MOCK agents. These tests put a fake `opencode` on PATH and re-import
// the module to exercise the probe for real.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

let shimDir: string;
let emptyDir: string;
const origPath = process.env.PATH;
const origAllowMock = process.env.LOOP_ALLOW_MOCK;

beforeAll(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "loop-opencode-shim-"));
  emptyDir = await mkdtemp(join(tmpdir(), "loop-opencode-empty-"));
  if (process.platform === "win32") {
    // Same shape npm generates for global bins.
    await writeFile(join(shimDir, "opencode.cmd"), "@echo off\r\necho 0.0.0-test\r\n", "utf8");
  } else {
    const p = join(shimDir, "opencode");
    await writeFile(p, "#!/bin/sh\necho 0.0.0-test\n", "utf8");
    await chmod(p, 0o755);
  }
});

afterEach(() => {
  process.env.PATH = origPath;
  delete process.env.LOOP_USE_LLM_BRIDGE;
  if (origAllowMock === undefined) delete process.env.LOOP_ALLOW_MOCK;
  else process.env.LOOP_ALLOW_MOCK = origAllowMock;
  vi.restoreAllMocks();
  vi.resetModules();
});

afterAll(async () => {
  await rm(shimDir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
});

async function loadFresh() {
  vi.resetModules();
  return import("../agent-spawner.js");
}

function mockWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter((c: unknown[]) =>
    String(c[0]).includes("CLI not found or not runnable")
  );
}

describe("OPENCODE_AVAILABLE probe", () => {
  it("detects an opencode shim on PATH (incl. .cmd shims on Windows)", async () => {
    process.env.PATH = shimDir + delimiter + (origPath ?? "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadFresh();
    expect(mod.isOpencodeAvailable()).toBe(true);
    expect(mockWarnings(warn)).toHaveLength(0);
  }, 20_000);

  it("warns loudly once when opencode is missing and the LLM bridge is disabled", async () => {
    process.env.PATH = emptyDir;
    process.env.LOOP_USE_LLM_BRIDGE = "0";
    delete process.env.LOOP_ALLOW_MOCK;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadFresh();
    expect(mod.isOpencodeAvailable()).toBe(false);
    expect(mockWarnings(warn)).toHaveLength(1);
  }, 20_000);

  it("stays quiet when the LLM bridge is on (default) — opencode is not needed", async () => {
    process.env.PATH = emptyDir;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadFresh();
    expect(mod.isOpencodeAvailable()).toBe(false);
    expect(mockWarnings(warn)).toHaveLength(0);
  }, 20_000);

  it("stays quiet about mock mode when LOOP_ALLOW_MOCK=1", async () => {
    process.env.PATH = emptyDir;
    process.env.LOOP_USE_LLM_BRIDGE = "0";
    process.env.LOOP_ALLOW_MOCK = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadFresh();
    expect(mod.isOpencodeAvailable()).toBe(false);
    expect(mockWarnings(warn)).toHaveLength(0);
  }, 20_000);
});
