// Loop orchestrator — drives plan → implement → verify → exit.
//
// Phase 1 (PLAN):
//   - Spawn loop-planner; await change to GOAL.md; parse plan; broadcast.
//   - Block on waitForEvent("confirm-plan") for user confirmation.
//
// Phase 2 + 3 (IMPLEMENT ↔ VERIFY) loop, up to maxAttempts:
//   - Spawn loop-maker; await change to STATE.md; parse diff.
//   - Spawn loop-verifier; await change to STATE.md; parse verdict.
//   - APPROVE → DONE, exit.
//   - REJECT and attempt < max → await feedback, increment attempt, retry.
//   - REJECT and attempt >= max → ESCALATED.
//   - ESCALATE_HUMAN → ESCALATED, exit.
//
// Real subprocess plumbing lives in `agent-spawner.ts`. File-watching lives in
// `state-sync.ts`. Markdown → typed data lives in `parser.ts`. This module
// just stitches them together and broadcasts the same WS events the mock
// version emitted, so the UI integration is unchanged.

import {
  appendHistory,
  appendLog,
  clearPendingResolvers,
  getTask,
  resolveEvent,
  setStatus,
  updateTask,
  waitForEvent,
} from "../store/tasks.js";
import { broadcaster } from "../ws/broadcaster.js";
import type {
  AgentRole,
  Connection,
  CriteriaWalkItem,
  DiffSummary,
  LogLevel,
  PlanSummary,
  Task,
  TaskStatus,
} from "../types.js";
import { modelOverrideKeyForRole } from "../types.js";
import {
  parsePlanGoal,
  parseStateDiff,
} from "./parser.js";
import {
  killAgent,
  spawnAgent,
  type AgentHandle,
} from "./agent-spawner.js";
import { watchFiles, type FileWatcher, type WatchedFile } from "./state-sync.js";
import {
  registerPreview,
  getPreviewServerBindCount,
} from "./preview-server.js";
import { runRuntimeCheck, type RuntimeCheckResult } from "./runtime-check.js";
import { runValidation } from "./validation.js";
import { runBuildStep, type BuildRunResult } from "./build-runner.js";
import type { AttemptRecord, VerdictOutcome } from "../types.js";
import { retrieveAnchors, formatAnchorsBlock, type Anchor } from "./anchors.js";
import {
  connectionsForRole,
  defaultModelIdForConnection,
  resolveConnectionModel,
} from "../store/connections.js";
import { ensureFreshHealth } from "./connection-health.js";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default K for the script-loop anchor retrieval. The rubric-planner /
 * rewriter prompts each include the top-K posts by save_rate as the
 * "what wins" signal. K=5 is enough to span the rubric without bloating
 * the prompt budget; tunable per-task via the K=… env override below.
 */
const SCRIPT_LOOP_ANCHOR_K = Number(process.env.LOOP_SCRIPT_K || 5);

/**
 * The script-loop's rubric (F1–F7) is graded on a 7-criterion scale,
 * but the UI + auto-exit logic surface the score on a familiar 0–10
 * scale (so the header can read "Score: 6/10" and the user doesn't
 * have to do mental math). The conversion is proportional — 7/7 = 10/10,
 * 0/7 = 0/10, etc. — rounded to the nearest integer.
 *
 * The threshold determines when the loop auto-exits with `done` vs.
 * keeps iterating:
 *   - verifier APPROVE                 → always done (verifier's own gate)
 *   - verifier REJECT, score >= thresh → done (good enough, ship it)
 *   - verifier REJECT, score <  thresh → auto-continue (no human in the
 *     loop; the orchestrator's previous behavior of waiting for user
 *     feedback is replaced by autonomous re-runs)
 *   - max attempts hit                 → best-so-far return (existing)
 *
 * Default 7/10 ≈ "B" — passes F1+F2+F3 plus at least one more.
 * Tunable via `LOOP_SCRIPT_MIN_SCORE` env (0–10).
 */
export const SCRIPT_LOOP_MIN_SCORE_OUT_OF_10 = Number(
  process.env.LOOP_SCRIPT_MIN_SCORE || 7
);

/**
 * Convert a passed/total pair from the criteria walk into the
 * 0–10 display scale. Rounded, clamped to [0, 10]. If `total` is
 * 0 (unparseable walk), returns 0.
 */
export function scaleScoreOutOf10(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(10, Math.round((passed * 10) / total)));
}

/**
 * Per-node score split. The criteria walk is graded as a single rubric,
 * but each criterion is primarily driven by one canvas node (planner,
 * maker, or verifier). The verifier may tag each criterion with a
 * `[planner]` / `[maker]` / `[verifier]` bracket; if no criterion is
 * tagged, fall back to the F1–F2 → planner / F3–F7 → maker mapping that
 * matches the video-hook rubric in `.opencode/agents/loop-{planner,
 * verifier}.md`. Anything that doesn't match either rule lands on
 * `verifier` (the overall-script owner). Pure: returns a new array.
 */
export function applyNodeTagFallback(
  walk: ReadonlyArray<CriteriaWalkItem>
): CriteriaWalkItem[] {
  // Trust explicit tags first. If even one criterion is tagged, leave
  // untagged ones alone (they may genuinely be verifier-owned).
  if (walk.some((c) => c.nodeId)) {
    return walk.map((c) => (c.nodeId ? c : { ...c }));
  }
  return walk.map((c) => {
    const m = c.criterion.match(/^F(\d+)\b/);
    if (m) {
      const n = Number(m[1]);
      const nodeId = n <= 2 ? "planner" : "maker";
      return { ...c, nodeId };
    }
    return { ...c, nodeId: "verifier" };
  });
}

/**
 * Group a criteria walk by `nodeId` and return passed/total counts per
 * group. Node ids absent from the walk are omitted from the result so
 * the broadcaster only emits events for nodes that actually contributed
 * a criterion this attempt.
 */
export function groupCriteriaByNode(
  walk: ReadonlyArray<CriteriaWalkItem>
): Record<string, { passed: number; total: number }> {
  const out: Record<string, { passed: number; total: number }> = {};
  for (const c of walk) {
    const id = c.nodeId ?? "verifier";
    if (!out[id]) out[id] = { passed: 0, total: 0 };
    out[id].total++;
    if (c.passed) out[id].passed++;
  }
  return out;
}

/**
 * Regex for the `--dataset <path>` flag inside the task prompt. The
 * script-optimization loop reads this once, retrieves the top-K anchors,
 * and reuses them across every prompt the loop builds for this task.
 * Whitespace-tolerant; supports both `--dataset path` and `--dataset=path`.
 *
 * No-op when absent: the loop continues with `anchorsBlock === ""` and
 * the rubric prompts degrade gracefully (the planner/maker still write
 * the plan, but without the empirical signal of past winners).
 */
const DATASET_FLAG_RE = /--dataset[=\s]+(\S+)/i;

/**
 * Pull the dataset path out of the task prompt. Returns `null` when the
 * flag is absent so callers can short-circuit anchor retrieval.
 */
function extractDatasetPath(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const m = prompt.match(DATASET_FLAG_RE);
  return m ? m[1] : null;
}

/**
 * Heuristic: is this a script-loop task? The rubric-planner is the only
 * agent that sets `filesToTouch: ["script.md"]` exactly — general code
 * plans have multi-file allowlists. We use this signal to (a) skip the
 * build + runtime check (a text file is not a webpage) and (b) switch
 * the max-attempts exit from "escalate" to "return best-so-far + score
 * trace" so the user gets a usable artifact instead of an empty hand-off.
 */
function isScriptWorkdir(plan: PlanSummary | null | undefined): boolean {
  const f = plan?.filesToTouch;
  return Array.isArray(f) && f.length === 1 && f[0] === "script.md";
}

/** Per-phase timeout. Real agent runs can take a few minutes; the orchestrator
 *  escalates if any phase doesn't produce its file in time.
 *
 *  Observed latency on the current bridge-runner model (GLM-5.2 via the
 *  NVIDIA relay) ranges 150-300s+ for the planner role alone — with a 5min
 *  ceiling, any run that lands past it gets killed via watcher.stop() +
 *  killAgent() in runLoop's finally block just as (or just before) the
 *  agent's writeFile lands on disk, so chokidar never gets a chance to fire.
 *  That looked like a broken file watcher but was actually a too-tight
 *  timeout racing real LLM response time. 10min gives real headroom above
 *  the observed ceiling. */
const PHASE_TIMEOUT_MS = Number(process.env.LOOP_PHASE_TIMEOUT_MS || 20 * 60_000);

/** Maker-specific timeout. The maker's output budget (8192 tokens — a full
 *  self-contained index.html) is ~4× the planner/verifier's, and the provider
 *  throttles the same model at roughly constant tokens-per-second, so its
 *  wall-clock cost scales accordingly: with the planner observed at 4-5 min,
 *  the maker overran the shared 10min ceiling with nothing on disk (the LLM
 *  call was still in flight when killAgent() fired). 25min = observed planner
 *  worst case × 4 (output scaling) + margin. */
const MAKER_TIMEOUT_MS = Number(process.env.LOOP_MAKER_TIMEOUT_MS || 25 * 60_000);

/** Stall watchdog: how long a planner/verifier may stream NO output before
 *  the watchdog declares it stalled and either salvage-parses or re-invokes.
 *  Default 4min is well below the 20min PHASE_TIMEOUT_MS so a single stalled
 *  verifier doesn't burn the full outer bound. Env-overridable so tests can
 *  drive a low value without waiting real minutes. */
const STALL_TIMEOUT_MS = Number(process.env.LOOP_STALL_TIMEOUT_MS || 4 * 60_000);

/** Thrown by the stall watchdog when a phase went quiet for STALL_TIMEOUT_MS.
 *  The orchestrator catches this and decides: salvage, re-invoke, or escalate. */
export class StallError extends Error {
  constructor(public phase: "planner" | "verifier" | "maker") {
    super(`STALLED: ${phase} produced no output for STALL_TIMEOUT_MS`);
    this.name = "StallError";
  }
}

/**
 * Race an inner promise against a stall timer. If the agent doesn't produce
 * any stdout/stderr activity for `timeoutMs` (read off the handle's
 * `lastActivityAt`), reject with `StallError`. The orchestrator's caller is
 * responsible for killing the agent and deciding to re-invoke or escalate.
 *
 * ponytail: deliberately NOT replacing the existing `awaitPhaseOutput`
 * timeout — that stays as the outer 20min bound. The stall watchdog only
 * fires EARLIER, so a slow-but-alive stream never trips it.
 */
export function withStallWatchdog<T>(
  inner: Promise<T>,
  agent: AgentHandle,
  phase: "planner" | "verifier",
  timeoutMs: number = STALL_TIMEOUT_MS,
  pollMs: number = 30_000
): Promise<T> {
  // ponytail: poll the spawner's `lastActivityAt` (updated by the
  // stdout/stderr line buffer on every chunk). If it hasn't been touched
  // in `timeoutMs`, the agent is hung-but-alive — kill it and reject
  // with StallError so the orchestrator can salvage or re-invoke.
  // The OUTER PHASE_TIMEOUT_MS in awaitPhaseOutput still bounds total
  // wall time; this watchdog only fires earlier.
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolved = false;
  const stallPromise = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (resolved) return;
      if (Date.now() - agent.lastActivityAt > timeoutMs) {
        resolved = true;
        if (timer) clearInterval(timer);
        agent.kill();
        reject(new StallError(phase));
      }
    }, pollMs);
  });
  return Promise.race([inner, stallPromise]).finally(() => {
    resolved = true;
    if (timer) clearInterval(timer);
  }) as Promise<T>;
}

/** Maximum number of times the user can request "Adjust & Re-plan" before
 *  we escalate. Beyond this, ping-ponging on the plan usually means the
 *  user's intent isn't converging on something the planner can produce —
 *  better to hand off to a human than burn cycles. */
const MAX_PLAN_ADJUSTS = 3;

/** Poll interval for checking cancellation while we await a file change. */
const CANCEL_POLL_MS = 250;

// ─────────────────────────────────────────────────────────────────────────────
// Loop registry
// ─────────────────────────────────────────────────────────────────────────────

const ACTIVE_LOOPS = new Set<string>();

/**
 * Carries the user's feedback from one REJECT verdict to the next attempt's
 * maker prompt. We keep this OUTSIDE the task store because `updateTask`
 * shallow-spreads into a fresh object on every status/field change — any
 * mutation we'd do on the old reference is discarded by the next
 * `getTask()` call. Module-level map keyed by taskId is the simplest carrier
 * that survives across iterations and is cleaned up in the loop's `finally`.
 */
const LAST_FEEDBACK = new Map<string, string>();

export function isLoopRunning(taskId: string): boolean {
  return ACTIVE_LOOPS.has(taskId);
}

export function stopLoop(taskId: string): void {
  // Unblock any pending awaits by resolving them with `undefined`.
  // `clearPendingResolvers` fires the resolver with undefined; the
  // orchestrator's post-await checks treat that as "stop requested".
  clearPendingResolvers(taskId);
  // Kill any live agent subprocess so the watcher stops waiting for a file
  // write that will never come.
  killAgent(taskId);
  ACTIVE_LOOPS.delete(taskId);
  setStatus(taskId, "cancelled", "User stopped the loop");
  const task = getTask(taskId);
  if (task) {
    broadcaster.broadcast(taskId, { type: "task_update", taskId, task });
  }
}

