// Tests for the build/test execution step (Task 3 of
// 2026-07-11-loop-resilience-and-real-build). Covers: static workdirs
// skip everything, package.json triggers detection, failing build feeds
// the output tail, passing build populates real exit codes, install
// skipped when node_modules present + package.json unchanged, and env
// scrubbing. Uses `node` one-liners as build/test scripts so no real
// npm dependency resolution happens (fast + hermetic).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuildStep, resetBuildRunnerCache } from "../build-runner.js";

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
});
