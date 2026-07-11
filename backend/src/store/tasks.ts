import { nanoid } from "nanoid";
import { mkdir } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { LogEntry, Task, TaskStatus } from "../types.js";
import {
  deleteTaskFile,
  isActiveStatus,
  saveTask,
  TASK_DATA_DIR,
} from "./persistence.js";

interface Store {
  tasks: Map<string, Task>;
  pendingResolvers: Map<string, Map<string, (value: unknown) => void>>;
}

const store: Store = {
  tasks: new Map(),
  pendingResolvers: new Map(),
};

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_WORKDIR =
  process.env.LOOP_WORKDIR || process.cwd();

/**
 * Persist a task to disk. Errors are swallowed and logged — a failed write
 * must never break the in-memory mutation the orchestrator depends on. On
 * restart, the most-recent successful write is what we have; subsequent
 * state changes are lost. This is acceptable for v1 (JSON-file v1
 * persistence); a real DB would transactionally commit both.
 */
function persist(task: Task): void {
  saveTask(task).catch((err) => {
    console.error(`[store] Failed to save task ${task.id}:`, err);
  });
}

export function createTask(input: {
  prompt: string;
  title?: string;
  workdir?: string;
  maxAttempts?: number;
  model?: string;
  modelOverrides?: Task["modelOverrides"];
  projectId?: string;
  sessionId?: string;
  contextFiles?: string[];
  autoApprovePlan?: boolean;
}): Task {
  const id = nanoid(12);
  const now = new Date().toISOString();
  // Strip empty-string entries so a missing override stays `undefined`
  // rather than an empty string (which the spawner would forward as
  // `--model ""` to opencode).
  const overrides = input.modelOverrides
    ? Object.fromEntries(
        Object.entries(input.modelOverrides).filter(
          ([, v]) => typeof v === "string" && v.trim().length > 0
        )
      )
    : undefined;

  // Resolve workdir. Priority: explicit user-provided workdir > derived
  // workspace from (projectId, sessionId) > DEFAULT_WORKDIR (server cwd).
  // Derivation creates a per-(project,session) folder under the data dir so
  // each task's GOAL.md / STATE.md / diff output lives in a place the user
  // can find by project. mkdir -p is fired async — the in-memory task gets
  // the resolved path immediately, the directory shows up on disk shortly
  // after (failures are logged but don't break task creation).
  const projectId = input.projectId?.trim() || undefined;
  const sessionId = input.sessionId?.trim() || undefined;
  const resolvedWorkdir = resolveWorkdir({
    explicit: input.workdir?.trim() || undefined,
    projectId,
    sessionId,
  });

  const task: Task = {
    id,
    title: input.title?.trim() || deriveTitle(input.prompt),
    prompt: input.prompt,
    workdir: resolvedWorkdir,
    status: "draft",
    attempt: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    model: input.model?.trim() || undefined,
    modelOverrides:
      overrides && Object.keys(overrides).length > 0 ? overrides : undefined,
    projectId,
    sessionId,
    contextFiles: input.contextFiles,
    autoApprovePlan: input.autoApprovePlan,
    createdAt: now,
    updatedAt: now,
    history: [],
    logs: [],
  };
  store.tasks.set(id, task);
  persist(task);
  // Best-effort mkdir. We don't await — task creation shouldn't block on
  // disk I/O and the agent will need the directory later when it starts.
  void mkdir(resolvedWorkdir, { recursive: true }).catch((err) => {
    console.error(
      `[tasks] Failed to mkdir workdir ${resolvedWorkdir}:`,
      err
    );
  });
  return task;
}

/**
 * Pick the workdir for a new task. Order:
 *   1. `explicit` — whatever the user typed (treated as authoritative)
 *   2. `<TASK_DATA_DIR>/workspaces/<projectId>/<sessionId>` — derived
 *   3. `<TASK_DATA_DIR>/workspaces/<projectId>` — project-only folder
 *   4. `DEFAULT_WORKDIR` — server cwd (no project/session)
 *
 * The "workspaces/" prefix keeps project work dirs separate from the
 * task metadata files (which live in `tasks/<id>.json`). A user can `cd`
 * into any workspace folder and run their own tools against the agent's
 * output (GOAL.md / STATE.md) without touching the JSON metadata.
 */
function resolveWorkdir(input: {
  explicit: string | undefined;
  projectId: string | undefined;
  sessionId: string | undefined;
}): string {
  if (input.explicit) return input.explicit;
  const root = pathResolve(TASK_DATA_DIR, "workspaces");
  if (input.projectId && input.sessionId) {
    return pathResolve(root, input.projectId, input.sessionId);
  }
  if (input.projectId) {
    return pathResolve(root, input.projectId);
  }
  return DEFAULT_WORKDIR;
}

/**
 * Public read-only form of the resolver — exposes what workdir WOULD be
 * for a given (projectId, sessionId) without writing anything. Used by the
 * frontend to show a placeholder / preview before the user submits.
 */
export function previewWorkdir(
  projectId: string | undefined,
  sessionId: string | undefined
): string {
  return resolveWorkdir({ explicit: undefined, projectId, sessionId });
}

