import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  createTask,
  getActiveTask,
  getTask,
  listTasks,
  removeTask,
  resolveEvent,
  toTaskSummary,
} from "../store/tasks.js";
import { runLoop, stopLoop, isLoopRunning, resumeLoop, resetTask, rePrompt } from "../loop/orchestrator.js";
import { isActiveStatus } from "../store/persistence.js";
import { broadcaster } from "../ws/broadcaster.js";
import { resolveConnectionModel } from "../store/connections.js";
import { anyBatchRunning } from "../loop/batch-runner.js";
import type { CreateTaskBody, ConfirmPlanBody, FeedbackBody } from "../types.js";

const createSchema = z.object({
  prompt: z.string().min(3, "prompt required (≥3 chars)"),
  title: z.string().optional(),
  workdir: z.string().optional(),
  autoApprovePlan: z.boolean().optional(),
  model: z.string().optional(),
  modelOverrides: z
    .object({
      planning: z.string().optional(),
      implementation: z.string().optional(),
      review: z.string().optional(),
    })
    .optional(),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  contextFiles: z.array(z.string()).max(10).optional(),
});

const confirmSchema = z.object({
  adjustments: z.string().optional(),
});

const feedbackSchema = z.object({
  feedback: z.string().min(1, "feedback required"),
});

const rePromptSchema = z.object({
  prompt: z.string().min(3, "prompt required (≥3 chars)"),
});

export const tasksApi = new Hono();

tasksApi.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// List
tasksApi.get("/tasks", (c) => {
  return c.json({ tasks: listTasks().map(toTaskSummary) });
});

/**
 * Gap #1 (2026-07-12-snake-run-diagnosis): fail task creation LOUDLY when
 * no role can resolve to a usable connection, instead of letting the
 * planner crash two seconds later with "Missing api key". For each agent
 * role, the effective model is `modelOverrides[role] ?? model`. A role is
 * unusable when:
 *   - no model is set AND the LOOP_LLM_API_KEY env fallback is absent
 *     (the bridge runner would spawn with an empty key), or
 *   - the model is a `custom:` id whose connection is gone or key-less.
 * Returns a human-readable problem string, or null when every role can
 * authenticate.
 */
export function connectionProblemForTask(body: Pick<CreateTaskBody, "model" | "modelOverrides"> & Partial<CreateTaskBody>): string | null {
  const roles = [
    ["planner", "planning"],
    ["maker", "implementation"],
    ["verifier", "review"],
  ] as const;
  const problems: string[] = [];
  for (const [agent, key] of roles) {
    const model = body.modelOverrides?.[key] ?? body.model;
    if (!model) {
      if (!process.env.LOOP_LLM_API_KEY) {
        problems.push(
          `no connection configured for ${agent} (${key}) — pick a model/connection or set LOOP_LLM_API_KEY`
        );
      }
      continue;
    }
    if (model.startsWith("custom:")) {
      const resolved = resolveConnectionModel(model);
      if (!resolved) {
        problems.push(
          `${agent} (${key}) uses model "${model}" but its connection no longer exists`
        );
      } else if (
        resolved.connection.providerType !== "mavis-cli" &&
        !resolved.connection.apiKey
      ) {
        // mavis-cli connections never have an apiKey — they authenticate
        // via the user's already-logged-in Mavis daemon, not a portable key.
        problems.push(
          `${agent} (${key}) uses connection "${resolved.connection.name}" which has no API key set`
        );
      }
      continue;
    }
    // Curated model id — the bridge runner still authenticates with
    // LOOP_LLM_API_KEY (no per-connection key to fall back on).
    if (!process.env.LOOP_LLM_API_KEY) {
      problems.push(
        `${agent} (${key}) uses built-in model "${model}" but LOOP_LLM_API_KEY is not set — use a connection-backed model or set the env key`
      );
    }
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

// Create + start
tasksApi.post("/tasks", zValidator("json", createSchema), async (c) => {
  const body = c.req.valid("json") as CreateTaskBody;

  // Fail fast on unusable model/connection configuration (gap #1).
  const connectionProblem = connectionProblemForTask(body);
  if (connectionProblem) {
    return c.json({ error: connectionProblem }, 400);
  }

  // Single-active-task enforcement: if a task is mid-loop, refuse the new
  // one with a 409 + a pointer to the active task. Plan recommends this to
  // keep the orchestrator state machine simple and prevent two loops from
  // racing on the same workdir / GOAL.md / STATE.md files.
  if (anyBatchRunning()) {
    return c.json({ error: "a batch is running — wait for it or cancel it first" }, 409);
  }
  const active = getActiveTask();
  if (active) {
    return c.json(
      {
        error: "another task is currently active",
        activeTask: { id: active.id, status: active.status, title: active.title },
      },
      409
    );
  }

  const task = createTask({
    prompt: body.prompt,
    title: body.title,
    workdir: body.workdir,
    model: body.model,
    modelOverrides: body.modelOverrides,
    projectId: body.projectId,
    sessionId: body.sessionId,
    contextFiles: body.contextFiles,
    autoApprovePlan: body.autoApprovePlan,
  });
  broadcaster.broadcast(task.id, { type: "task_update", taskId: task.id, task });
  // Kick off the loop asynchronously
  void runLoop(task.id).catch(() => {
    /* errors already broadcast inside runLoop */
  });
  return c.json({ task }, 201);
});

// Get
tasksApi.get("/tasks/:id", (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json({ task });
});

// Stop — works for ANY active status (planning / plan_review /
// implementing / verifying). The orchestrator's `stopLoop` clears any
// pending resolvers (so waitForEvent unblocks) and SIGTERMs the live
// agent subprocess if any. We check `isActiveStatus` rather than
// `isLoopRunning` because during plan_review the orchestrator is parked
// in waitForEvent and NOT in the ACTIVE_LOOPS set — the old guard
// returned 400 even though the user clearly sees the loop as "running".
tasksApi.post("/tasks/:id/stop", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  if (!isActiveStatus(task.status)) {
    return c.json(
      { error: `task is ${task.status}, nothing to stop` },
      400
    );
  }
  stopLoop(id);
  return c.json({ ok: true });
});

// Resume — continue a previously stopped (or escalated) task from where
// it was. The orchestrator picks the appropriate resume point based on
// what state was preserved (plan + diff present → go to verifying; plan
// only → plan_review; nothing → draft). Attempt counter is preserved.
tasksApi.post("/tasks/:id/resume", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "task not found" }, 404);
  if (isLoopRunning(id)) {
    return c.json({ error: "loop is already running" }, 409);
  }
  const ok = resumeLoop(id);
  if (!ok) {
    const t = getTask(id);
    return c.json(
      {
        error: `task in status "${t?.status ?? "unknown"}" cannot be resumed (must be cancelled or escalated)`,
      },
      400
    );
  }
  return c.json({ ok: true });
});

