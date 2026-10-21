import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import type { PlanSchema } from "./schemas.js";
import { isDefenceDisabled } from "./defence-flags.js";

export interface CheckEventSink {
  appendEvent(input: {
    runId: string;
    itemId?: string;
    attemptId?: string;
    type: string;
    payload: unknown;
  }): unknown;
}

export interface DeterministicCheckResult {
  id: string;
  kind: "check" | "file";
  ref: string;
  passed: boolean;
  cmd?: string[];
  exitCode?: number;
  timedOut?: boolean;
  timeoutMs?: number;
  durationMs?: number;
  outputTail?: string;
  reason?: string;
}

export interface DeterministicChecksOptions {
  workdir: string;
  changedFiles?: readonly string[];
  eventLog?: CheckEventSink;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  stdoutTailBytes?: number;
  stderrTailBytes?: number;
}

const DEFAULT_TAIL_BYTES = 32 * 1024;

/**
 * Run every declared check plus the two built-in scope checks. No result is
 * inferred from maker/verifier prose: only an exit code of exactly zero and
 * non-timeout process state count as a pass.
 */
export async function runDeterministicChecks(
  plan: PlanSchema,
  options: DeterministicChecksOptions,
): Promise<DeterministicCheckResult[]> {
  const results: DeterministicCheckResult[] = [];
  const root = resolve(options.workdir);
  const changedFiles = options.changedFiles ?? [];

  for (const file of plan.filesToTouch) {
    const result = await checkDeclaredFile(root, file);
    results.push(result);
    recordCheckEvent(result, options);
  }

  const scopeResult = checkChangedFilesSubset(root, plan.filesToTouch, changedFiles);
  results.push(scopeResult);
  recordCheckEvent(scopeResult, options);

  for (const check of plan.checks) {
    const result = await runDeclaredCheck(check.id, check.cmd, check.timeoutMs, options);
    results.push(result);
    recordCheckEvent(result, options);
  }

  return results;
}

export const runPlanChecks = runDeterministicChecks;

async function checkDeclaredFile(root: string, file: string): Promise<DeterministicCheckResult> {
  const ref = `file:${file}`;
  const candidate = resolve(root, file);
  if (!isInside(root, candidate)) {
    return {
      id: `file:${file}`,
      kind: "file",
      ref,
      passed: false,
      reason: "declared file escapes the workdir",
    };
  }
  try {
    await access(candidate);
    return { id: `file:${file}`, kind: "file", ref, passed: true };
  } catch {
    if (isDefenceDisabled("missing-file")) {
      return { id: `file:${file}`, kind: "file", ref, passed: true };
    }
    return {
      id: `file:${file}`,
      kind: "file",
      ref,
      passed: false,
      reason: `file does not exist: ${file}`,
    };
  }
}

function checkChangedFilesSubset(
  root: string,
  allowed: readonly string[],
  changed: readonly string[],
): DeterministicCheckResult {
  const allowedSet = new Set(allowed);
  const outside = changed.filter((file) => {
    const candidate = resolve(root, file);
    return !isInside(root, candidate) || !allowedSet.has(file);
  });
  return {
    id: "scope",
    kind: "check",
    ref: "check:scope",
    passed: outside.length === 0,
    reason: outside.length === 0 ? undefined : `changed files outside plan: ${outside.join(", ")}`,
  };
}

async function runDeclaredCheck(
  id: string,
  command: readonly string[],
  timeoutMs: number,
  options: DeterministicChecksOptions,
): Promise<DeterministicCheckResult> {
  const args = [...command];
  const executable = normalizeExecutable(args.shift()!);
  const startedAt = Date.now();
  let result: ProcessRunResult;
  try {
    result = await runProcess({
      executable,
      args,
      cwd: options.workdir,
      timeoutMs,
      stdoutTailBytes: options.stdoutTailBytes ?? DEFAULT_TAIL_BYTES,
      stderrTailBytes: options.stderrTailBytes ?? DEFAULT_TAIL_BYTES,
    });
  } catch (error) {
    return {
      id,
      kind: "check",
      ref: `check:${id}`,
      passed: false,
      cmd: [...command],
      timeoutMs,
      durationMs: Date.now() - startedAt,
      reason: `check crashed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const outputTail = [result.stdoutTail, result.stderrTail]
    .filter(Boolean)
    .join("\n")
    .slice(-DEFAULT_TAIL_BYTES);
  const passed = result.exitCode === 0 && !result.failed && !result.timedOut && !result.cancelled;
  return {
    id,
    kind: "check",
    ref: `check:${id}`,
    passed,
    cmd: [...command],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    timeoutMs,
    durationMs: Date.now() - startedAt,
    outputTail,
    reason: passed
      ? undefined
      : result.timedOut
      ? `check timed out after ${timeoutMs}ms`
      : `check exited with ${result.exitCode ?? "no exit code"}`,
  };
}

function normalizeExecutable(executable: string): string {
  if (process.platform !== "win32") return executable;
  if (["npm", "npx", "pnpm", "yarn"].includes(executable)) return `${executable}.cmd`;
  return executable;
}

function isInside(root: string, candidate: string): boolean {
  if (isAbsolute(relative(root, candidate))) return false;
  return relative(root, candidate) === "" || !relative(root, candidate).startsWith(`..`);
}

function recordCheckEvent(
  result: DeterministicCheckResult,
  options: DeterministicChecksOptions,
): void {
  if (!options.eventLog || !options.runId) return;
  try {
    options.eventLog.appendEvent({
      runId: options.runId,
      ...(options.itemId ? { itemId: options.itemId } : {}),
      ...(options.attemptId ? { attemptId: options.attemptId } : {}),
      type: "check.result",
      payload: result,
    });
  } catch {
    // Check results remain fail-closed even if an optional event sink is
    // unavailable. The orchestrator logs the result itself as a fallback.
  }
}
