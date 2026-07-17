// Trace records for every agent invocation. Written from agent-spawner.ts
// on process exit, read by the recursive-improve pattern detector (Phase 2).
//
// Layout: one JSON file per (taskId, attempt, role) at
//   <workdir>/.loop/traces/<taskId>/<attempt>-<role>.json
//
// Writes are best-effort. A trace write failure must NEVER crash the
// spawner or the orchestrator — the caller wraps the call in try/catch.
//
// ponytail: no rotation here. 200 tasks × 3 phases × ~50KB = ~30MB on disk,
// not a crisis for months. Add a cron when disk usage actually matters.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type TraceRole = "planner" | "maker" | "verifier";

export interface TraceRecord {
  taskId: string;
  attempt: number;
  role: TraceRole;
  model: string | null;
  upstreamModel: string | null;
  connectionId: string | null;
  connectionName: string | null;
  /** ISO 8601 timestamp of process spawn. */
  ts: string;
  /** Wall-clock duration from spawn to exit, in ms. */
  durationMs: number;
  /** The user prompt the LLM received (LOOP_USER_PROMPT env). */
  userPrompt: string;
  /** File the agent wrote its response to (GOAL.md / index.html / STATE.md),
   *  read back at exit so it matches what the orchestrator's watcher saw. */
  outputFile: string;
  /** Content of outputFile at exit — the LLM's reply verbatim. */
  response: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Subprocess exit code. null if killed by signal or never spawned. */
  exitCode: number | null;
}

export function traceFilePath(
  workdir: string,
  taskId: string,
  attempt: number,
  role: TraceRole
): string {
  return join(
    resolve(workdir),
    ".loop",
    "traces",
    taskId,
    `${attempt}-${role}.json`
  );
}

export async function writeTrace(
  workdir: string,
  record: TraceRecord
): Promise<void> {
  const path = traceFilePath(workdir, record.taskId, record.attempt, record.role);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), "utf8");
}

export async function readTracesForTask(
  workdir: string,
  taskId: string
): Promise<TraceRecord[]> {
  const dir = join(resolve(workdir), ".loop", "traces", taskId);
  const files = (await readdir(dir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json")
  );
  const records: TraceRecord[] = [];
  for (const f of files) {
    try {
      const content = await readFile(join(dir, f), "utf8");
      records.push(JSON.parse(content) as TraceRecord);
    } catch {
      // Skip malformed files — a partial write shouldn't break reads.
    }
  }
  // ponytail: lex sort on filenames gives maker<planner<verifier (m<p<v),
  // not the chronological order the UI wants. Sort by (attempt, role
  // order) explicitly so the orchestrator phase order is preserved.
  const roleOrder: Record<TraceRole, number> = {
    planner: 0,
    maker: 1,
    verifier: 2,
  };
  records.sort((a, b) => {
    if (a.attempt !== b.attempt) return a.attempt - b.attempt;
    return roleOrder[a.role] - roleOrder[b.role];
  });
  return records;
}