export function getTask(id: string): Task | undefined {
  return store.tasks.get(id);
}

export function listTasks(): Task[] {
  return Array.from(store.tasks.values()).sort(
    (a, b) => (a.createdAt < b.createdAt ? 1 : -1)
  );
}

export function removeTask(id: string): boolean {
  const removed = store.tasks.delete(id);
  if (removed) {
    void deleteTaskFile(id).catch((err) => {
      console.error(`[store] Failed to delete task file ${id}:`, err);
    });
  }
  return removed;
}

export function updateTask(id: string, patch: Partial<Task>): Task | undefined {
  const current = store.tasks.get(id);
  if (!current) return undefined;
  const next: Task = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  store.tasks.set(id, next);
  persist(next);
  return next;
}

/**
 * Returns the in-progress task (status in {planning, plan_review,
 * implementing, verifying}) if any. The plan recommends a single active
 * task at a time; `POST /tasks` uses this to enforce it.
 */
export function getActiveTask(): Task | undefined {
  for (const task of store.tasks.values()) {
    if (isActiveStatus(task.status)) return task;
  }
  return undefined;
}

/**
 * Bulk-load tasks from disk at startup. Replaces any in-memory state.
 * Tasks in active states are transitioned to "escalated" by the recovery
 * function — see `persistence.ts`.
 */
export function loadTasksFromDisk(tasks: Task[]): void {
  store.tasks.clear();
  for (const task of tasks) {
    store.tasks.set(task.id, task);
  }
}

/**
 * Cascade helper: when a project is deleted (or a session), strip the
 * stale pointer from every task that referenced it. We keep tasks alive
 * — they just become "unassigned" (or remain in the project but lose
 * their session).
 *
 * Pass `{projectId}` or `{sessionId}` (or both). Empty string is treated
 * as "don't filter on this key" — only the non-empty keys are used.
 */
export function cleanOrphanTasks(
  by: { projectId?: string; sessionId?: string }
): number {
  let n = 0;
  for (const task of store.tasks.values()) {
    let dirty = false;
    if (
      by.projectId &&
      by.projectId.length > 0 &&
      task.projectId === by.projectId
    ) {
      task.projectId = undefined;
      task.sessionId = undefined;
      dirty = true;
    } else if (
      by.sessionId &&
      by.sessionId.length > 0 &&
      task.sessionId === by.sessionId
    ) {
      task.sessionId = undefined;
      dirty = true;
    }
    if (dirty) {
      task.updatedAt = new Date().toISOString();
      persist(task);
      n++;
    }
  }
  return n;
}

export function appendHistory(id: string, phase: string, message: string): void {
  const task = store.tasks.get(id);
  if (!task) return;
  const entry = { ts: new Date().toISOString(), phase, message };
  task.history = [...task.history, entry];
  task.updatedAt = entry.ts;
  persist(task);
}

export function appendLog(
  id: string,
  agent: LogEntry["agent"],
  stream: LogEntry["stream"],
  text: string
): void {
  const task = store.tasks.get(id);
  if (!task) return;
  const entry: LogEntry = { ts: new Date().toISOString(), agent, stream, text };
  task.logs = [...task.logs, entry];
  // Cap log history to keep memory bounded
  if (task.logs.length > 500) {
    task.logs = task.logs.slice(task.logs.length - 500);
  }
  // Intentionally NOT persisting per log line — see persistence.ts.
  // The most recent logs since the last status save are lost on restart.
}

/** Set a status; returns the new task. Logs to history. */
export function setStatus(id: string, status: TaskStatus, message?: string): Task | undefined {
  const previous = store.tasks.get(id);
  if (!previous) return undefined;
  const next = updateTask(id, { status, updatedAt: new Date().toISOString() });
  appendHistory(id, status, message ?? `status → ${status}`);
  if (next) persist(next);
  return next;
}

/** Resolver plumbing so the orchestrator can `await waitForEvent(task, "confirm-plan")`. */
type EventKind = "confirm-plan" | "adjust-plan" | "feedback" | "stop";

export function waitForEvent(taskId: string, kind: EventKind): Promise<unknown> {
  return new Promise((resolve) => {
    const map =
      store.pendingResolvers.get(taskId) ?? new Map<string, (value: unknown) => void>();
    map.set(kind, resolve);
    store.pendingResolvers.set(taskId, map);
  });
}

export function resolveEvent(taskId: string, kind: EventKind, value: unknown): boolean {
  const map = store.pendingResolvers.get(taskId);
  if (!map) return false;
  const resolver = map.get(kind);
  if (!resolver) return false;
  map.delete(kind);
  resolver(value);
  return true;
}

export function clearPendingResolvers(taskId: string): void {
  const map = store.pendingResolvers.get(taskId);
  if (!map) return;
  for (const [, resolver] of map) {
    try {
      resolver(undefined);
    } catch {
      /* noop */
    }
  }
  map.clear();
  store.pendingResolvers.delete(taskId);
}

function deriveTitle(prompt: string): string {
  const stripped = prompt.trim().replace(/\s+/g, " ");
  if (!stripped) return "Untitled task";
  if (stripped.length <= 60) return stripped;
  return stripped.slice(0, 57).trim() + "…";
}