// Reset — clear plan/diff/verdict/history and start a fresh loop from
// scratch. Attempt counter increments. Returns 400 if the task has
// already hit its max-attempts cap (user would need to raise the cap).
tasksApi.post("/tasks/:id/reset", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "task not found" }, 404);
  if (isLoopRunning(id)) {
    return c.json({ error: "loop is already running" }, 409);
  }
  const ok = resetTask(id);
  if (!ok) {
    const t = getTask(id);
    return c.json(
      {
        error:
          t?.status === "escalated" && (t.attempt ?? 0) >= (t.maxAttempts ?? 0)
            ? "Reset cap reached (max attempts)"
            : `task in status "${t?.status ?? "unknown"}" cannot be reset`,
      },
      400
    );
  }
  return c.json({ ok: true });
});

// Confirm plan → unblock the orchestrator
tasksApi.post("/tasks/:id/confirm-plan", zValidator("json", confirmSchema), (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "plan_review") {
    return c.json({ error: `task is in ${task.status}, not plan_review` }, 400);
  }
  const body = c.req.valid("json") as ConfirmPlanBody;
  resolveEvent(id, "confirm-plan", { adjustments: body.adjustments ?? "" });
  return c.json({ ok: true });
});

// Adjust plan → unblock the orchestrator and trigger a re-spawn of the
// planner agent. The orchestrator's Phase 1 confirm/adjust loop handles
// the rest — see backend/src/loop/orchestrator.ts.
tasksApi.post("/tasks/:id/adjust-plan", zValidator("json", confirmSchema), (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "plan_review") {
    return c.json({ error: `task is in ${task.status}, not plan_review` }, 400);
  }
  const body = c.req.valid("json") as ConfirmPlanBody;
  const adjustments = body.adjustments?.trim() ?? "";
  if (!adjustments) {
    return c.json(
      { error: "adjustments required for adjust-plan" },
      400
    );
  }
  resolveEvent(id, "adjust-plan", { adjustments });
  return c.json({ ok: true });
});

// Send feedback after REJECT → unblock the orchestrator
tasksApi.post("/tasks/:id/feedback", zValidator("json", feedbackSchema), (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "verifying" && task.status !== "escalated") {
    // be lenient — verifier rejects then state stays in verifying. Allow both.
  }
  const body = c.req.valid("json") as FeedbackBody;
  const ok = resolveEvent(id, "feedback", { feedback: body.feedback });
  if (!ok) return c.json({ error: "no pending feedback wait" }, 400);
  return c.json({ ok: true });
});

// Re-prompt — overwrite the active task's prompt and re-spawn the loop with
// the same taskId. Increments attempt counter. Reuses `orchestrator.rePrompt()`.
tasksApi.post("/tasks/:id/re-prompt", zValidator("json", rePromptSchema), (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status === "done") {
    return c.json({ error: "task already done — assign a new task" }, 409);
  }
  const { prompt } = c.req.valid("json");
  const ok = rePrompt(id, prompt);
  if (!ok) {
    return c.json({ error: "could not re-prompt task" }, 500);
  }
  const updated = getTask(id);
  return c.json({ ok: true, attempt: updated?.attempt ?? 0 });
});

// Delete — stops the loop if running, removes the row, and broadcasts
// `task_deleted` so the UI can clean up its card + chat thread + sidebar.
tasksApi.delete("/tasks/:id", (c) => {
  const id = c.req.param("id");
  if (isLoopRunning(id)) stopLoop(id);
  const removed = removeTask(id);
  if (!removed) return c.json({ error: "task not found" }, 404);
  broadcaster.broadcast(id, { type: "task_deleted", taskId: id });
  return c.json({ ok: true });
});