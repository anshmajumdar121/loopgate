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
    process.env.LOOP_MAVIS_SESSION_RETRY_DELAY_MS = "20";
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.LOOP_MAVIS_BIN;
    delete process.env.MAVIS_SHIM_STATE_DIR;
    delete process.env.LOOP_MAVIS_POLL_INTERVAL_MS;
    delete process.env.MAVIS_SHIM_MODE;
    delete process.env.MAVIS_SHIM_AGENT_EXISTS;
    delete process.env.MAVIS_SHIM_SESSION_NEW_FAILS;
    delete process.env.LOOP_MAVIS_SESSION_RETRY_DELAY_MS;
  });

  function invocations(): string[] {
    const log = join(stateDir, "invocations.log");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }

  it("creates the role agent with the system prompt when it does not exist", async () => {
    process.env.MAVIS_SHIM_MODE = "success";
    const handle = spawnMavisBridge(
      "planner",
      "task-4",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      () => {},
      () => {},
      () => {}
    );
    await handle.exited;
    const calls = invocations();
    expect(calls.some((c) => c.startsWith("agent new loop-planner"))).toBe(true);
    expect(calls.some((c) => c.startsWith("agent update"))).toBe(false);
  });

  it("refreshes the system prompt of an already-registered agent", async () => {
    // Live bug: loop-* agents created in an earlier run keep their original
    // (possibly contract-less) system prompt forever, because ensureAgent
    // skipped existing agents entirely. The bridge must push the current
    // prompt via `agent update` instead.
    process.env.MAVIS_SHIM_MODE = "success";
    process.env.MAVIS_SHIM_AGENT_EXISTS = "loop-planner";
    const handle = spawnMavisBridge(
      "planner",
      "task-5",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a fresh planner prompt.",
      () => {},
      () => {},
      () => {}
    );
    await handle.exited;
    const calls = invocations();
    expect(calls.some((c) => c.startsWith("agent new"))).toBe(false);
    const update = calls.find((c) => c.startsWith("agent update loop-planner"));
    expect(update).toBeDefined();
    expect(update).toContain("You are a fresh planner prompt.");
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

  it("retries session creation past transient daemon-busy timeouts", async () => {
    // Live failure: the daemon serves the user's own interactive session
    // too, and under load `session new` exceeds the CLI's HTTP timeout.
    // One transient timeout must not kill a whole loop attempt.
    process.env.MAVIS_SHIM_MODE = "success";
    process.env.MAVIS_SHIM_SESSION_NEW_FAILS = "2";
    process.env.LOOP_MAVIS_SESSION_RETRY_DELAY_MS = "20";
    const stderrLines: string[] = [];
    let exitCode: number | null | undefined;

    const handle = spawnMavisBridge(
      "planner",
      "task-6",
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
    expect(exitCode).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe("PONG");
    expect(stderrLines.some((l) => l.includes("retrying"))).toBe(true);
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