/**
 * Helper for the orchestrator body: returns true if the task was cancelled
 * since the last await/phase, and logs the appropriate banner. Call sites:
 *   if (bailIfCancelled(taskId, log, "during plan review")) return;
 *
 * Each phase transition is preceded by this check so the orchestrator
 * doesn't overwrite the "cancelled" status with a new phase (planning →
 * plan_review → implementing → …) AFTER the user already pressed Stop.
 * Without this, the cancelled state could silently revert to whatever
 * phase the loop was entering when stop fired.
 */
function bailIfCancelled(
  taskId: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  where: string
): boolean {
  if (!isCancelled(taskId)) return false;
  const task = getTask(taskId);
  if (task && task.status === "cancelled") {
    log(
      "orchestrator",
      "info",
      `■ loop cancelled ${where} — preserving "cancelled" status`
    );
  }
  return true;
}

/**
 * Resume a previously stopped (status=cancelled) task. Picks up from the
 * phase the task was in when stopped:
 *   - had a plan + diff → go to plan_review (re-approve + re-implement)
 *   - had a plan only   → go to plan_review (re-approve + implement)
 *   - no plan yet       → go to draft (user re-triggers planning)
 *
 * The orchestrator picks up the existing plan/diff as the starting point
 * rather than re-deriving from scratch. The attempt counter is NOT
 * incremented — Resume is a continuation, not a retry.
 *
 * Returns false if the task isn't in a resumable state, or true after
 * re-arming the loop (the actual runLoop promise is fire-and-forget).
 */
export function resumeLoop(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  if (task.status !== "cancelled" && task.status !== "escalated") {
    // Resumable only after a hard-stop or escalation. Done tasks are
    // terminal; active tasks can't be "resumed" — they're already running.
    return false;
  }
  if (ACTIVE_LOOPS.has(taskId)) return false; // already running

  // Restore the prior phase so runLoop skips ahead to where we were.
  // Priority: had a diff → verifying (re-verify the existing diff).
  //           had a plan only → plan_review.
  //           no plan yet → draft (the loop will start at planning phase).
  const restartStatus: TaskStatus = task.diff
    ? "verifying"
    : task.plan
    ? "plan_review"
    : "draft";

  // Clear the cancellation/escalation reason — we own the next attempt
  // now. Keep plan + diff so the resumed loop can use them as inputs.
  updateTask(taskId, {
    status: restartStatus,
    escalationReason: undefined,
  });
  const updated = getTask(taskId);
  if (updated) {
    broadcaster.broadcast(taskId, { type: "task_update", taskId, task: updated });
  }

  // Fire-and-forget; runLoop handles its own errors and state transitions.
  void runLoop(taskId).catch((err) => {
    console.error(`[orchestrator] resumed loop ${taskId} crashed:`, err);
  });
  return true;
}

/**
 * Reset a task back to its initial state and start a fresh loop. Unlike
 * Resume, this:
 *   - Clears plan, diff, verdict, history (start over)
 *   - Increments attempt counter (each reset counts as a fresh attempt)
 *   - Begins at planning phase regardless of prior progress
 *
 * Returns false if the task doesn't exist or is currently running.
 */
export function resetTask(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  if (ACTIVE_LOOPS.has(taskId)) return false;

  const nextAttempt = task.attempt + 1;
  if (task.maxAttempts > 0 && nextAttempt > task.maxAttempts) {
    // Hit the cap — don't reset, surface as escalation instead.
    setStatus(taskId, "escalated", "Reset cap reached (max attempts)");
    const updated = getTask(taskId);
    if (updated) {
      broadcaster.broadcast(taskId, { type: "task_update", taskId, task: updated });
    }
    return false;
  }

  updateTask(taskId, {
    status: "draft",
    plan: undefined,
    diff: undefined,
    verdict: undefined,
    escalationReason: undefined,
    attempt: nextAttempt,
    history: [],
    logs: [],
  });
  const updated = getTask(taskId);
  if (updated) {
    broadcaster.broadcast(taskId, { type: "task_update", taskId, task: updated });
  }

  void runLoop(taskId).catch((err) => {
    console.error(`[orchestrator] reset loop ${taskId} crashed:`, err);
  });
  return true;
}

/**
 * Re-prompt a task with a new user prompt. Unlike `resetTask`:
 *   - Overwrites the prompt (resetTask keeps the original)
 *   - Increments attempt counter
 *   - Clears plan/diff/verdict/history/logs
 *   - Begins a fresh loop from the planning phase
 *
 * Returns false if the task does not exist or is in a terminal state
 * (approved/done). Caller should map `false` to a 409 response.
 */
