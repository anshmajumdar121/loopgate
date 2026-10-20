import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, type ProcessRunResult } from "../process-runner.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "loop-v2-process-"));
  tempDirectories.push(directory);
  return directory;
}

function nodeScript(script: string): { executable: string; args: string[] } {
  return {
    executable: process.execPath,
    args: ["-e", script],
  };
}

describe("runProcess", () => {
  it("runs an executable with structured arguments and invokes the cwd hook", async () => {
    const cwd = await makeTempDirectory();
    const validateCwd = vi.fn();
    const spec = nodeScript(
      "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(1)}))"
    );

    const result = await runProcess({
      ...spec,
      args: [...spec.args, "a value with spaces", "--literal=$HOME"],
      cwd,
      validateCwd,
    });

    expect(validateCwd).toHaveBeenCalledWith(cwd);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd,
      args: ["a value with spaces", "--literal=$HOME"],
    });
  });

  it("does not spawn when the cwd containment hook rejects", async () => {
    const cwd = await makeTempDirectory();
    const validateCwd = vi.fn(() => {
      throw new Error("cwd escaped worktree");
    });

    await expect(
      runProcess({
        ...nodeScript("process.exit(0)"),
        cwd,
        validateCwd,
      })
    ).rejects.toThrow("cwd escaped worktree");
    expect(validateCwd).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded stdout and stderr tails while returning the exit code", async () => {
    const cwd = await makeTempDirectory();
    const result = await runProcess({
      ...nodeScript(
        "process.stdout.write('out-'.repeat(100)); process.stderr.write('err-'.repeat(100)); process.exit(7)"
      ),
      cwd,
      stdoutTailBytes: 19,
      stderrTailBytes: 19,
    });

    expect(result.exitCode).toBe(7);
    expect(result.stdout.length).toBeLessThanOrEqual(19);
    expect(result.stderr.length).toBeLessThanOrEqual(19);
    expect(result.stdout).toContain("out-");
    expect(result.stderr).toContain("err-");
    expect(result.failed).toBe(true);
  });

  it("uses execa timeout cancellation and reports a deterministic bounded result", async () => {
    const cwd = await makeTempDirectory();
    const started = Date.now();
    const result = await runProcess({
      ...nodeScript("setInterval(() => process.stdout.write('tick\\n'), 5_000)"),
      cwd,
      timeoutMs: 60,
      forceKillAfterDelayMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cancels an in-flight process from an AbortSignal", async () => {
    const cwd = await makeTempDirectory();
    const controller = new AbortController();
    const promise = runProcess({
      ...nodeScript("setInterval(() => {}, 5_000)"),
      cwd,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(new Error("test cancellation")), 40);
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("terminates a spawned grandchild with the process tree", async () => {
    const cwd = await makeTempDirectory();
    const grandchildPidFile = join(cwd, "grandchild.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));`,
      "setInterval(() => {}, 60000);",
    ].join("\n");

    const result = await runProcess({
      ...nodeScript(script),
      cwd,
      timeoutMs: 100,
      forceKillAfterDelayMs: 50,
    });

    expect(result.timedOut).toBe(true);
    const pid = Number(await readFile(grandchildPidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);

    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may have exited between the liveness probe and cleanup.
      }
    }
    expect(alive).toBe(false);
  }, 10_000);
});

describe("ProcessRunResult shape", () => {
  it("can be consumed without relying on Execa's error object", () => {
    const result: ProcessRunResult = {
      executable: "node",
      args: ["-e", ""],
      cwd: process.cwd(),
      exitCode: 0,
      signal: undefined,
      stdout: "",
      stderr: "",
      stdoutTail: "",
      stderrTail: "",
      durationMs: 1,
      failed: false,
      timedOut: false,
      cancelled: false,
      isCanceled: false,
    };

    expect(result.failed).toBe(false);
  });
});
