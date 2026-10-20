// Tests for the build/test execution step (Task 3 of
// 2026-07-11-loop-resilience-and-real-build). Covers: static workdirs
// skip everything, package.json triggers detection, failing build feeds
// the output tail, passing build populates real exit codes, install
// skipped when node_modules present + package.json unchanged, and env
// scrubbing. Uses `node` one-liners as build/test scripts so no real
// npm dependency resolution happens (fast + hermetic).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBuildStep,
  resetBuildRunnerCache,
  scrubbedEnv,
  __setStageTimeoutsForTests,
} from "../build-runner.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-build-runner-"));
  resetBuildRunnerCache();
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** Write a package.json with the given scripts + a primed node_modules
 *  dir so the install stage is skipped (keeps tests fast/hermetic). */
async function primeProject(scripts: Record<string, string>): Promise<void> {
  await writeFile(
    join(workdir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", scripts }),
    "utf8"
  );
  await mkdir(join(workdir, "node_modules"), { recursive: true });
}

describe("runBuildStep", () => {
  it("returns undefined for a static workdir (no package.json)", async () => {
    expect(await runBuildStep(workdir)).toBeUndefined();
  });

  it("runs the build script and reports a real exit 0", async () => {
    await primeProject({ build: "node -e \"process.exit(0)\"" });
    const result = await runBuildStep(workdir);
    expect(result).toBeDefined();
    expect(result!.buildExit).toBe(0);
    expect(result!.failedStage).toBeUndefined();
  });

  it("reports a failing build with the output tail", async () => {
    await primeProject({
      build: "node -e \"console.error('BOOM: missing module xyz'); process.exit(1)\"",
    });
    const result = await runBuildStep(workdir);
    expect(result!.failedStage).toBe("build");
    expect(result!.buildExit).toBe(1);
    expect(result!.outputTail).toContain("BOOM: missing module xyz");
  });

  it("runs the test script after a passing build and reports its exit", async () => {
    await primeProject({
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
    });
    const result = await runBuildStep(workdir);
    expect(result!.buildExit).toBe(0);
    expect(result!.testExit).toBe(0);
    expect(result!.failedStage).toBeUndefined();
  });

  it("flags a failing test stage", async () => {
    await primeProject({
      build: "node -e \"process.exit(0)\"",
      test: "node -e \"console.error('2 tests failed'); process.exit(1)\"",
    });
    const result = await runBuildStep(workdir);
    expect(result!.failedStage).toBe("test");
    expect(result!.outputTail).toContain("2 tests failed");
  });

  it("skips install when node_modules exists and package.json is unchanged", async () => {
    await primeProject({ build: "node -e \"process.exit(0)\"" });
    const logs: string[] = [];
    await runBuildStep(workdir, (l) => logs.push(l));
    await runBuildStep(workdir, (l) => logs.push(l));
    const skips = logs.filter((l) => l.includes("install skipped"));
    expect(skips.length).toBe(2); // node_modules primed → both runs skip
  });

  it("scrubs secrets from the child env", async () => {
    process.env.LOOP_TEST_FAKE_SECRET = "sk-should-not-leak";
    try {
      await primeProject({
        // exits 1 (build failure) iff the secret leaked into the child env
        build: "node -e \"process.exit(process.env.LOOP_TEST_FAKE_SECRET ? 1 : 0)\"",
      });
      const result = await runBuildStep(workdir);
      expect(result!.buildExit).toBe(0);
      expect(result!.failedStage).toBeUndefined();
    } finally {
      delete process.env.LOOP_TEST_FAKE_SECRET;
    }
  });

  it("treats invalid package.json as an install-stage failure", async () => {
    await writeFile(join(workdir, "package.json"), "{ not json", "utf8");
    const result = await runBuildStep(workdir);
    expect(result!.failedStage).toBe("install");
    expect(result!.outputTail).toContain("not valid JSON");
  });

  it("detects built output in dist/ after a passing build", async () => {
    await primeProject({
      build:
        "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<!doctype html><body>ok</body>')\"",
    });
    const result = await runBuildStep(workdir);
    expect(result!.buildExit).toBe(0);
    expect(result!.outputDir).toBe(join(workdir, "dist"));
  });

  // Regression: spawn("npm") without a shell is ENOENT on Windows (npm is
  // a .cmd shim), so every project-shaped task reported exit 127.
  it("does not fail to spawn npm (exit 127) on any platform", async () => {
    await primeProject({ build: "node -e \"process.exit(0)\"" });
    const result = await runBuildStep(workdir);
    expect(result!.outputTail ?? "").not.toContain("failed to spawn npm");
    expect(result!.buildExit).toBe(0);
  });

  it("kills the whole process tree when a stage times out", async () => {
    // build → npm → (cmd|sh) → node spawner.cjs → node grandchild. Without
    // a tree kill the grandchild survives and holds the pipes open.
    await writeFile(
      join(workdir, "spawner.cjs"),
      [
        "const { spawn } = require('child_process');",
        "const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });",
        "require('fs').writeFileSync('grandchild.pid', String(c.pid));",
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
      "utf8"
    );
    await primeProject({ build: "node spawner.cjs" });
    __setStageTimeoutsForTests({ scriptMs: 6000 });
    try {
      const started = Date.now();
      const result = await runBuildStep(workdir);
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(result!.failedStage).toBe("build");
      expect(result!.outputTail).toContain("timed out");
      const pid = Number(await readFile(join(workdir, "grandchild.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      // Give the OS a moment to reap, then the grandchild must be gone.
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 250));
        } catch {
          alive = false;
        }
      }
      if (alive) process.kill(pid, "SIGKILL"); // don't leak it on failure
      expect(alive).toBe(false);
    } finally {
      __setStageTimeoutsForTests(null);
    }
  }, 40_000);
});

describe("scrubbedEnv", () => {
  const source: NodeJS.ProcessEnv = {
    Path: "C:/Windows/system32",
    SystemRoot: "C:/Windows",
    ComSpec: "C:/Windows/system32/cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    APPDATA: "C:/Users/u/AppData/Roaming",
    LOCALAPPDATA: "C:/Users/u/AppData/Local",
    USERPROFILE: "C:/Users/u",
    TEMP: "C:/Temp",
    TMP: "C:/Temp",
    OPENAI_API_KEY: "sk-secret",
    LOOP_CONNECTION_TOKEN: "tok",
  };

  it("keeps Windows essentials (case-insensitive) and drops secrets on win32", () => {
    const env = scrubbedEnv(source, "win32");
    for (const k of [
      "Path",
      "SystemRoot",
      "ComSpec",
      "PATHEXT",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "TEMP",
      "TMP",
    ]) {
      expect(env[k]).toBe(source[k]);
    }
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LOOP_CONNECTION_TOKEN).toBeUndefined();
  });

  it("does not add Windows vars on POSIX", () => {
    const env = scrubbedEnv({ ...source, PATH: "/usr/bin" }, "linux");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SystemRoot).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