export function rePrompt(taskId: string, newPrompt: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  if (task.status === "done") return false;

  // Stop current loop if running (graceful — same path as POST /:id/stop).
  if (isLoopRunning(taskId)) stopLoop(taskId);

  const nextAttempt = (task.attempt ?? 0) + 1;
  updateTask(taskId, {
    prompt: newPrompt,
    attempt: nextAttempt,
    status: "draft",
    plan: undefined,
    diff: undefined,
    verdict: undefined,
    escalationReason: undefined,
    history: [],
    logs: [],
  });

  const updated = getTask(taskId);
  if (updated) {
    broadcaster.broadcast(taskId, { type: "task_update", taskId, task: updated });
    broadcaster.broadcast(taskId, {
      type: "task_re_prompted",
      taskId,
      prompt: newPrompt,
      attempt: nextAttempt,
    });
  }

  void runLoop(taskId).catch((err) => {
    console.error(`[orchestrator] re-prompt loop ${taskId} crashed:`, err);
  });

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry — runLoop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full plan → implement → verify → exit loop for a task. The function
 * is fire-and-forget from the API layer (`api/tasks.ts` calls `void runLoop`).
 * Any unhandled error is captured into the task's status as "escalated" and
 * broadcast as a WS `error` event.
 */
export async function runLoop(taskId: string): Promise<void> {
  if (ACTIVE_LOOPS.has(taskId)) {
    throw new Error("Loop already running for this task");
  }
  ACTIVE_LOOPS.add(taskId);

  // ── Helpers (closure over taskId) ────────────────────────────────────────
  const emit = (status: TaskStatus, message?: string) => {
    const prev = getTask(taskId);
    if (!prev) return;
    const next = setStatus(taskId, status, message) ?? undefined;
    if (prev.status !== status && next) {
      broadcaster.broadcast(taskId, {
        type: "phase_change",
        taskId,
        from: prev.status,
        to: status,
      });
    }
    if (next) {
      broadcaster.broadcast(taskId, { type: "task_update", taskId, task: next });
    }
    return next;
  };

  const log = (agent: AgentRole, stream: LogLevel, text: string) => {
    appendLog(taskId, agent, stream, text);
    broadcaster.broadcastLog(taskId, agent, stream, text);
  };

  const nodeStatus = (nodeId: string, status: string) => {
    broadcaster.broadcast(taskId, { type: "node_status", taskId, nodeId, status });
  };

  // File watcher — scoped to this loop run.
  const initialTask = getTask(taskId);
  if (!initialTask) {
    ACTIVE_LOOPS.delete(taskId);
    return;
  }
  // Fresh-run hygiene: a brand-new planning run must not inherit the
  // previous task's Diff Summaries / verdicts in STATE.md — they bloat
  // and confuse the verifier prompt. Resume paths (saved plan or diff)
  // intentionally keep STATE.md.
  if (!initialTask.plan && !initialTask.diff && initialTask.status !== "plan_review") {
    try {
      const { writeFile: wf, rm } = await import("node:fs/promises");
      await wf(
        pathResolve(initialTask.workdir, "STATE.md"),
        `# Loop State\n\nTask: ${initialTask.title}\nStarted: ${new Date().toISOString()}\n`,
        "utf8"
      );
      await rm(pathResolve(initialTask.workdir, ".loop"), { recursive: true, force: true });
      appendLog(taskId, "orchestrator", "info", "workdir hygiene: reset STATE.md and cleared .loop artifacts");
    } catch { /* hygiene is best-effort */ }
  }
  const watcher: FileWatcher = watchFiles(initialTask.workdir);
  await watcher.ready();

  // Canvas kickoff — the `task` and `orchestrator` nodes have no phase of
  // their own, so without an explicit broadcast they sit idle forever.
  nodeStatus("task", "success");
  nodeStatus("orchestrator", "success");

  // ─── Anchor retrieval (script-loop only) ──────────────────────────────
  // The script-optimization loop reads `--dataset <path>` from the task
  // prompt, pulls the top-K past posts by save_rate, and threads the
  // rendered block into the planner + maker prompts. Runs once per
  // runLoop and is shared across every prompt build for this task.
  // Failure is non-fatal: a missing or unreadable dataset degrades the
  // rubric prompts to "no empirical signal" rather than aborting the loop.
  let anchorsBlock = "";
  const datasetPath = extractDatasetPath(initialTask.prompt);
  if (datasetPath) {
    try {
      const anchors: Anchor[] = await retrieveAnchors(
        datasetPath,
        SCRIPT_LOOP_ANCHOR_K
      );
      anchorsBlock = formatAnchorsBlock(anchors);
      log(
        "orchestrator",
        "info",
        `✓ ANCHORS — retrieved ${anchors.length} from ${datasetPath} (top save_rate=${
          anchors[0]?.save_rate ?? "n/a"
        })`
      );
    } catch (err) {
      log(
        "orchestrator",
        "stderr",
        `✗ ANCHORS — failed to read ${datasetPath} (${errorMsg(err)}); continuing without empirical signal`
      );
    }
  }

  // ─── Validate custom-connection model picks ───────────────────────────
  // If the task's default model OR any per-role override references a
  // `custom:<connId>:<upstreamId>` whose connection has been deleted
  // since the task was created, fail fast with a clear escalation. The
  // user can then pick a different model from Connections, or recreate
  // the connection with the same id (not currently exposed).
  const validatedModelIds = new Set<string>();
  const validateRefs = async (): Promise<boolean> => {
    const candidates = [
      initialTask.model,
      initialTask.modelOverrides?.planning,
      initialTask.modelOverrides?.implementation,
      initialTask.modelOverrides?.review,
    ];
    for (const m of candidates) {
      if (!m || validatedModelIds.has(m)) continue;
      validatedModelIds.add(m);
      const resolved = resolveConnectionModel(m);
      if (m.startsWith("custom:") && !resolved) {
        const reason = `Connection for model "${m}" was deleted. Re-create the connection in the sidebar (Connections view) or pick a different model, then start a new task.`;
        log("orchestrator", "error", `■ ${reason}`);
        await escalate(taskId, reason, log, emit);
        return false;
      }
      if (resolved?.connection && !resolved.connection.apiKey) {
        const reason = `Connection "${resolved.connection.name}" has no API key set. Edit it via Connections → Edit → paste the key.`;
        log("orchestrator", "error", `■ ${reason}`);
        await escalate(taskId, reason, log, emit);
        return false;
      }
    }
    return true;
  };
  if (!(await validateRefs())) {
    ACTIVE_LOOPS.delete(taskId);
    return;
  }

try {
    // ─── Resume-skip: if the task already has a saved plan (came in via
    // /resume with status="plan_review" OR "verifying"), skip Phase 1
    // entirely. The user explicitly wanted to continue from where they
    // stopped — re-running the planner would discard their prior
    // approval. The "verifying" case matters: a task that escalated
    // mid-verify resumes with status="verifying" (from resumeLoop) and
    // a saved plan; without this branch, the planner would re-run and
    // overwrite the saved diff downstream.
    const skipPlanning =
      (initialTask.status === "plan_review" ||
        initialTask.status === "verifying") &&
      Boolean(initialTask.plan);
    if (skipPlanning) {
      log(
        "orchestrator",
        "info",
        `▶ RESUME — skipping planning, saved plan has ${initialTask.plan!.steps} steps`
      );
      appendHistory(
        taskId,
        "implementing",
        "Resumed with saved plan — skipping re-plan"
      );
    }
    // Parallel skip for Phase 2: a task that already reached the
    // verify phase (status="verifying" on resume, with both plan and
    // diff saved) should jump straight to the verifier — re-running
    // the maker would overwrite the saved diff and re-do work the
    // user already paid for. This is the missing half of the resume
    // machinery: skipPlanning handles the planner→implementer case;
    // skipImplementation handles the implementer→verifier case.
    let skipImplementation =
      initialTask.status === "verifying" &&
      Boolean(initialTask.plan) &&
      Boolean(initialTask.diff);
    // ponytail: `let` not `const` — the implementation block flips it to
    // false after consuming the skip (so a 2nd-iteration resume doesn't
    // re-skip).

    // ─── Phase 1: PLAN (with confirm/adjust loop) ────────────────────────
    // The planner agent runs once for the initial plan, then re-runs on
    // each "Adjust & Re-plan" request from the user. We cap the number of
    // adjustments (MAX_PLAN_ADJUSTS) — beyond that we escalate, since
    // ping-ponging on the plan usually means the user's intent isn't
    // converging on something the planner can produce.
    let currentGoalContent = "";
    let currentAdjustments = "";
    let planAdjustCount = 0;

    while (true) {
      if (skipPlanning) {
        // Resume-skip path: jump straight to Phase 2 with the saved plan.
        // currentGoalContent isn't needed by the maker (it reads GOAL.md
        // from disk), but set it for logging consistency.
        currentGoalContent = initialTask.plan?.rawGoal ?? "";
        break;
      }
      if (isCancelled(taskId)) {
        log("orchestrator", "info", "■ loop cancelled during planning");
        return;
      }

      const isReplan = planAdjustCount > 0;
      emit("planning", isReplan
        ? `Re-planning with user adjustments (${planAdjustCount}/${MAX_PLAN_ADJUSTS})`
        : "Orchestrator dispatching loop-planner");
      log(
        "orchestrator",
        "info",
        isReplan
          ? `▶ RE-PLAN attempt ${planAdjustCount}/${MAX_PLAN_ADJUSTS}`
          : `▶ PLAN — dispatching loop-planner`
      );
      nodeStatus("planner", "running");

      const contextBlock = await readTaskContextFiles(initialTask);
      const plannerPrompt = (isReplan
        ? buildAdjustPlannerPrompt(initialTask.prompt, currentAdjustments, currentGoalContent)
        : buildPlannerPrompt(initialTask.prompt, anchorsBlock)) + contextBlock;
      let plannerTarget = resolveSpawnTarget(initialTask, "planner");
      // Pre-flight: verify (or re-verify) the connection is alive before
      // paying for a spawn + stall window on a dead endpoint.
      const plannerPreflight = await preflightSpawnTarget(
        "planner",
        plannerTarget,
        log
      );
      if (!plannerPreflight.ok) {
        nodeStatus("planner", "error");
        escalate(taskId, plannerPreflight.reason, log, emit);
        return;
      }
      plannerTarget = plannerPreflight.target;
      const planner = spawnPlanner(
        taskId,
        initialTask.workdir,
        plannerPrompt,
        log,
        plannerTarget.model,
        plannerTarget.connection,
        (initialTask.attempt ?? 0) + 1
      );

      // Stall watchdog for the planner (Task 1 leftover of
      // 2026-07-11-loop-resilience-and-real-build). Same pattern as the
      // verifier: first stall → kill + re-invoke once, second stall →
      // escalate with a distinct STALLED reason. Non-stall errors
      // propagate to the outer catch exactly as before. Planner stalls
      // happen before any implement/verify attempt exists, so there is
      // no AttemptRecord to annotate — the log lines carry the signal.
      let goalContent: string;
      try {
        goalContent = await withStallWatchdog(
          awaitPhaseOutput(watcher, "GOAL.md", planner, PHASE_TIMEOUT_MS, taskId),
          planner,
          "planner"
        );
      } catch (err) {
        if (isCancelled(taskId)) return;
        if (!(err instanceof StallError)) throw err;
        // Failover (Part C #2): don't re-invoke the SAME dead connection —
        // pick a different healthy one serving the planning role when
        // available; fall back to the original target only if none exists.
        const plannerRetryTarget =
          pickFailoverTarget("planner", plannerTarget.connection?.id) ??
          plannerTarget;
        log(
          "planner",
          "stderr",
          `⟳ planner stalled (no output ${STALL_TIMEOUT_MS / 1000}s) — re-invoking (salvage attempt 1/1)` +
            (plannerRetryTarget !== plannerTarget
              ? ` on failover connection "${plannerRetryTarget.connection?.name}"`
              : "")
        );
        const retryPlanner = spawnPlanner(
          taskId,
          initialTask.workdir,
          plannerPrompt,
          log,
          plannerRetryTarget.model,
          plannerRetryTarget.connection,
          (initialTask.attempt ?? 0) + 1
        );
        try {
          goalContent = await withStallWatchdog(
            awaitPhaseOutput(watcher, "GOAL.md", retryPlanner, PHASE_TIMEOUT_MS, taskId),
            retryPlanner,
            "planner"
          );
        } catch (retryErr) {
          if (isCancelled(taskId)) return;
          if (retryErr instanceof StallError) {
            log("planner", "stderr", `✗ planner stalled twice — escalating`);
            nodeStatus("planner", "error");
            escalate(
              taskId,
              `STALLED: planner produced no output twice (waited ${STALL_TIMEOUT_MS / 1000}s each)`,
              log,
              emit
            );
            return;
          }
          throw retryErr;
        }
      }
      log("planner", "stdout", `planner wrote GOAL.md (${goalContent.length} chars)`);

      // If the user pressed Stop while the planner was writing, don't
      // bother parsing + saving the plan — the cancellation is final.
      if (bailIfCancelled(taskId, log, "after planner write")) return;

      const plan: PlanSummary = parsePlanGoal(goalContent);
      // Plan-quality gate: a plan without completion criteria is
      // unverifiable — the verifier would be reduced to vibes. Re-plan
      // automatically with explicit instructions; only escalate to the user
      // when the adjust budget runs out.
      if (plan.criteria.length === 0 && planAdjustCount < MAX_PLAN_ADJUSTS) {
        log(
          "orchestrator",
          "stderr",
          "✗ plan has 0 completion criteria — auto re-planning with explicit format instructions"
        );
        currentAdjustments =
          "Your previous plan was REJECTED automatically: it contained no " +
          "'## Completion Criteria' section (or the section was empty). " +
          "Re-emit the FULL GOAL.md including a '## Completion Criteria' " +
          "section with 5-10 concrete, checkable bullet criteria " +
          "(e.g. '- clicking cell 5 places X in the center').";
        currentGoalContent = goalContent;
        planAdjustCount++;
        continue;
      }
      updateTask(taskId, { plan });
      appendHistory(
        taskId,
        "planning",
        isReplan
          ? `Re-plan ${planAdjustCount}/${MAX_PLAN_ADJUSTS}: ${plan.steps} steps, ${plan.filesToTouch.length} files`
          : `Planner returned ${plan.steps} steps, ${plan.filesToTouch.length} files`
      );

      broadcaster.broadcast(taskId, { type: "plan_ready", taskId, plan });
      broadcaster.broadcast(taskId, {
        type: "task_update",
        taskId,
        task: getTask(taskId)!,
      });
      // AFTER task_update: the UI re-derives node statuses on every
      // task_update, so per-node refinements must be broadcast last to win.
      nodeStatus("planner", "success");
      log("planner", "stdout", `✓ PLAN READY — ${plan.steps} steps, criteria: ${plan.criteria.length}`);

      // Bail BEFORE emitting plan_review — otherwise we'd overwrite a
      // stop that fired while the planner was running.
      if (bailIfCancelled(taskId, log, "after planning")) return;

      emit("plan_review", isReplan ? "Review the re-planned version" : "Awaiting user confirmation");
      log("orchestrator", "info", `⏸ PLAN REVIEW — waiting for confirm or adjust (${planAdjustCount}/${MAX_PLAN_ADJUSTS} adjusts so far)`);
      nodeStatus("plan_review", "running");

      // ponytail: autoApprovePlan = skip the user gate, fall through to Phase 2
      if (initialTask.autoApprovePlan) {
        log("orchestrator", "info", "▶ autoApprovePlan set — skipping plan review");
        nodeStatus("plan_review", "success");
        break;
      }

      // Block until user confirms OR adjusts. The two event kinds are
      // registered as separate promises so resolveEvent() picks the right
      // one when the matching endpoint fires.
      const confirmPromise = waitForEvent(taskId, "confirm-plan");
      const adjustPromise = waitForEvent(taskId, "adjust-plan");
      const reviewResult = await Promise.race([
        confirmPromise.then((v) => ({ kind: "confirm" as const, value: v })),
        adjustPromise.then((v) => ({ kind: "adjust" as const, value: v })),
      ]);

      if (isCancelled(taskId)) {
        log("orchestrator", "info", "■ loop cancelled during plan review");
        return;
      }

      if (reviewResult.kind === "confirm") {
        const adjustments = extractAdjustments(reviewResult.value);
        log(
          "orchestrator",
          "info",
          adjustments
            ? `▶ user confirmed plan with adjustments (${adjustments.length} chars)`
            : "▶ user confirmed plan"
        );
        nodeStatus("plan_review", "success");
        // Exit the confirm/adjust loop — fall through to Phase 2.
        break;
      }

      // reviewResult.kind === "adjust"
      const adjustText = extractAdjustments(reviewResult.value);
      if (!adjustText) {
        // Shouldn't happen — the API endpoint validates non-empty — but
        // treat a missing adjustment as a confirm instead of looping forever.
        log("orchestrator", "info", "▶ adjust-plan received with empty text — treating as confirm");
        nodeStatus("plan_review", "success");
        break;
      }

      planAdjustCount += 1;
      currentAdjustments = adjustText;
      currentGoalContent = goalContent;

      if (planAdjustCount >= MAX_PLAN_ADJUSTS) {
        // Cap reached — escalate rather than ping-pong forever.
        nodeStatus("plan_review", "error");
        const reason = `Plan adjusted ${MAX_PLAN_ADJUSTS} times without confirmation. The user's intent may not be converging — manual review needed.`;
        escalate(taskId, reason, log, emit);
        return;
      }

      log(
        "orchestrator",
        "info",
        `▶ user requested adjust (${planAdjustCount}/${MAX_PLAN_ADJUSTS}, ${adjustText.length} chars) — re-spawning planner`
      );
      nodeStatus("plan_review", "success");
      // Loop continues — re-spawn planner with the adjustments + existing plan.
    }

    // ─── Phase 2 + 3: IMPLEMENT ↔ VERIFY ────────────────────────────────
    while (true) {
      if (isCancelled(taskId)) {
        log("orchestrator", "info", "■ loop cancelled");
        return;
      }

      const task = getTask(taskId);
      if (!task) return;
      if (task.attempt >= task.maxAttempts) {
        break;
      }

      const attempt = task.attempt + 1;
      updateTask(taskId, { attempt });

      // Bail before flipping to "implementing" if the user stopped us
      // while the previous phase was winding down.
      if (bailIfCancelled(taskId, log, "before implementation")) return;

      // Per-attempt timing — each phase stamps its own start so the
      // AttemptRecord we append at the end of the cycle can report
      // realistic phase durations. attemptStartMs is the wall clock for
      // the whole attempt; the per-phase markers are set just before the
      // phase begins and read at append time.
      const attemptStartMs = Date.now();
      let makerStartMs: number | null = null;
      let makerEndMs: number | null = null;
      let runtimeStartMs: number | null = null;
      let runtimeEndMs: number | null = null;
      let verifierStartMs: number | null = null;
      let verifierEndMs: number | null = null;
      // Validation outcome for the per-attempt timeline (set inside the
      // maker block when the pre-runtime gate runs).
      let validationOutcome: { passed: boolean; errors: string[] } | null = null;
      // Build/test results for project-shaped workdirs (Task 3). Reset
      // inside the attempt body right before runBuildStep; declared here
      // so the post-verdict AttemptRecord append can read it.
      let buildRun: BuildRunResult | undefined;
      // Stall events for this attempt (Task 1 of
      // 2026-07-11-loop-resilience-and-real-build). Pushed by the
      // verifier (and later planner) watchdog blocks; read at append
      // time so the timeline can label each STALLED event with its
      // resolution.
      const stallsThisAttempt: import("../types.js").StallRecord[] = [];
      // Snapshot of the previous attempt's file contents, captured
      // BEFORE the maker runs (so we can compare against the new
      // attempt's contents to detect the "no effective change" failure
      // mode). Populated below from task.diff.filesChanged.
      let previousFilesSnapshot: Record<string, string> = {};

      // These four are filled in by either the implementation block
      // below or by the resume-skip branch — Phase 3 (verify) reads
      // them in either case.
      let stateAfterMake = "";
      let diff: DiffSummary | null = null;
      let runtime: RuntimeCheckResult | null = null;
      // Read once at the top of the iteration; the maker block uses it
      // and the verifier block uses it, so it can't be local to the
      // else branch.
      const latestGoal = watcher.getLatestContent("GOAL.md") ?? currentGoalContent;

      // ─── Phase 2: IMPLEMENT (or skip on resume-with-saved-diff) ─────
      // When a task escalates mid-verify, resumeLoop preserves plan +
      // diff and sets status="verifying". Without this branch, runLoop
      // would re-enter Phase 1 and overwrite the saved plan/diff — the
      // observed "resume lost everything" bug. The skip path reuses
      // the existing STATE.md and diff; the runtime check is NOT re-run
      // (its evidence is still in <workdir>/.loop/ if the verifier needs
      // to cross-reference, and re-running on resume is wasteful when
      // no files have changed).
      if (skipImplementation) {
        skipImplementation = false;
        log(
          "orchestrator",
          "info",
          `▶ RESUME — skipping implementation, reusing saved diff (${task.diff!.filesChanged.length} files)`
        );
        appendHistory(
          taskId,
          "verifying",
          "Resumed with saved diff — skipping re-implementation"
        );
        stateAfterMake = watcher.getLatestContent("STATE.md") ?? "";
        diff = task.diff ?? null;
      } else {
        emit("implementing", `Attempt ${attempt}: dispatching loop-maker`);
        log("maker", "info", `▶ IMPLEMENT attempt ${attempt}`);
        // `read_state` covers the maker's read of STATE.md (attempt # +
        // prior verifier feedback) just below — animate it through the
        // prompt build, then hand off to the maker node.
        nodeStatus("read_state", "running");
        makerStartMs = Date.now();

        // Capture the previous attempt's file contents BEFORE the maker
        // overwrites them — the validator's no-op guard uses this to
        // detect "the LLM wrote the same bytes as last time". For
        // attempt 1 there's no previous, so the snapshot is empty and
        // the guard falls back to "zero files changed" only.
        if (task.diff?.filesChanged) {
          for (const f of task.diff.filesChanged) {
            try {
              previousFilesSnapshot[f.path] = await readFile(
                pathResolve(task.workdir, f.path),
                "utf8"
              );
            } catch {
              // File didn't exist on disk before the maker — record an
              // empty string so the validator treats it as a NEW file
              // (it will compare against "" and find a real diff).
              previousFilesSnapshot[f.path] = "";
            }
          }
        }

        const latestState = watcher.getLatestContent("STATE.md");
        const feedback = LAST_FEEDBACK.get(taskId);
        const makerPrompt = buildMakerPrompt(
          attempt,
          task.maxAttempts,
          latestGoal,
          latestState,
          feedback,
          anchorsBlock
        ) + (await readTaskContextFiles(initialTask));
        nodeStatus("read_state", "success");
        nodeStatus("maker", "running");
        let makerTarget = resolveSpawnTarget(task, "maker");
        const makerPreflight = await preflightSpawnTarget(
          "maker",
          makerTarget,
          log
        );
        if (!makerPreflight.ok) {
          nodeStatus("maker", "error");
          escalate(taskId, makerPreflight.reason, log, emit);
          return;
        }
        makerTarget = makerPreflight.target;
        const maker = spawnMaker(
          taskId,
          task.workdir,
          makerPrompt,
          log,
          makerTarget.model,
          makerTarget.connection,
          attempt
        );

        try {
          stateAfterMake = await awaitPhaseOutput(
            watcher,
            "STATE.md",
            maker,
            MAKER_TIMEOUT_MS,
            taskId
          );
        } catch (err) {
          if (isCancelled(taskId)) {
            // stopLoop already set status + broadcast — nothing more to do.
            return;
          }
          // v4-class provider crash ("Failed to process successful
          // response" from the AI SDK, agent exited before writing) —
          // fail over to a different healthy connection once before
          // escalating (Part C #2). No alternative → escalate exactly
          // as before.
          const makerRetryTarget = pickFailoverTarget(
            "maker",
            makerTarget.connection?.id
          );
          if (!makerRetryTarget) {
            log("maker", "stderr", `✗ IMPLEMENT FAILED — ${errorMsg(err)}`);
            nodeStatus("maker", "error");
            escalate(
              taskId,
              `Maker failed on attempt ${attempt}: ${errorMsg(err)}`,
              log,
              emit
            );
            return;
          }
          log(
            "maker",
            "stderr",
            `⟳ maker failed (${errorMsg(err)}) — failing over to connection "${makerRetryTarget.connection.name}" (retry 1/1)`
          );
          const retryMaker = spawnMaker(
            taskId,
            task.workdir,
            makerPrompt,
            log,
            makerRetryTarget.model,
            makerRetryTarget.connection,
            attempt
          );
          try {
            stateAfterMake = await awaitPhaseOutput(
              watcher,
              "STATE.md",
              retryMaker,
              MAKER_TIMEOUT_MS,
              taskId
            );
          } catch (retryErr) {
            if (isCancelled(taskId)) return;
            log(
              "maker",
              "stderr",
              `✗ IMPLEMENT FAILED (after failover) — ${errorMsg(retryErr)}`
            );
            nodeStatus("maker", "error");
            escalate(
              taskId,
              `Maker failed on attempt ${attempt} on two connections: ${errorMsg(err)}; then on "${makerRetryTarget.connection.name}": ${errorMsg(retryErr)}`,
              log,
              emit
            );
            return;
          }
        }

        const parsed = parseStateDiff(stateAfterMake);
        if (!parsed.diff) {
          log(
            "maker",
            "stderr",
            "✗ maker wrote STATE.md but no Diff Summary section was found"
          );
          nodeStatus("maker", "error");
          escalate(
            taskId,
            `Maker output on attempt ${attempt} had no Diff Summary section`,
            log,
            emit
          );
          return;
        }
        diff = parsed.diff;

        updateTask(taskId, { diff });
        appendHistory(
          taskId,
          "implementing",
          `Diff: ${diff.filesChanged.length} files, build exit ${diff.buildExit ?? "n/a"}, tests ${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`
        );
        broadcaster.broadcast(taskId, { type: "diff_ready", taskId, diff });
        broadcaster.broadcast(taskId, {
          type: "task_update",
          taskId,
          task: getTask(taskId)!,
        });
        // AFTER task_update — refinements must outlive the UI's re-derive.
        nodeStatus("maker", "success");
        log(
          "maker",
          "stdout",
          `✓ IMPLEMENT — ${diff.filesChanged.length} files changed, build exit ${diff.buildExit ?? "n/a"}`
        );
        makerEndMs = Date.now();

        // ─── Pre-runtime validation (Task 5). Two cheap gates run
        // BEFORE we pay for the headless-browser runtime check:
        //   (a) no-op guard: zero files, or every changed file is
        //       byte-identical to the previous attempt
        //   (b) syntax gate: `node --check` on JS/TS files
        // On failure, set validationOutcome, save the diff (it stays
        // accurate), append an AttemptRecord, set LAST_FEEDBACK with
        // the validation error, and skip straight to the next attempt.
        // The runtime check + verifier + DECIDE block are short-
        // circuited. We do NOT return from runLoop — the loop
        // continues with attempt+1.
        const validation = await runValidation(
          initialTask.workdir,
          diff.filesChanged,
          previousFilesSnapshot
        );
        if (!validation.passed) {
          validationOutcome = validation;
          log(
            "orchestrator",
            "stderr",
            `✗ VALIDATION — ${validation.errors[0]}${
              validation.errors.length > 1
                ? ` (+${validation.errors.length - 1} more)`
                : ""
            }`
          );
          // Save the diff so the timeline shows what the maker tried
          // to change, even though we short-circuited before the
          // runtime check.
          updateTask(taskId, { diff });
          // Append the AttemptRecord. The runtime and verifier are
          // both undefined here — the timeline card will show
          // "PRE-RT FAIL" via the validation field, no runtime result,
          // and no verifier verdict. The reason field carries the
          // validation error message verbatim.
          appendAttemptRecord(taskId, attempt, {
            makerMs:
              makerEndMs && makerStartMs ? makerEndMs - makerStartMs : undefined,
            filesChanged: diff.filesChanged,
            runtimeResult: undefined,
            verifierVerdict: undefined,
            rejectReason: validation.errors[0]?.slice(0, 300),
            artifactPaths: {
              maker: `.loop/maker-attempt-${attempt}-raw.md`,
              runtimeJson: `.loop/runtime-attempt-${attempt}.json`,
              runtimePng: `.loop/runtime-attempt-${attempt}.png`,
              verifier: `.loop/verifier-attempt-${attempt}-raw.md`,
            },
            validation: validation,
            completedAt: new Date().toISOString(),
          });
          // Feed the validation error back as feedback for the next
          // attempt's maker. This is auto-generated (no human feedback
          // wait) — exactly the same pathway the runtime-check
          // errors use on REJECT.
          LAST_FEEDBACK.set(
            taskId,
            `VALIDATION FAILED on your previous attempt:\n${validation.errors.join(
              "\n"
            )}\n\nFix these issues and try again.`
          );
          log(
            "orchestrator",
            "info",
            "▶ auto-continue triggered (validation fail)"
          );
          nodeStatus("maker", "error");
          // Continue the while loop to the next attempt. The DECIDE
          // block at the bottom of the iteration is reached but
          // verdict is null and runtime is null, so neither the
          // APPROVE nor REJECT paths match — but we don't want the
          // REJECT path to wait for human feedback here. Use a
          // labeled continue to skip the rest of the loop body.
          continue;
        }
        // validation.passed: log success and fall through to runtime check.
        log("orchestrator", "info", "✓ VALIDATION — passed");

        // ─── Script-loop guard: a workdir whose plan is exactly
        // `script.md` is a text-only artifact, not a webpage. Skip the
        // build + runtime check entirely — there is nothing to compile,
        // and serving script.md as HTML would yield a meaningless
        // runtime report. The verifier (Phase 3) still runs and scores
        // the rubric. We do this BEFORE runBuildStep so a no-package.json
        // workdir doesn't even spin up the runner.
        if (isScriptWorkdir(getTask(taskId)?.plan)) {
          log(
            "orchestrator",
            "info",
            "▶ SCRIPT LOOP — skipping build + runtime check (plan = [script.md])"
          );
        } else {
        // ─── Build/test step for project-shaped workdirs (Task 3 of
        // 2026-07-11-loop-resilience-and-real-build). Static workdirs
        // (no package.json) return undefined and this block is a no-op —
        // the pipeline below runs byte-identically to before. On a
        // failed stage we short-circuit exactly like a validation
        // failure: record the attempt, feed the output tail back to the
        // next maker, skip runtime + verifier.
        buildRun = undefined;
        try {
          buildRun = await runBuildStep(initialTask.workdir, (line) =>
            log("orchestrator", "info", line)
          );
        } catch (err) {
          // Best-effort: a build-runner crash must never take down the
          // static path. Log and continue as if no build step existed.
          log("orchestrator", "stderr", `build-runner crashed (ignored): ${errorMsg(err)}`);
        }
        if (buildRun?.failedStage) {
          log(
            "orchestrator",
            "stderr",
            `✗ BUILD — ${buildRun.failedStage} stage failed${
              buildRun.buildExit !== undefined ? ` (exit ${buildRun.buildExit})` : ""
            }`
          );
          appendAttemptRecord(taskId, attempt, {
            makerMs:
              makerEndMs && makerStartMs ? makerEndMs - makerStartMs : undefined,
            filesChanged: diff.filesChanged,
            runtimeResult: undefined,
            verifierVerdict: undefined,
            rejectReason: `build ${buildRun.failedStage} stage failed`,
            artifactPaths: {
              maker: `.loop/maker-attempt-${attempt}-raw.md`,
              runtimeJson: `.loop/runtime-attempt-${attempt}.json`,
              runtimePng: `.loop/runtime-attempt-${attempt}.png`,
              verifier: `.loop/verifier-attempt-${attempt}-raw.md`,
            },
            buildRun: toBuildRunRecord(buildRun),
            completedAt: new Date().toISOString(),
          });
          LAST_FEEDBACK.set(
            taskId,
            `BUILD FAILED on your previous attempt (${buildRun.failedStage} stage):\n${
              buildRun.outputTail ?? "(no output captured)"
            }\n\nFix these issues and try again.`
          );
          log("orchestrator", "info", "▶ auto-continue triggered (build fail)");
          nodeStatus("maker", "error");
          continue;
        }
        if (buildRun) {
          // Real exit codes replace the maker-reported (often mocked)
          // diff fields — extend meaning, never rename.
          if (buildRun.buildExit !== undefined) diff.buildExit = buildRun.buildExit;
          updateTask(taskId, { diff });
          log(
            "orchestrator",
            "info",
            `✓ BUILD — install ${buildRun.installMs ?? 0}ms, build exit ${
              buildRun.buildExit ?? "n/a"
            }, test exit ${buildRun.testExit ?? "n/a"}${
              buildRun.outputDir ? ` — serving built output` : ""
            }`
          );
        }

        // ─── Runtime check: serve the workdir and actually RUN the prototype.
        // The verifier gets this evidence verbatim; a broken page can no
        // longer be APPROVEd on source-reading alone. `runtime` is reused
        // below by the verifier-prompt builder and the REJECT-feedback path.
        try {
          runtimeStartMs = Date.now();
          // Snapshot the bind counter before/after so we can detect a
          // self-healing restart and tell the user the preview link
          // survived. If the server died between tasks (or mid-run),
          // ensureServer() re-binds on the next registerPreview call —
          // the counter goes up, and we log + re-broadcast so the UI
          // shows the live link again instead of pointing at a dead port.
          const bindsBefore = getPreviewServerBindCount();
          // Project-shaped tasks with a successful build serve the BUILT
          // output; static tasks keep the exact current registration
          // (Task 3 — locked default path).
          const previewUrl = await registerPreview(
            taskId,
            buildRun?.outputDir ?? initialTask.workdir
          );
          if (getPreviewServerBindCount() > bindsBefore) {
            log(
              "orchestrator",
              "info",
              "↻ preview server restarted — re-registering preview URL"
            );
          }
          updateTask(taskId, { previewUrl });
          const t2 = getTask(taskId);
          if (t2) broadcaster.broadcast(taskId, { type: "task_update", taskId, task: t2 });
          log("orchestrator", "info", `▶ RUNTIME CHECK — loading ${previewUrl} in headless chromium`);
          runtime = await runRuntimeCheck(previewUrl, initialTask.workdir, attempt);
          runtimeEndMs = Date.now();
          log(
            "orchestrator",
            runtime.ok ? "info" : "stderr",
            runtime.ok
              ? `✓ RUNTIME CHECK — no errors (${runtime.interactionLog.length} interactions)`
              : `✗ RUNTIME CHECK — ${runtime.pageErrors.length} page errors, ${runtime.consoleErrors.length} console errors (screenshot: ${runtime.screenshotPath})`
          );
          updateTask(taskId, {
            runtimeCheck: {
              attempt,
              ok: runtime.ok,
              pageErrorCount: runtime.pageErrors.length,
              consoleErrorCount: runtime.consoleErrors.length,
              screenshotRelPath: runtime.screenshotPath
                ? `.loop/${runtime.screenshotPath.split("/").pop()}`
                : null,
            },
          });
          const t3 = getTask(taskId);
          if (t3) broadcaster.broadcast(taskId, { type: "task_update", taskId, task: t3 });
        } catch (err) {
          log("orchestrator", "stderr", `runtime check failed to run: ${errorMsg(err)} — verifier will judge from source only`);
        }
        } // end else (!isScriptWorkdir)
      } // end else (skipImplementation)

      // Bail if the user stopped us between implement and verify.
      if (bailIfCancelled(taskId, log, "before verification")) return;

      // ─── Phase 3: VERIFY ─────────────────────────────────────────────
      emit("verifying", `Attempt ${attempt}: dispatching loop-verifier`);
      log("verifier", "info", `▶ VERIFY attempt ${attempt}`);
      nodeStatus("verifier", "running");
      verifierStartMs = Date.now();

      const verifierPrompt = await buildVerifierPrompt(
        attempt,
        latestGoal,
        stateAfterMake,
        initialTask.workdir,
        diff,
        runtime?.evidenceMarkdown ?? null
      );
      let verifierTarget = resolveSpawnTarget(task, "verifier");
      const verifierPreflight = await preflightSpawnTarget(
        "verifier",
        verifierTarget,
        log
      );
      if (!verifierPreflight.ok) {
        nodeStatus("verifier", "error");
        escalate(taskId, verifierPreflight.reason, log, emit);
        return;
      }
      verifierTarget = verifierPreflight.target;
      const verifier = spawnVerifier(
        taskId,
        task.workdir,
        verifierPrompt,
        log,
        verifierTarget.model,
        verifierTarget.connection,
        attempt
      );

      // ─── Live verifier progress ──────────────────────────────────────
      // The bridge now streams the verifier's response into STATE.md
      // chunk-by-chunk, so the criteria walk appears progressively.
      // Subscribe to STATE.md changes for the duration of this phase,
      // re-parse on each change, and broadcast a `verifier_progress`
      // WS event with the partial walk so the UI can render a running
      // X/Y PASS counter. The subscription is torn down in the
      // surrounding try/finally regardless of how the phase exits.
      // Set up the live-progress subscription for any task whose plan
      // has completion criteria — the verifier emits a `**Criteria walk:**`
      // for every such task, and the UI's verifier node shows a live X/Y
      // PASS counter from these events. The inner early-return on
      // `criteriaWalk.length === 0` already suppresses noise for plans
      // with no criteria, so this gate is "has criteria" not "is script".
      let unsubscribeLiveProgress: (() => void) | null = null;
      if ((getTask(taskId)?.plan?.criteria.length ?? 0) > 0) {
        let lastBroadcastContent = "";
        // Per-attempt cache of the last node_score we emitted, keyed by
        // `${attempt}:${nodeId}`. The criteria walk can be re-emitted as
        // a single edit; without this the UI would re-show the same
        // score on every file write, which is the same flicker the
        // verifier_progress path used to have.
        const lastNodeScore = new Map<string, { passed: number; total: number }>();
        unsubscribeLiveProgress = watcher.onChange((file, content) => {
          if (file !== "STATE.md") return;
          if (content === lastBroadcastContent) return;
          lastBroadcastContent = content;
          try {
            const { verdict: liveVerdict } = parseStateDiff(content);
            if (!liveVerdict || liveVerdict.criteriaWalk.length === 0) return;
            if (liveVerdict.attempt !== attempt) return; // stale (older attempt's walk)
            const walk = applyNodeTagFallback(liveVerdict.criteriaWalk);
            broadcaster.broadcast(taskId, {
              type: "verifier_progress",
              taskId,
              attempt: liveVerdict.attempt,
              passed: walk.filter((c) => c.passed).length,
              total: walk.length,
              partial: walk,
              done: false,
            });
            // Per-node score breakdown. One WS event per contributing
            // node (planner / maker / verifier); the UI surfaces each
            // as a small /10 badge on the matching canvas node.
            const groups = groupCriteriaByNode(walk);
            for (const [nodeId, counts] of Object.entries(groups)) {
              const key = `${liveVerdict.attempt}:${nodeId}`;
              const prev = lastNodeScore.get(key);
              if (prev && prev.passed === counts.passed && prev.total === counts.total) {
                continue; // unchanged — skip the redundant broadcast
              }
              lastNodeScore.set(key, counts);
              broadcaster.broadcast(taskId, {
                type: "node_score",
                taskId,
                attempt: liveVerdict.attempt,
                nodeId,
                passed: counts.passed,
                total: counts.total,
                score: scaleScoreOutOf10(counts.passed, counts.total),
                done: false,
              });
            }
          } catch {
            // Mid-write parse failures are non-fatal; the next change
            // event will pick up the corrected content.
          }
        });
      }

      let stateAfterVerify: string;
      try {
        // ponytail: stall watchdog (Task 1 of
        // 2026-07-11-loop-resilience-and-real-build). Wraps awaitPhaseOutput
        // with a STALL_TIMEOUT_MS race; on first stall kill + re-invoke
        // once, on second stall escalate. The outer PHASE_TIMEOUT_MS
        // still bounds total wall time.
        stateAfterVerify = await withStallWatchdog(
          awaitPhaseOutput(watcher, "STATE.md", verifier, PHASE_TIMEOUT_MS, taskId),
          verifier,
          "verifier"
        );
      } catch (err) {
        if (isCancelled(taskId)) {
          return;
        }
        if (err instanceof StallError) {
          // First stall — re-invoke the verifier exactly once. Record
          // the event on the attempt so the timeline can label it.
          // Failover (Part C #2): route the retry around the stalled
          // connection when a different healthy one serves the review role.
          const verifierRetryTarget =
            pickFailoverTarget("verifier", verifierTarget.connection?.id) ??
            verifierTarget;
          log(
            "verifier",
            "stderr",
            `⟳ verifier stalled (no output ${STALL_TIMEOUT_MS / 1000}s) — re-invoking (salvage attempt 1/1)` +
              (verifierRetryTarget !== verifierTarget
                ? ` on failover connection "${verifierRetryTarget.connection?.name}"`
                : "")
          );
          stallsThisAttempt.push({
            phase: "verifier",
            stalledAfterMs: STALL_TIMEOUT_MS,
            resolution: "reinvoke",
          });
          const retryVerifier = spawnVerifier(
            taskId,
            task.workdir,
            verifierPrompt,
            log,
            verifierRetryTarget.model,
            verifierRetryTarget.connection,
            attempt
          );
          try {
            stateAfterVerify = await withStallWatchdog(
              awaitPhaseOutput(watcher, "STATE.md", retryVerifier, PHASE_TIMEOUT_MS, taskId),
              retryVerifier,
              "verifier"
            );
          } catch (retryErr) {
            if (isCancelled(taskId)) return;
            if (retryErr instanceof StallError) {
              // Second stall — escalate with a distinct STALLED reason.
              stallsThisAttempt.push({
                phase: "verifier",
                stalledAfterMs: STALL_TIMEOUT_MS,
                resolution: "escalated",
              });
              log("verifier", "stderr", `✗ verifier stalled twice — escalating`);
              nodeStatus("verifier", "error");
              escalate(
                taskId,
                `STALLED: verifier produced no output twice (waited ${STALL_TIMEOUT_MS / 1000}s each)`,
                log,
                emit
              );
              return;
            }
            log("verifier", "stderr", `✗ VERIFY FAILED (post-retry) — ${errorMsg(retryErr)}`);
            nodeStatus("verifier", "error");
            escalate(
              taskId,
              `Verifier failed on attempt ${attempt} (after salvage retry): ${errorMsg(retryErr)}`,
              log,
              emit
            );
            return;
          }
        } else {
          log("verifier", "stderr", `✗ VERIFY FAILED — ${errorMsg(err)}`);
          nodeStatus("verifier", "error");
          escalate(
            taskId,
            `Verifier failed on attempt ${attempt}: ${errorMsg(err)}`,
            log,
            emit
          );
          return;
        }
      }

      let { verdict } = parseStateDiff(stateAfterVerify);
      // Final verifier_progress event (done: true) so the UI freezes
      // the live score, then tear down the streaming subscription.
      // We do this BEFORE the `!verdict` early-return so the cleanup
      // always runs even if the parse failed.
      if (verdict) {
        const walk = applyNodeTagFallback(verdict.criteriaWalk);
        broadcaster.broadcast(taskId, {
          type: "verifier_progress",
          taskId,
          attempt: verdict.attempt,
          passed: walk.filter((c) => c.passed).length,
          total: walk.length,
          partial: walk,
          done: true,
        });
        // Final per-node score breakdown (done: true) so the canvas
        // badges freeze on the same number as the live progress card.
        const groups = groupCriteriaByNode(walk);
        for (const [nodeId, counts] of Object.entries(groups)) {
          broadcaster.broadcast(taskId, {
            type: "node_score",
            taskId,
            attempt: verdict.attempt,
            nodeId,
            passed: counts.passed,
            total: counts.total,
            score: scaleScoreOutOf10(counts.passed, counts.total),
            done: true,
          });
        }
      }
      unsubscribeLiveProgress?.();
      unsubscribeLiveProgress = null;
      if (!verdict) {
        log(
          "verifier",
          "stderr",
          "✗ verifier wrote STATE.md but no Verifier Verdict section was found"
        );
        nodeStatus("verifier", "error");
        escalate(
          taskId,
          `Verifier output on attempt ${attempt} had no Verdict section`,
          log,
          emit
        );
        return;
      }

      // ─── Gap #4 (2026-07-12-snake-run-diagnosis): an EMPTY criteria walk
      // becomes a "0/0 criteria pass" false-REJECT — the verifier judged a
      // page the runtime check already proved clean, but its walk didn't
      // parse. When the plan HAS criteria and the walk parsed empty,
      // re-invoke the verifier once with an explicit format reminder and
      // prefer the retry's verdict if its walk parses. On any retry
      // failure, keep the original verdict — never worse than before.
      const planCriteriaCount = getTask(taskId)?.plan?.criteria.length ?? 0;
      if (verdict.criteriaWalk.length === 0 && planCriteriaCount > 0) {
        log(
          "verifier",
          "stderr",
          `⟳ verdict has 0/${planCriteriaCount} parseable criteria — re-invoking verifier with format reminder (salvage 1/1)`
        );
        const strictPrompt =
          verifierPrompt +
          [
            "",
            "",
            "=== FORMAT REMINDER (your previous verdict was unparseable) ===",
            "",
            "Your previous reply's **Criteria walk:** section was empty or in",
            "the wrong format. You MUST include, under `**Criteria walk:**`,",
            "EXACTLY one line per completion criterion from GOAL.md, in this",
            "exact checkbox form:",
            "- [x] <criterion text> — <one-line evidence>",
            "- [ ] <criterion text> — FAILED: <one-line reason>",
            `There are ${planCriteriaCount} criteria — emit ${planCriteriaCount} lines.`,
          ].join("\n");
        try {
          const strictVerifier = spawnVerifier(
            taskId,
            task.workdir,
            strictPrompt,
            log,
            verifierTarget.model,
            verifierTarget.connection,
            attempt
          );
          const stateRetry = await withStallWatchdog(
            awaitPhaseOutput(watcher, "STATE.md", strictVerifier, PHASE_TIMEOUT_MS, taskId),
            strictVerifier,
            "verifier"
          );
          const reparsed = parseStateDiff(stateRetry).verdict;
          if (reparsed && reparsed.criteriaWalk.length > 0) {
            verdict = reparsed;
            stateAfterVerify = stateRetry;
            log(
              "verifier",
              "info",
              `✓ retry verdict parsed ${reparsed.criteriaWalk.length} criteria`
            );
          } else {
            log(
              "verifier",
              "stderr",
              "✗ criteria walk still empty after retry — keeping first verdict"
            );
          }
        } catch (retryErr) {
          if (isCancelled(taskId)) return;
          log(
            "verifier",
            "stderr",
            `✗ criteria-walk retry failed (${errorMsg(retryErr)}) — keeping first verdict`
          );
        }
      }

      updateTask(taskId, { verdict });
      appendHistory(
        taskId,
        "verifying",
        `Verdict: ${verdict.outcome}${verdict.outcome === "REJECT" ? ` — ${verdict.oneLineReason}` : ""}`
      );
      broadcaster.broadcast(taskId, { type: "verdict", taskId, verdict });
      broadcaster.broadcast(taskId, {
        type: "task_update",
        taskId,
        task: getTask(taskId)!,
      });
      // AFTER task_update — refinements must outlive the UI's re-derive.
      nodeStatus(
        "verifier",
        verdict.outcome === "APPROVE" ? "success" : "error"
      );
      nodeStatus("verdict", "running");
      log("verifier", "stdout", `✓ VERDICT ${verdict.outcome} — ${verdict.oneLineReason}`);
      verifierEndMs = Date.now();

      // ─── Append the AttemptRecord for this cycle (Task 1: per-attempt
      // timeline). The record captures what just happened regardless of
      // what the DECIDE block does next — APPROVE / ESCALATE / REJECT all
      // land in the timeline so the UI can show the full history. We
      // patch attempts as a NEW array (immutable append) so the shallow
      // spread in updateTask doesn't drop unrelated fields.
      appendAttemptRecord(taskId, attempt, {
        makerMs: makerEndMs && makerStartMs ? makerEndMs - makerStartMs : undefined,
        runtimeCheckMs:
          runtimeEndMs && runtimeStartMs ? runtimeEndMs - runtimeStartMs : undefined,
        verifierMs:
          verifierEndMs && verifierStartMs ? verifierEndMs - verifierStartMs : undefined,
        filesChanged: diff?.filesChanged,
        runtimeResult: runtime
          ? {
              passed: runtime.ok,
              consoleErrorCount: runtime.consoleErrors.length,
              pageErrorCount: runtime.pageErrors.length,
              screenshotRelPath: runtime.screenshotPath
                ? `.loop/${runtime.screenshotPath.split("/").pop()}`
                : null,
            }
          : undefined,
        verifierVerdict: verdict.outcome as VerdictOutcome,
        // Best-so-far signal: count of passed `**Criteria walk:**` lines.
        // Used by the script-loop exit to pick the highest-scoring attempt
        // when no APPROVE was reached inside maxAttempts. Falls back to 0
        // when the criteria walk was unparseable (parser still tolerated it).
        score: verdict.criteriaWalk.filter((c) => c.passed).length,
        rejectReason: verdict.oneLineReason,
        artifactPaths: {
          maker: `.loop/maker-attempt-${attempt}-raw.md`,
          runtimeJson: `.loop/runtime-attempt-${attempt}.json`,
          runtimePng: `.loop/runtime-attempt-${attempt}.png`,
          verifier: `.loop/verifier-attempt-${attempt}-raw.md`,
        },
        validation: validationOutcome ?? undefined,
        // ponytail: Task 1 watchdog events — only set when the watchdog
        // actually fired this attempt (empty array still satisfies the
        // WS payload but is omitted so old attempts don't gain the field).
        stalls: stallsThisAttempt.length > 0 ? stallsThisAttempt : undefined,
        // Task 3: build/test stage results — only for project-shaped
        // workdirs; static tasks never gain the field.
        buildRun: buildRun ? toBuildRunRecord(buildRun) : undefined,
        completedAt: new Date().toISOString(),
      });

      // ─── Stuck-loop detector (Task 4). On REJECT, compare the just-
      // appended attempt against the previous one. If they changed the
      // same files AND got the same reject reason AND (if both ran the
      // runtime check) had the same error signature, the LLM is stuck
      // — short-circuit by escalating now instead of burning the
      // remaining retries on identical failures. The attempt record is
      // tagged stuckDetected so the UI can label it. The max-attempts
      // cap stays as the outer bound; this detector only ever
      // escalates EARLIER, never extends the loop.
      if (verdict.outcome === "REJECT") {
        const t = getTask(taskId);
        const all = t?.attempts ?? [];
        const prev = all.find((a) => a.attemptNumber === attempt - 1);
        const curr = all.find((a) => a.attemptNumber === attempt);
        if (prev && curr && isStuckRepeat(prev, curr)) {
          markAttemptStuck(taskId, attempt);
          log(
            "orchestrator",
            "stderr",
            `✗ STUCK — attempt ${attempt} repeated attempt ${attempt - 1} (identical diff + errors); escalating now`
          );
          escalate(
            taskId,
            `STUCK: attempt ${attempt} repeated attempt ${attempt - 1} (identical diff and errors)`,
            log,
            emit
          );
          return;
        }
      }

      // ─── Phase 4: DECIDE ─────────────────────────────────────────────
      if (verdict.outcome === "APPROVE") {
        // Register a preview in case the runtime check didn't run (e.g.
        // resume path that jumped straight to verifying). Same restart
        // detection as the post-maker path — if the server is dead and
        // needs a re-bind, log it so the Live Preview link in the UI
        // doesn't silently point at a dead port.
        if (!getTask(taskId)?.previewUrl) {
          try {
            const bindsBefore = getPreviewServerBindCount();
            const previewUrl = await registerPreview(taskId, initialTask.workdir);
            if (getPreviewServerBindCount() > bindsBefore) {
              log(
                "orchestrator",
                "info",
                "↻ preview server restarted — re-registering preview URL"
              );
            }
            updateTask(taskId, { previewUrl });
          } catch { /* preview is best-effort */ }
        }
        emit("done", "Verifier APPROVE — loop complete");
        broadcaster.broadcast(taskId, {
          type: "done",
          taskId,
          summary: `Task approved on attempt ${attempt}.`,
        });
        nodeStatus("verdict", "success");
        nodeStatus("done", "success");
        if (getTask(taskId)?.previewUrl) nodeStatus("live_preview", "success");
        log("orchestrator", "info", `■ DONE — approved attempt ${attempt}`);
        return;
      }

      if (verdict.outcome === "ESCALATE_HUMAN") {
        updateTask(taskId, { escalationReason: verdict.oneLineReason });
        emit("escalated", `Escalated: ${verdict.oneLineReason}`);
        broadcaster.broadcast(taskId, {
          type: "escalation",
          taskId,
          reason: verdict.oneLineReason,
        });
        nodeStatus("verdict", "error");
        nodeStatus("escalated", "error");
        log("orchestrator", "info", `■ ESCALATED — ${verdict.oneLineReason}`);
        return;
      }

      // REJECT — block for user feedback before the next attempt.
      // Runtime errors are the highest-signal feedback there is — always
      // carry them into the next maker attempt, merged with any user text.
      if (runtime && !runtime.ok) {
        const auto = [
          "AUTOMATED RUNTIME FEEDBACK (headless browser, previous attempt):",
          ...runtime.pageErrors.map((e) => `- uncaught: ${e}`),
          ...runtime.consoleErrors.map((e) => `- console.error: ${e}`),
          "Fix these errors first.",
        ].join("\n");
        const existing = LAST_FEEDBACK.get(taskId);
        LAST_FEEDBACK.set(taskId, existing ? `${existing}\n\n${auto}` : auto);
      }

      // ─── Script-loop auto-exit (no human in the loop) ───────────────
      // For script workdirs, the score is the decision input. No user
      // feedback wait — the loop is autonomous: either the script is
      // good enough (score >= threshold → done) or it isn't (score <
      // threshold → auto-continue with the failed criteria as feedback
      // for the next maker attempt). The threshold defaults to 7/10
      // (≈ F1+F2+F3 plus one more) and is overridable via
      // LOOP_SCRIPT_MIN_SCORE. The user sees the live /10 score in
      // the ProgressNode header and the per-attempt criteria walk; the
      // loop just keeps grinding until the bar is met or max attempts
      // is hit (at which point best-so-far kicks in below).
      if (isScriptWorkdir(getTask(taskId)?.plan)) {
        const passCount = verdict.criteriaWalk.filter((c) => c.passed).length;
        const totalCriteria = verdict.criteriaWalk.length;
        const scaledScore = scaleScoreOutOf10(passCount, totalCriteria);
        const threshold = SCRIPT_LOOP_MIN_SCORE_OUT_OF_10;
        const failedCriteria = verdict.criteriaWalk.filter((c) => !c.passed);
        if (scaledScore >= threshold) {
          const summary = `Script approved with score ${scaledScore}/10 (${passCount}/${totalCriteria} criteria pass) on attempt ${attempt}.`;
          log(
            "orchestrator",
            "info",
            `■ SCRIPT DONE — score ${scaledScore}/10 (>= threshold ${threshold}/10) on attempt ${attempt}`
          );
          emit("done", summary);
          broadcaster.broadcast(taskId, { type: "done", taskId, summary });
          nodeStatus("verdict", "success");
          nodeStatus("done", "success");
          return;
        }
        // Below threshold — auto-continue. Synthesize a feedback message
        // that lists the failed criteria so the next maker attempt has a
        // concrete target to fix. Don't wait for the user; the loop is
        // autonomous in this mode.
        const failedList = failedCriteria
          .map((c, i) => `${i + 1}. ${c.criterion} — ${c.evidence || "no evidence"}`)
          .join("\n");
        const scriptFeedback = [
          `SCORE ${scaledScore}/10 (below threshold ${threshold}/10) — auto-retry.`,
          `Failed criteria (${failedCriteria.length}/${totalCriteria}):`,
          failedList || "(all criteria passed but score below threshold — check rubric alignment)",
          "Raise the score by addressing the failed criteria above.",
        ].join("\n");
        LAST_FEEDBACK.set(taskId, scriptFeedback);
        nodeStatus("verdict", "error");
        nodeStatus("retry", "running");
        log(
          "orchestrator",
          "info",
          `▶ SCRIPT AUTO-CONTINUE — score ${scaledScore}/10 < threshold ${threshold}/10; ${failedCriteria.length} failed criteria; attempt ${attempt + 1} next`
        );
        // Fall through to the next iteration of the while loop. No
        // `waitForEvent("feedback")` — the loop is autonomous.
      } else {
        nodeStatus("verdict", "waiting");
        nodeStatus("retry", "waiting");
      log(
        "orchestrator",
        "info",
        `⏸ REJECT — awaiting user feedback before attempt ${attempt + 1}`
      );
      const feedbackResult = (await waitForEvent(taskId, "feedback")) as
        | { feedback?: string }
        | undefined;
      if (isCancelled(taskId)) {
        log("orchestrator", "info", "■ loop cancelled while waiting for feedback");
        return;
      }
      const userFeedback =
        feedbackResult && typeof feedbackResult.feedback === "string"
          ? feedbackResult.feedback
          : "";
      if (userFeedback.length > 0) {
        log(
          "orchestrator",
          "info",
          `▶ user feedback received (${userFeedback.length} chars) — retrying`
        );
        // Stash the feedback so the next iteration's maker prompt can include
        // it. Kept in a module-level Map (see LAST_FEEDBACK at the top of this
        // file) — don't put it on the task object, since updateTask replaces
        // it and the mutation would be lost.
        LAST_FEEDBACK.set(taskId, userFeedback);
      } else {
        log("orchestrator", "info", "▶ auto-continue triggered");
      }
      // Feedback received (or auto-continue) — the Retry? gate said "yes".
      nodeStatus("retry", "success");
      } // end else (non-script user-feedback wait)
    }

    // Max attempts exhausted.
    //
    // Script-loop tasks (plan = [script.md]) get the best-so-far exit:
    // pick the attempt with the highest criteriaWalk pass-count and
    // emit `done` with a score-trace summary. This is intentional —
    // the rubric is graded, not pass/fail, so "no APPROVE" doesn't mean
    // "no usable artifact" the way it does for a build-and-test task.
    // The user still has a chance to reject via the UI; they just get a
    // concrete candidate to look at instead of an empty hand-off.
    //
    // All other tasks keep the original behavior: escalate.
    const finalTask = getTask(taskId);
    if (isScriptWorkdir(finalTask?.plan) && finalTask?.attempts?.length) {
      const sorted = [...finalTask.attempts].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0)
      );
      const best = sorted[0];
      // NOTE: AttemptRecord carries the raw pass count, not the walk total
      // (the parser computes but discards the total). We scale to /10 here
      // for the user-facing summary; the per-attempt cards in the UI render
      // the full criteria walk.
      const passCount = best.score ?? 0;
      const scaled = scaleScoreOutOf10(passCount, 7);
      const summary = `Returned best-so-far (attempt ${best.attemptNumber}, score ${scaled}/10 — ${passCount}/7 criteria pass) — no attempt hit threshold ${SCRIPT_LOOP_MIN_SCORE_OUT_OF_10}/10 within max attempts. See per-attempt criteria walk in STATE.md.`;
      log(
        "orchestrator",
        "info",
        `■ BEST-SO-FAR — attempt ${best.attemptNumber} (${scaled}/10 = ${passCount}/7 pass); emitting done`
      );
      emit("done", summary);
      broadcaster.broadcast(taskId, { type: "done", taskId, summary });
      nodeStatus("done", "success");
      return;
    }
    // Max attempts exhausted — escalate (non-script tasks)
    nodeStatus("retry", "error");
    const reason = `Exceeded max ${getTask(taskId)?.maxAttempts} attempts without APPROVE.`;
    escalate(taskId, reason, log, emit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the user stopped the loop, stopLoop already set status + broadcast.
    // Don't overwrite it with an "escalated" status.
    if (!isCancelled(taskId)) {
      appendLog(taskId, "system", "error", `Loop crashed: ${message}`);
      broadcaster.broadcast(taskId, { type: "error", taskId, message });
      setStatus(taskId, "escalated", `Crashed: ${message}`);
      const t = getTask(taskId);
      if (t) {
        broadcaster.broadcast(taskId, { type: "task_update", taskId, task: t });
      }
    }
  } finally {
    watcher.stop();
    killAgent(taskId);
    ACTIVE_LOOPS.delete(taskId);
    LAST_FEEDBACK.delete(taskId);
    clearPendingResolvers(taskId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase output helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for a phase's expected file change, racing against the agent's exit
 * (in case the agent died before writing) and against cancellation.
 *
 * Returns the new content of `filename`. Throws on:
 *   - Phase timeout (no file change within `timeoutMs`)
 *   - Agent exit without writing the file (no generation advance, even after
 *     a grace period for chokidar to deliver the change event)
 *   - Task cancellation while waiting
 *
 * Why the grace period: chokidar's fsevent on macOS can lag the fs write by
 * 100–300ms, the watcher's awaitWriteFinish stability check adds another
 * ~250–350ms on top, and readFile adds a few ms. The bridge agents write
 * their output and exit within ~10ms, so exitPromise reliably wins the race
 * and this grace path is the normal path for them. We give the watcher
 * 1500ms after agent exit before declaring failure — long enough for
 * fsevents + stability polling + readFile, short enough that a real crash
 * escalates within a couple of seconds of the agent actually dying.
 */
async function awaitPhaseOutput(
  watcher: FileWatcher,
  filename: WatchedFile,
  agent: AgentHandle,
  timeoutMs: number,
  taskId: string
): Promise<string> {
  const startGen = watcher.getGeneration(filename);
  const filePromise = watcher.awaitChange(filename, timeoutMs);
  // exitPromise resolves with `number | null` (the agent's exit code, or null
  // if killed by signal). filePromise resolves with `string` (the new content).
  const exitPromise = agent.exited;
  const cancelPromise = makeCancelPromise(taskId);

  const winner = await Promise.race([filePromise, exitPromise, cancelPromise]);

  // Cancellation — surface immediately.
  if (isCancelled(taskId)) {
    throw new Error("task cancelled");
  }

  // File change won the race.
  if (typeof winner === "string") {
    return winner;
  }

  // Agent exited. Give chokidar a short grace period to deliver the change
  // event before we conclude the agent died without writing.
  await sleep(POST_EXIT_GRACE_MS);
  const endGen = watcher.getGeneration(filename);
  if (endGen > startGen) {
    const content = watcher.getLatestContent(filename);
    // Empty content is never a valid phase output (GOAL.md carries a plan,
    // STATE.md is scaffolded before any append) — treat it the same as "no
    // write" so the run escalates loudly instead of parsing an empty plan
    // into "0 steps, 0 files".
    if (content !== null && content.length > 0) {
      return content;
    }
  }
  throw new Error(
    `agent exited with code ${winner} before writing ${filename}`
  );
}

/** Grace period after agent exit, in ms, before declaring the agent crashed. */
const POST_EXIT_GRACE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a promise that rejects when the task transitions to `cancelled` (or is
 * deleted). Polls `getTask` at a coarse interval — we don't need fine-grained
 * resolution because cancellation is a deliberate user action.
 */
function makeCancelPromise(taskId: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const tick = () => {
      if (isCancelled(taskId)) {
        reject(new Error("task cancelled"));
        return;
      }
      setTimeout(tick, CANCEL_POLL_MS);
    };
    setTimeout(tick, CANCEL_POLL_MS);
  });
}

function isCancelled(taskId: string): boolean {
  const t = getTask(taskId);
  return !t || t.status === "cancelled";
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn helpers — wrap spawnAgent with the right agent role + log binding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Connection for a model id, if any. Returns null for built-in
 * model ids (`provider/model-name`), since those have no user-configured
 * routing. Returns the live Connection record for `custom:<connId>:<id>`
 * ids so the spawner can inject the API key + write the config fragment.
 * Returns null if the connection has been deleted since the task was
 * created (orchestrator surfaces this as an early escalation).
 */
function resolveConnectionForModel(
  model: string | undefined
): Connection | null {
  if (!model) return null;
  const resolved = resolveConnectionModel(model);
  return resolved?.connection ?? null;
}

function spawnPlanner(
  taskId: string,
  workdir: string,
  prompt: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  model: string | undefined,
  connection: Connection | null,
  attempt: number
): AgentHandle {
  return spawnAgent(
    "planner",
    taskId,
    workdir,
    prompt,
    (line) => log("planner", "stdout", line),
    (line) => log("planner", "stderr", line),
    (code) => log("planner", "stdout", `agent exited with code ${code}`),
    { model, connection, attempt }
  );
}

function spawnMaker(
  taskId: string,
  workdir: string,
  prompt: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  model: string | undefined,
  connection: Connection | null,
  attempt: number
): AgentHandle {
  return spawnAgent(
    "maker",
    taskId,
    workdir,
    prompt,
    (line) => log("maker", "stdout", line),
    (line) => log("maker", "stderr", line),
    (code) => log("maker", "stdout", `agent exited with code ${code}`),
    { model, connection, attempt }
  );
}

function spawnVerifier(
  taskId: string,
  workdir: string,
  prompt: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  model: string | undefined,
  connection: Connection | null,
  attempt: number
): AgentHandle {
  return spawnAgent(
    "verifier",
    taskId,
    workdir,
    prompt,
    (line) => log("verifier", "stdout", line),
    (line) => log("verifier", "stderr", line),
    (code) => log("verifier", "stdout", `agent exited with code ${code}`),
    { model, connection, attempt }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

/** Inline the task's reference files into a prompt section. Missing files
 *  become a one-line note instead of an error — the task should still run. */
async function readTaskContextFiles(task: Task): Promise<string> {
  const paths = task.contextFiles ?? [];
  if (paths.length === 0) return "";
  const PER_FILE_CAP = 20_000;
  const TOTAL_CAP = 60_000;
  let total = 0;
  const parts: string[] = ["", "=== Reference context files (read-only, from the user's codebase) ===", ""];
  for (const p of paths) {
    if (total >= TOTAL_CAP) { parts.push(`(remaining files skipped — ${TOTAL_CAP} byte budget reached)`); break; }
    try {
      let content = await readFile(pathResolve(p), "utf8");
      if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + "\n…(truncated)";
      total += content.length;
      parts.push(`--- ${p} ---`, "", content, "");
    } catch {
      parts.push(`--- ${p} --- (could not read; proceed without it)`, "");
    }
  }
  return parts.join("\n");
}

function buildPlannerPrompt(taskPrompt: string, anchorsBlock: string = ""): string {
  // Script-loop path: when anchors were retrieved, the planner does NOT
  // explore the codebase — it pastes the anchors + draft into GOAL.md
  // and writes the rubric. The rubric prompts (loop-planner.md) know to
  // look in `## Notes for the maker` for the anchors + draft.
  if (anchorsBlock) {
    return [
      `Task: ${taskPrompt}`,
      "",
      "You are running in SCRIPT-OPTIMIZATION mode. Do NOT explore the codebase — the draft and the top-performing past posts (anchors) are in your user prompt. Write GOAL.md as a rubric-driven plan per .opencode/agents/loop-planner.md, with the anchors and draft pasted verbatim into `## Notes for the maker`. Do not return a PLAN READY summary — the script-loop orchestrator does not consume one.",
      "",
      "---",
      "",
      "ANCHORS (top performers by save_rate; the orchestrator retrieved these deterministically — do not edit, do not invent numbers):",
      "",
      anchorsBlock,
    ].join("\n");
  }
  return [
    `Task: ${taskPrompt}`,
    "",
    "Read GOAL.md (it currently contains the template at the project root), explore the codebase, and write your plan into GOAL.md. Replace the placeholder sections with your concrete plan.",
    "When you finish, return a short summary in this format:",
    "PLAN READY",
    "- Steps: N",
    "- Files to touch: <list>",
    "- Criteria: N",
    "- Risks: <list or \"none\">",
    "- Notes: <any ambiguity or assumption>",
  ].join("\n");
}

/**
 * Prompt for re-planning after the user requested an adjustment. Includes
 * the previous plan and the user's feedback so the planner can either
 * adopt the feedback or push back with a reasoned counter-proposal.
 */
function buildAdjustPlannerPrompt(
  taskPrompt: string,
  adjustments: string,
  existingGoal: string
): string {
  return [
    `Task: ${taskPrompt}`,
    "",
    "The user reviewed your previous plan and asked for these adjustments:",
    "```",
    adjustments,
    "```",
    "",
    "Your previous plan (GOAL.md):",
    "```",
    existingGoal,
    "```",
    "",
    "Read the existing GOAL.md, apply the user's feedback, and rewrite the plan. If the user's feedback conflicts with what you found in the codebase, push back — note the conflict in `## Notes for the maker` so the user can decide.",
    "When you finish, return the same summary format as the initial plan:",
    "PLAN READY",
    "- Steps: N",
    "- Files to touch: <list>",
    "- Criteria: N",
    "- Risks: <list or \"none\">",
    "- Notes: <any ambiguity or assumption, including any pushback on the user's feedback>",
  ].join("\n");
}

function buildMakerPrompt(
  attempt: number,
  maxAttempts: number,
  goalContent: string,
  stateContent: string | null,
  userFeedback: string | undefined,
  anchorsBlock: string = ""
): string {
  // Script-loop path: the rubric (F1–F7) and the anchors + draft are
  // already in GOAL.md → Notes (the planner pasted them). The maker
  // rewriter prompt just needs the standard scaffolding + a reminder
  // to apply F1–F7 and emit the script as a ```file:script.md``` block.
  if (anchorsBlock) {
    const parts: string[] = [];
    parts.push(`Attempt ${attempt} of ${maxAttempts}.`);
    parts.push("");
    parts.push("Plan (from GOAL.md):");
    parts.push("```");
    parts.push(goalContent);
    parts.push("```");
    parts.push("");
    if (stateContent) {
      parts.push("Current state (from STATE.md):");
      parts.push("```");
      parts.push(stateContent);
      parts.push("```");
      parts.push("");
    }
    if (userFeedback) {
      parts.push("User feedback from the previous REJECT verdict:");
      parts.push("```");
      parts.push(userFeedback);
      parts.push("```");
      parts.push("");
    }
    parts.push(
      "Apply the rubric F1–F7 from GOAL.md → Completion Criteria to rewrite the draft. " +
        "Delay the tool/mechanism reveal to the 8–15s mark. " +
        "Emit the script as ONE fenced block — the bridge saves it to script.md and appends a Diff Summary:\n" +
        "\n" +
        "```file:script.md\n" +
        "[0-3s] <hook — lead with the outcome>\n" +
        "[3-8s] <escalate the payoff; withhold the how>\n" +
        "[8-15s] <reveal the tool/mechanism>\n" +
        "[15s+] <save-worthy takeaway + soft save cue>\n" +
        "```\n" +
        "\n" +
        "No commentary outside the code block. Touch ONLY script.md."
    );
    return parts.join("\n");
  }
  const parts: string[] = [];
  parts.push(`Attempt ${attempt} of ${maxAttempts}.`);
  parts.push("");
  parts.push("Plan (from GOAL.md):");
  parts.push("```");
  parts.push(goalContent);
  parts.push("```");
  parts.push("");
  if (stateContent) {
    parts.push("Current state (from STATE.md):");
    parts.push("```");
    parts.push(stateContent);
    parts.push("```");
    parts.push("");
  }
  if (userFeedback) {
    parts.push("User feedback from the previous REJECT verdict:");
    parts.push("```");
    parts.push(userFeedback);
    parts.push("```");
    parts.push("");
  }
  parts.push(
    "Implement the plan. Touch only the files in GOAL.md → Files to touch. " +
      "Run the documented build and tests. Then append your diff summary to " +
      "STATE.md under a new heading `## Diff Summary — Attempt " +
      attempt +
      "`."
  );
  return parts.join("\n");
}

/**
 * Cap on per-file content included in the verifier prompt. The full task
 * context (goal + constraints + diff file contents + maker summary) needs to
 * fit in the LLM's input window; 50KB per file keeps a single-file tic-tac-toe
 * game well under the cap and prevents a large accidental commit from blowing
 * the prompt. Files larger than the cap are truncated with a clear marker.
 */
const VERIFIER_FILE_CONTENT_CAP_BYTES = 50_000;

/**
 * Resolve the orchestrator's loop-constraints.md (binding rules every agent
 * must follow). The file lives in the Loop Agent project root, not in the
 * task workdir — the backend's CWD when started by `npm run dev` / `node dist`
 * is the backend directory, so the constraints are one level up. We resolve
 * via process.cwd() to match the rest of the backend (e.g. llm-agent.mjs
 * default path uses the same convention).
 */
async function readLoopConstraints(): Promise<string> {
  const candidates = [
    pathResolve(process.cwd(), "../loop-constraints.md"),
    pathResolve(process.cwd(), "loop-constraints.md"),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return "(loop-constraints.md not found — verification is unconstrained)";
}

/**
 * Read each file in the diff's `filesChanged` list so the verifier LLM has
 * the actual content in its prompt (it has no tool access in the bridge
 * runner). Files are read from the workdir; if a file is unreadable we
 * surface the error as the content so the verifier can flag it rather than
 * silently rubber-stamping.
 */
async function readDiffFileContents(
  workdir: string,
  paths: string[]
): Promise<string> {
  if (paths.length === 0) return "(diff.filesChanged is empty — nothing to inspect)";
  const blocks: string[] = [];
  for (const rel of paths) {
    const full = pathResolve(workdir, rel);
    let content: string;
    let truncated = false;
    try {
      const buf = await readFile(full, "utf8");
      if (buf.length > VERIFIER_FILE_CONTENT_CAP_BYTES) {
        content = buf.slice(0, VERIFIER_FILE_CONTENT_CAP_BYTES);
        truncated = true;
      } else {
        content = buf;
      }
    } catch (err) {
      content = `<unreadable: ${err instanceof Error ? err.message : String(err)}>`;
    }
    const tail = truncated
      ? `\n\n[... truncated at ${VERIFIER_FILE_CONTENT_CAP_BYTES} bytes; full file is longer]`
      : "";
    blocks.push(`### ${rel}\n\n\`\`\`\n${content}${tail}\n\`\`\``);
  }
  return blocks.join("\n\n");
}

/**
 * Build the verifier's user prompt. The verifier LLM runs in the bridge
 * runner with no read_file / bash / build tools, so we pre-load everything
 * it needs into the prompt itself:
 *   1. The plan (GOAL.md) — task, criteria, file allowlist/denylist
 *   2. The binding constraints (loop-constraints.md) — denylist, max retries
 *   3. The maker's diff summary (latest STATE.md after the maker ran)
 *   4. The actual contents of every file in diff.filesChanged
 *
 * The verifier's system prompt (in llm-agent.mjs) tells it the bridge has
 * done this; we make it true here. Without this, the verifier was producing
 * confused REJECTs complaining about missing context.
 */
async function buildVerifierPrompt(
  attempt: number,
  goalContent: string,
  stateContent: string,
  workdir: string,
  diff: { filesChanged: { path: string }[] } | null,
  runtimeEvidence: string | null = null
): Promise<string> {
  const constraints = await readLoopConstraints();
  const diffFiles = await readDiffFileContents(
    workdir,
    (diff?.filesChanged ?? []).map((f) => f.path)
  );

  return [
    `Attempt ${attempt}.`,
    "",
    "=== GOAL.md (plan + criteria + allowlist) ===",
    "",
    goalContent,
    "",
    "=== loop-constraints.md (binding rules) ===",
    "",
    constraints,
    "",
    "=== STATE.md (maker's diff summary, latest state) ===",
    "",
    stateContent,
    "",
    "=== Diff file contents (from diff.filesChanged in STATE.md) ===",
    "",
    diffFiles,
    "",
    "=== Runtime check (headless browser ACTUALLY executed the prototype) ===",
    "",
    runtimeEvidence ??
      "Runtime check unavailable this attempt — judge from source, and say so in your verdict.",
    "",
    "=== Your task ===",
    "",
    "Walk the completion criteria in GOAL.md one by one. Check scope (every",
    "changed file is in the allowlist, no denylist hits), intent (the diff",
    "addresses the task), tests/build (or for vanilla deliverables: that the",
    "file is well-formed), and no-cheating (no skipped tests, no swallowed",
    "errors, no type-suppression hacks).",
    "",
    "Your verdict MUST include a `**Criteria walk:**` section with EXACTLY",
    "one checkbox line per completion criterion from GOAL.md, in this exact",
    "format (the orchestrator parses these lines mechanically — a missing or",
    "reformatted walk is treated as an unparseable verdict and retried):",
    "- [x] <criterion text> — <one-line evidence>",
    "- [ ] <criterion text> — FAILED: <one-line reason>",
    "",
    "RUNTIME EVIDENCE IS AUTHORITATIVE: if the runtime check section above",
    "shows ANY uncaught page error or console error, you MUST return REJECT",
    "and quote the exact error text in Required fixes — regardless of how",
    "correct the source looks. If the runtime check shows no errors, weigh",
    "that as strong evidence the prototype loads and basic interactions work.",
    "",
    `Append your verdict to STATE.md under a new heading \`## Verifier Verdict — Attempt ${attempt}\`.`,
    "Follow the format your system prompt specifies. The bridge will append",
    "your reply to STATE.md without modification — do not include prose",
    "before or after the verdict block.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractAdjustments(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const adjustments = (value as { adjustments?: unknown }).adjustments;
  return typeof adjustments === "string" ? adjustments : "";
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the model + connection for a particular role in one shot. The
 * connection is looked up only after the final model id is picked, since
 * the per-role override (if set) takes precedence over the task default —
 * and a different model might be a different connection (or none). Returns
 * `{ model, connection }` where `connection` is non-null only when the
 * resolved model id belongs to a user-configured Connection.
 */
function resolveSpawnTarget(
  task: Pick<Task, "model" | "modelOverrides">,
  role: "planner" | "maker" | "verifier"
): { model: string | undefined; connection: Connection | null } {
  const key = modelOverrideKeyForRole(role);
  const model = task.modelOverrides?.[key] ?? task.model;
  const connection = model ? resolveConnectionForModel(model) : null;
  return { model, connection };
}

/**
 * Pick a DIFFERENT healthy connection that can serve `role` (Part C #2 of
 * 2026-07-12-snake-run-diagnosis). Candidates come from the connections
 * store, dedicated-to-role first then general-use, keyed connections only.
 * Connections whose last health check failed are skipped — the point of
 * failover is routing AROUND a dead endpoint, not onto another known-dead
 * one. Returns null when no alternative exists (caller escalates, exactly
 * the pre-failover behavior).
 */
function pickFailoverTarget(
  role: "planner" | "maker" | "verifier",
  excludeConnectionId: string | undefined
): { model: string; connection: Connection } | null {
  const key = modelOverrideKeyForRole(role);
  for (const conn of connectionsForRole(key)) {
    if (conn.id === excludeConnectionId) continue;
    if (conn.health && !conn.health.ok) continue;
    const model = defaultModelIdForConnection(conn);
    if (!model) continue;
    return { model, connection: conn };
  }
  return null;
}

/**
 * Pre-flight (Part D1): before spawning an agent on a connection, make
 * sure its health is fresh and ok — re-testing now if the last check is
 * stale or failed. On failure, fail over to a different healthy
 * connection for the role; only report un-spawnable when none exists.
 * Env-key targets (no connection) pass through untouched — there is
 * nothing to probe. This turns the v2/v3 "burn a 4-minute stall window
 * on a dead endpoint" failure into a seconds-fast reroute or a loud,
 * named escalation.
 */
async function preflightSpawnTarget(
  role: "planner" | "maker" | "verifier",
  target: { model: string | undefined; connection: Connection | null },
  log: LogFn
): Promise<
  | { ok: true; target: { model: string | undefined; connection: Connection | null } }
  | { ok: false; reason: string }
> {
  if (!target.connection) return { ok: true, target };
  let health;
  try {
    health = await ensureFreshHealth(target.connection);
  } catch (err) {
    health = {
      ok: false,
      error: errorMsg(err),
      checkedAt: new Date().toISOString(),
    };
  }
  if (health.ok) return { ok: true, target };
  log(
    "orchestrator",
    "stderr",
    `✗ pre-flight: connection "${target.connection.name}" is unhealthy (${
      health.error ?? "unknown error"
    }) — looking for a failover`
  );
  const failover = pickFailoverTarget(role, target.connection.id);
  if (failover) {
    log(
      "orchestrator",
      "info",
      `▶ pre-flight failover: ${role} rerouted to connection "${failover.connection.name}" (${failover.model})`
    );
    return { ok: true, target: failover };
  }
  return {
    ok: false,
    reason: `connection "${target.connection.name}" is unhealthy: ${
      health.error ?? "unknown error"
    } (no alternative connection serves the ${modelOverrideKeyForRole(role)} role)`,
  };
}

/** Back-compat for any callers we haven't updated — only the model id. */
function resolveModel(
  defaultModel: string | undefined,
  overrides: Task["modelOverrides"],
  role: "planner" | "maker" | "verifier"
): string | undefined {
  const key = modelOverrideKeyForRole(role);
  return overrides?.[key] ?? defaultModel ?? undefined;
}

type LogFn = (a: AgentRole, s: LogLevel, t: string) => void;
type EmitFn = (status: TaskStatus, message?: string) => void;

/**
 * Append one AttemptRecord to a task's `attempts` array. Immutable: reads
 * the current array, appends, writes a fresh array via updateTask so the
 * shallow spread in updateTask doesn't drop any sibling fields. If the
 * task already has a record with the same `attemptNumber` (e.g. a resume
 * replays a cycle), the new record REPLACES the old one for that
 * attempt — the resume is the authoritative version.
 *
 * Called from the runLoop after each verifier cycle, regardless of
 * outcome (APPROVE / REJECT / ESCALATE_HUMAN all land in the timeline).
 */
function appendAttemptRecord(
  taskId: string,
  attemptNumber: number,
  fields: Omit<AttemptRecord, "attemptNumber" | "completedAt"> & {
    completedAt?: string;
  }
): void {
  const t = getTask(taskId);
  if (!t) return;
  const existing = t.attempts ?? [];
  const filtered = existing.filter((a) => a.attemptNumber !== attemptNumber);
  const next: AttemptRecord = {
    ...fields,
    attemptNumber,
    completedAt: fields.completedAt ?? new Date().toISOString(),
  };
  updateTask(taskId, {
    attempts: [...filtered, next].sort((a, b) => a.attemptNumber - b.attemptNumber),
  });
  // updateTask's task_update broadcast already covers WS subscribers.
}

/**
 * Strip build-runner internals (outputDir is a server-local absolute
 * path) down to the persisted/broadcast BuildRunRecord shape (Task 3).
 */
function toBuildRunRecord(
  run: BuildRunResult
): NonNullable<AttemptRecord["buildRun"]> {
  return {
    installMs: run.installMs,
    buildMs: run.buildMs,
    testMs: run.testMs,
    buildExit: run.buildExit,
    testExit: run.testExit,
    failedStage: run.failedStage,
    outputTail: run.outputTail,
  };
}

/**
 * Stuck-loop detector. Two consecutive attempts are "stuck" when they
 * changed the same set of files AND the verifier rejected with the same
 * reason AND (if both ran the runtime check) the runtime error signature
 * matches. This is the cheap, deterministic short-circuit for the
 * "LLM is making the same mistake forever" failure mode — without it,
 * the loop burns all 3 attempts on identical outputs and only then
 * escalates.
 *
 * Returns true if `curr` repeats `prev` exactly enough to look stuck.
 * The match is conservative (all three signals must align) so we don't
 * false-positive on legitimately-different attempts that happen to
 * touch the same files.
 */
function isStuckRepeat(prev: AttemptRecord, curr: AttemptRecord): boolean {
  // 1. Same set of changed file paths (order-insensitive). A no-op diff
  //    on one side but not the other is NOT a repeat — the LLM might
  //    be making progress in some direction. require both sides to
  //    have at least one file change.
  const prevFiles = (prev.filesChanged ?? []).map((f) => f.path).sort();
  const currFiles = (curr.filesChanged ?? []).map((f) => f.path).sort();
  if (prevFiles.length === 0) return false;
  if (prevFiles.join("\u0000") !== currFiles.join("\u0000")) return false;

  // 2. Same verifier reject reason (verbatim).
  if ((prev.rejectReason ?? "") !== (curr.rejectReason ?? "")) return false;

  // 3. Same runtime error signature. If one side didn't run the
  //    runtime check (e.g. it short-circuited via validation, or
  //    crashed before reaching it) and the other did, that's a
  //    different path and NOT a repeat.
  const hasRuntime = (a: AttemptRecord) => Boolean(a.runtimeResult);
  if (hasRuntime(prev) !== hasRuntime(curr)) return false;
  if (hasRuntime(prev) && hasRuntime(curr)) {
    const prevSig = [
      prev.runtimeResult!.pageErrorCount,
      prev.runtimeResult!.consoleErrorCount,
      prev.runtimeResult!.passed ? "1" : "0",
    ].join("|");
    const currSig = [
      curr.runtimeResult!.pageErrorCount,
      curr.runtimeResult!.consoleErrorCount,
      curr.runtimeResult!.passed ? "1" : "0",
    ].join("|");
    if (prevSig !== currSig) return false;
  }

  return true;
}

/**
 * Mark an attempt as stuckDetected in the timeline. Reads the current
 * attempts array, finds the matching record, and writes it back with
 * the flag flipped. Independent of appendAttemptRecord because we only
 * know a cycle is stuck AFTER it has been appended (we need the
 * previous attempt's record to compare against).
 */
function markAttemptStuck(taskId: string, attemptNumber: number): void {
  const t = getTask(taskId);
  if (!t || !t.attempts) return;
  let mutated = false;
  const next = t.attempts.map((a) => {
    if (a.attemptNumber === attemptNumber && !a.stuckDetected) {
      mutated = true;
      return { ...a, stuckDetected: true };
    }
    return a;
  });
  if (mutated) {
    updateTask(taskId, { attempts: next });
  }
}

function escalate(
  taskId: string,
  reason: string,
  log: LogFn,
  emit: EmitFn
): void {
  // Point the user at the per-attempt artifacts so they can see exactly
  // what each LLM said before extraction touched it. First place to
  // look when a phase produced an unparseable file.
  const hinted = `${reason} — raw LLM outputs + runtime artifacts: ${getTask(taskId)?.workdir ?? "<workdir>"}/.loop/`;
  updateTask(taskId, { escalationReason: hinted });
  emit("escalated", hinted);
  broadcaster.broadcast(taskId, { type: "escalation", taskId, reason: hinted });
  // Light up the terminal canvas node for every escalation path (module-
  // level function, so no access to runLoop's nodeStatus closure).
  broadcaster.broadcast(taskId, {
    type: "node_status",
    taskId,
    nodeId: "escalated",
    status: "error",
  });
  log("orchestrator", "info", `■ ESCALATED — ${hinted}`);
}