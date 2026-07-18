import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMavisBridge } from "../mavis-bridge.js";

const SHIM = join(__dirname, "fixtures", "mavis-shim.sh");

describe("spawnMavisBridge", () => {
  let workdir: string;
  let stateDir: string;
  let outFile: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "mavis-bridge-test-"));
    stateDir = mkdtempSync(join(tmpdir(), "mavis-shim-state-"));
    outFile = join(workdir, "GOAL.md");
    process.env.LOOP_MAVIS_BIN = SHIM;
    process.env.MAVIS_SHIM_STATE_DIR = stateDir;
    process.env.LOOP_MAVIS_POLL_INTERVAL_MS = "20";
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.LOOP_MAVIS_BIN;
    delete process.env.MAVIS_SHIM_STATE_DIR;
    delete process.env.LOOP_MAVIS_POLL_INTERVAL_MS;
    delete process.env.MAVIS_SHIM_MODE;
  });

  it("polls until the assistant replies, writes outFile, emits usage", async () => {
    process.env.MAVIS_SHIM_MODE = "success";
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let exitCode: number | null | undefined;

    const handle = spawnMavisBridge(
      "planner",
      "task-1",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      (l) => stdoutLines.push(l),
      (l) => stderrLines.push(l),
      (c) => {
        exitCode = c;
      }
    );

    await handle.exited;

    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, "utf8")).toBe("PONG");
    expect(stderrLines.some((l) => l.includes("__LOOP_USAGE__"))).toBe(true);
    const usageLine = stderrLines.find((l) => l.includes("__LOOP_USAGE__"))!;
    const json = usageLine.slice(
      usageLine.indexOf("__LOOP_USAGE__:") + "__LOOP_USAGE__:".length,
      usageLine.indexOf("__END__")
    );
    const usage = JSON.parse(json) as { completionTokens: number; promptTokens: number };
    expect(usage.completionTokens).toBe(42);
    expect(usage.promptTokens).toBe(0);
  });

  it("does not advance lastActivityAt once only the user message exists, and kill() stops polling", async () => {
    process.env.MAVIS_SHIM_MODE = "stall";
    let exitCode: number | null | undefined = "not-called" as unknown as number;

    const handle = spawnMavisBridge(
      "planner",
      "task-2",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      () => {},
      () => {},
      (c) => {
        exitCode = c;
      }
    );

    const firstActivity = handle.lastActivityAt;
    await new Promise((r) => setTimeout(r, 100)); // several poll cycles at 20ms
    const laterActivity = handle.lastActivityAt;
    expect(laterActivity).toBe(firstActivity); // user-only message count never grows

    handle.kill();
    await handle.exited;
    expect(exitCode).toBeNull();
    expect(existsSync(outFile)).toBe(false);
  });

  it("fails fast when the Mavis daemon is not running", async () => {
    process.env.MAVIS_SHIM_MODE = "daemon-down";
    let exitCode: number | null | undefined = "not-called" as unknown as number;
    const stderrLines: string[] = [];

    const handle = spawnMavisBridge(
      "planner",
      "task-3",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      () => {},
      (l) => stderrLines.push(l),
      (c) => {
        exitCode = c;
      }
    );

    await handle.exited;
    expect(exitCode).toBe(1);
    expect(stderrLines.some((l) => l.includes("session new failed"))).toBe(true);
  });
});
