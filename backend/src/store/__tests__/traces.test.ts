import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTrace,
  readTracesForTask,
  traceFilePath,
  type TraceRecord,
} from "../traces.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-traces-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function sampleRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    taskId: "task_test_123",
    attempt: 1,
    role: "planner",
    model: "custom:conn_abc:z-ai/glm-5.2",
    upstreamModel: "z-ai/glm-5.2",
    connectionId: "conn_abc",
    connectionName: "GLM NIM",
    ts: "2026-07-16T18:00:00.000Z",
    durationMs: 12345,
    userPrompt: "Build a hello world button",
    outputFile: "/tmp/loop-traces-x/GOAL.md",
    response: "# Plan\n- step 1\n- step 2",
    promptTokens: 1024,
    completionTokens: 512,
    exitCode: 0,
    ...overrides,
  };
}

describe("traceFilePath", () => {
  it("lays files under <workdir>/.loop/traces/<taskId>/<attempt>-<role>.json", () => {
    const p = traceFilePath("/tmp/work", "task_abc", 3, "verifier");
    expect(p).toBe(join("/tmp/work", ".loop", "traces", "task_abc", "3-verifier.json"));
  });
});

describe("writeTrace + readTracesForTask", () => {
  it("round-trips a single record", async () => {
    const r = sampleRecord();
    await writeTrace(workdir, r);
    const got = await readTracesForTask(workdir, r.taskId);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(r);
  });

  it("returns records sorted by filename (attempt + role)", async () => {
    // Insert in shuffled order; read should be (1,planner) < (1,maker) < (1,verifier) < (2,maker).
    await writeTrace(workdir, sampleRecord({ role: "verifier", attempt: 1 }));
    await writeTrace(workdir, sampleRecord({ role: "maker", attempt: 2 }));
    await writeTrace(workdir, sampleRecord({ role: "planner", attempt: 1 }));
    await writeTrace(workdir, sampleRecord({ role: "maker", attempt: 1 }));
    const got = await readTracesForTask(workdir, "task_test_123");
    expect(got.map((r) => `${r.attempt}-${r.role}`)).toEqual([
      "1-planner",
      "1-maker",
      "1-verifier",
      "2-maker",
    ]);
  });

  it("returns [] for unknown taskId", async () => {
    const got = await readTracesForTask(workdir, "no_such_task");
    expect(got).toEqual([]);
  });

  it("survives a partially-written (truncated) file without throwing", async () => {
    await writeTrace(workdir, sampleRecord({ role: "maker", attempt: 1 }));
    // Truncate the file mid-write to simulate a crash.
    const path = traceFilePath(workdir, "task_test_123", 1, "maker");
    await writeFile(path, '{"taskId":"task_te'); // unterminated JSON
    const got = await readTracesForTask(workdir, "task_test_123");
    // Malformed file is skipped, not propagated.
    expect(got).toEqual([]);
  });

  it("creates the trace dir tree when workdir is fresh", async () => {
    // No prior mkdir at all — writeTrace must create .loop/traces/<taskId>/.
    const r = sampleRecord({ taskId: "fresh_task" });
    await writeTrace(workdir, r);
    const got = await readTracesForTask(workdir, "fresh_task");
    expect(got).toHaveLength(1);
  });
});
