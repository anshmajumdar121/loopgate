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
import type { AttemptRecord, VerdictOutcome } from "../types.js";
import { resolveConnectionModel } from "../store/connections.js";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────────────

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
        : buildPlannerPrompt(initialTask.prompt)) + contextBlock;
      const plannerTarget = resolveSpawnTarget(initialTask, "planner");
      const planner = spawnPlanner(
        taskId,
        initialTask.workdir,
        plannerPrompt,
        log,
        plannerTarget.model,
        plannerTarget.connection
      );

      const goalContent = await awaitPhaseOutput(
        watcher,
        "GOAL.md",
        planner,
        PHASE_TIMEOUT_MS,
        taskId
      );
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

      nodeStatus("planner", "success");
      broadcaster.broadcast(taskId, { type: "plan_ready", taskId, plan });
      broadcaster.broadcast(taskId, {
        type: "task_update",
        taskId,
        task: getTask(taskId)!,
      });
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
        nodeStatus("maker", "running");
        makerStartMs = Date.now();

        const latestState = watcher.getLatestContent("STATE.md");
        const feedback = LAST_FEEDBACK.get(taskId);
        const makerPrompt = buildMakerPrompt(
          attempt,
          task.maxAttempts,
          latestGoal,
          latestState,
          feedback
        ) + (await readTaskContextFiles(initialTask));
        const makerTarget = resolveSpawnTarget(task, "maker");
        const maker = spawnMaker(
          taskId,
          task.workdir,
          makerPrompt,
          log,
          makerTarget.model,
          makerTarget.connection
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
          `Diff: ${diff.filesChanged.length} files, build exit ${diff.buildExit}, tests ${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`
        );
        broadcaster.broadcast(taskId, { type: "diff_ready", taskId, diff });
        nodeStatus("maker", "success");
        broadcaster.broadcast(taskId, {
          type: "task_update",
          taskId,
          task: getTask(taskId)!,
        });
        log(
          "maker",
          "stdout",
          `✓ IMPLEMENT — ${diff.filesChanged.length} files changed, build exit ${diff.buildExit}`
        );
        makerEndMs = Date.now();

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
          const previewUrl = await registerPreview(taskId, initialTask.workdir);
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
      }

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
      const verifierTarget = resolveSpawnTarget(task, "verifier");
      const verifier = spawnVerifier(
        taskId,
        task.workdir,
        verifierPrompt,
        log,
        verifierTarget.model,
        verifierTarget.connection
      );

      let stateAfterVerify: string;
      try {
        stateAfterVerify = await awaitPhaseOutput(
          watcher,
          "STATE.md",
          verifier,
          PHASE_TIMEOUT_MS,
          taskId
        );
      } catch (err) {
        if (isCancelled(taskId)) {
          // stopLoop already set status + broadcast — nothing more to do.
          return;
        }
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

      const { verdict } = parseStateDiff(stateAfterVerify);
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

      updateTask(taskId, { verdict });
      appendHistory(
        taskId,
        "verifying",
        `Verdict: ${verdict.outcome}${verdict.outcome === "REJECT" ? ` — ${verdict.oneLineReason}` : ""}`
      );
      broadcaster.broadcast(taskId, { type: "verdict", taskId, verdict });
      nodeStatus(
        "verifier",
        verdict.outcome === "APPROVE" ? "success" : "error"
      );
      broadcaster.broadcast(taskId, {
        type: "task_update",
        taskId,
        task: getTask(taskId)!,
      });
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
        rejectReason: verdict.oneLineReason,
        artifactPaths: {
          maker: `.loop/maker-attempt-${attempt}-raw.md`,
          runtimeJson: `.loop/runtime-attempt-${attempt}.json`,
          runtimePng: `.loop/runtime-attempt-${attempt}.png`,
          verifier: `.loop/verifier-attempt-${attempt}-raw.md`,
        },
        validation: validationOutcome ?? undefined,
        completedAt: new Date().toISOString(),
      });

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
      nodeStatus("verdict", "waiting");
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
    }

    // Max attempts exhausted — escalate
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
  connection: Connection | null
): AgentHandle {
  return spawnAgent(
    "planner",
    taskId,
    workdir,
    prompt,
    (line) => log("planner", "stdout", line),
    (line) => log("planner", "stderr", line),
    (code) => log("planner", "stdout", `agent exited with code ${code}`),
    { model, connection }
  );
}

function spawnMaker(
  taskId: string,
  workdir: string,
  prompt: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  model: string | undefined,
  connection: Connection | null
): AgentHandle {
  return spawnAgent(
    "maker",
    taskId,
    workdir,
    prompt,
    (line) => log("maker", "stdout", line),
    (line) => log("maker", "stderr", line),
    (code) => log("maker", "stdout", `agent exited with code ${code}`),
    { model, connection }
  );
}

function spawnVerifier(
  taskId: string,
  workdir: string,
  prompt: string,
  log: (a: AgentRole, s: LogLevel, t: string) => void,
  model: string | undefined,
  connection: Connection | null
): AgentHandle {
  return spawnAgent(
    "verifier",
    taskId,
    workdir,
    prompt,
    (line) => log("verifier", "stdout", line),
    (line) => log("verifier", "stderr", line),
    (code) => log("verifier", "stdout", `agent exited with code ${code}`),
    { model, connection }
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

function buildPlannerPrompt(taskPrompt: string): string {
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
  userFeedback: string | undefined
): string {
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
  log("orchestrator", "info", `■ ESCALATED — ${hinted}`);
}