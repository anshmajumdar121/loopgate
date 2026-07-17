// JSON file persistence for the in-memory task store.
//
// Layout: one JSON file per task at `${DATA_DIR}/${taskId}.json`.
// Atomic writes (write-to-temp + rename) so a crashed write can't leave a
// half-written file behind. Saves are NOT triggered on every `appendLog` —
// log streaming would be too expensive to persist line-by-line. Logs
// captured up to the most recent significant state change survive a restart;
// anything since then is lost (acceptable trade-off for v1).
//
// Crash recovery on startup: only tasks with a live subprocess are touched.
// plan_review is intentionally NOT touched — the orchestrator was idle
// waiting for user approval, no subprocess died. We also reset executing
// tasks back to a sane interactive state (draft or plan_review) instead of
// the old "escalated" dead-end — the user can pick up exactly where they
// were: re-trigger planning for a task in `planning`, or re-approve an
// existing plan for a task that got past planning.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type { Project, Session, Connection, Task, TaskStatus } from "../types.js";
import type { TokenUsageEntry } from "./tokenUsage.js";

const DATA_DIR =
  process.env.LOOP_DATA_DIR || resolve(process.cwd(), "data", "tasks");
const DATA_ROOT = resolve(DATA_DIR, "..");

export const TASK_DATA_DIR = DATA_DIR;

/**
 * States with a live subprocess (opencode CLI / mock) that DIED on
 * restart. Only these get the "escalated / needs manual recovery"
 * treatment — everything else (plan_review in particular) is just user
 * state, no subprocess is involved.
 */
export const EXECUTING_STATUSES: readonly TaskStatus[] = [
  "planning",
  "implementing",
  "verifying",
] as const;

/**
 * States where the loop is observable to the user as "still running"
 * (covers plan_review too — the orchestrator is waiting for the user to
 * approve the plan and the loop hasn't returned control).
 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "planning",
  "plan_review",
  "implementing",
  "verifying",
] as const;

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isExecutingStatus(status: TaskStatus): boolean {
  return EXECUTING_STATUSES.includes(status);
}

/**
 * Load every persisted task from `${DATA_DIR}/*.json`. Returns an empty
 * array if the directory doesn't exist or has no task files. Malformed
 * JSON files are skipped with a console warning — we never want one bad
 * file to prevent the server from booting.
 */
export async function loadAllTasks(): Promise<Task[]> {
  await mkdir(DATA_DIR, { recursive: true });
  const files = await readdir(DATA_DIR).catch(() => [] as string[]);
  const tasks: Task[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    if (file.endsWith(".tmp")) {
      // Stale temp file from an interrupted atomic write — clean it up.
      try {
        await unlink(resolve(DATA_DIR, file));
      } catch {
        /* ignore */
      }
      continue;
    }
    const filePath = resolve(DATA_DIR, file);
    try {
      const content = await readFile(filePath, "utf8");
      const task = JSON.parse(content) as Task;
      if (task && typeof task.id === "string" && typeof task.status === "string") {
        tasks.push(task);
      } else {
        console.warn(`[persistence] Skipping ${file}: missing required fields`);
      }
    } catch (err) {
      console.error(`[persistence] Failed to load ${file}:`, err);
    }
  }
  return tasks;
}

/**
 * Per-task mutex chains. Multiple saveTask() calls for the same taskId are
 * serialised so the .tmp → .json rename doesn't race against a concurrent
 * write that just clobbered the .tmp file. Saves for different taskIds can
 * still run in parallel.
 */
const saveChains = new Map<string, Promise<void>>();

/**
 * Persist a single task atomically. Writes to `<id>.json.tmp` first, then
 * renames to `<id>.json`. If the process crashes mid-write, the rename
 * never happens and the previous good file remains.
 *
 * Concurrent saves for the same taskId are queued through `saveChains`. Two
 * saves fired in the same tick would otherwise race the .tmp → .json rename
 * (save A renames the .tmp out from under save B, leaving B with ENOENT on
 * its rename call).
 */
export async function saveTask(task: Task): Promise<void> {
  const prev = saveChains.get(task.id) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* swallow previous errors so the chain doesn't break */
    })
    .then(() => doSave(task));
  saveChains.set(task.id, next);
  try {
    await next;
  } finally {
    // If this is the tail of the chain, free the entry so the Map doesn't
    // grow unbounded with completed tasks.
    if (saveChains.get(task.id) === next) {
      saveChains.delete(task.id);
    }
  }
}

async function doSave(task: Task): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = resolve(DATA_DIR, `${task.id}.json`);
  const tmpPath = uniqueTmpPath(filePath);
  const content = JSON.stringify(task, null, 2);
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

/** Remove the on-disk JSON for a task. No-op if the file is absent. */
export async function deleteTaskFile(taskId: string): Promise<void> {
  const filePath = resolve(DATA_DIR, `${taskId}.json`);
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code !== "ENOENT"
    ) {
      throw err;
    }
    /* ENOENT: file already gone — fine */
  }
}

/**
 * Mutate loaded tasks to handle server restarts. Two recovery paths:
 *
 * 1. **Executing tasks** (planning / implementing / verifying): these had a
 *    subprocess that died. We DO NOT mark them "escalated" (that was the
 *    v1 dead-end). Instead, reset them to the closest interactive state:
 *    - `planning` (no plan saved yet) → `draft` — user kicks planning again
 *    - `implementing` (had a plan) → `plan_review` — user re-approves and
 *      the loop re-implements from the persisted plan
 *    - `verifying` (had a plan + diff) → `plan_review` — same as above;
 *      the saved diff is preserved as a record but the loop will re-implement
 *      from the same plan
 *
 * 2. **`plan_review` tasks**: left untouched — no subprocess was running.
 *    The user can pick the task up where they left off (the plan panel
 *    already shows the existing plan).
 *
 * 3. **Heals tasks previously escalated with the old "Server restarted
 *    mid-run" reason** — if we can identify them (escalationReason starts
 *    with that exact string and there is no prior escalation log entry
 *    beyond the recovery marker) we apply the same recovery logic. This
 *    fixes tasks stranded by an older backend version on first run after
 *    upgrade.
 *
 * Returns the list of tasks that were transitioned (for logging).
 */
export function recoverFromRestart(tasks: Task[]): Task[] {
  const recovered: Task[] = [];
  for (const task of tasks) {
    const now = new Date().toISOString();
    let nextStatus: TaskStatus | null = null;
    let reason = "";

    if (isExecutingStatus(task.status)) {
      // Branch 1: live subprocess died on restart.
      if (task.status === "planning" && !task.plan) {
        nextStatus = "draft";
        reason = "Restarted while planning — resetting to draft.";
      } else {
        // had a plan (and possibly a diff) — go back to plan_review so the
        // user can re-approve and continue from the persisted plan.
        nextStatus = "plan_review";
        reason =
          "Restarted during implementation/verification — saved plan preserved; re-approve to resume.";
      }
    } else if (
      task.status === "escalated" &&
      task.escalationReason?.startsWith(
        "Server restarted mid-run — manual recovery required"
      )
    ) {
      // Branch 3: heal tasks stranded by the older code path. If the task
      // had a plan, send it back to plan_review; otherwise to draft.
      if (task.plan) {
        nextStatus = "plan_review";
        reason = `Healed from older escalated state — plan preserved.`;
      } else {
        nextStatus = "draft";
        reason = `Healed from older escalated state — no plan to keep.`;
      }
    }
    // plan_review + done + cancelled + draft: nothing to do.

    if (nextStatus) {
      task.status = nextStatus;
      task.escalationReason = undefined;
      task.history = [
        ...task.history,
        {
          ts: now,
          phase: nextStatus,
          message: reason,
        },
      ];
      task.updatedAt = now;
      recovered.push(task);
    }
  }
  return recovered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects + Sessions — single-file JSON persistence (small, low write rate)
// ─────────────────────────────────────────────────────────────────────────────
//
// Lives in DATA_ROOT (e.g. `backend/data/`), one level above the per-task
// directory. Keeping them out of `DATA_DIR` means loadAllTasks() never sees
// them in its directory scan, so the per-task loader can stay strictly
// task-shaped without needing to filter out metadata files.

const PROJECTS_FILE = resolve(DATA_ROOT, "_projects.json");
const SESSIONS_FILE = resolve(DATA_ROOT, "_sessions.json");

/**
 * Load all projects from disk. Returns [] when the file is missing or
 * corrupt. The leading underscore in the filename also makes the intent
 * obvious if you ever `ls` the data directory.
 */
export async function loadAllProjects(): Promise<Project[]> {
  await mkdir(DATA_ROOT, { recursive: true });
  try {
    const content = await readFile(PROJECTS_FILE, "utf8");
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return [];
    return arr as Project[];
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return [];
    }
    console.error("[persistence] Failed to load projects:", err);
    return [];
  }
}

export async function loadAllSessions(): Promise<Session[]> {
  await mkdir(DATA_ROOT, { recursive: true });
  try {
    const content = await readFile(SESSIONS_FILE, "utf8");
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return [];
    return arr as Session[];
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return [];
    }
    console.error("[persistence] Failed to load sessions:", err);
    return [];
  }
}

/**
 * Atomic write of the full projects / sessions arrays. We rewrite the
 * whole array on every mutation — the writes are infrequent (user
 * creates maybe one project per minute in a real workflow) so this is
 * cheaper than juggling per-entity files.
 */
export async function saveProjects(projects: Project[]): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const tmp = uniqueTmpPath(PROJECTS_FILE);
  await writeFile(tmp, JSON.stringify(projects, null, 2), "utf8");
  await rename(tmp, PROJECTS_FILE);
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const tmp = uniqueTmpPath(SESSIONS_FILE);
  await writeFile(tmp, JSON.stringify(sessions, null, 2), "utf8");
  await rename(tmp, SESSIONS_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections — user-configured external API endpoints (one file, like
// projects + sessions; rewrites are infrequent and the array is small)
// ─────────────────────────────────────────────────────────────────────────────

const CONNECTIONS_FILE = resolve(DATA_ROOT, "_connections.json");

/**
 * Load all connections from disk. Returns [] when the file is missing or
 * corrupt. Like projects/sessions, the leading underscore keeps the intent
 * obvious if someone `ls` the data directory.
 */
export async function loadAllConnections(): Promise<Connection[]> {
  await mkdir(DATA_ROOT, { recursive: true });
  try {
    const content = await readFile(CONNECTIONS_FILE, "utf8");
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return [];
    return arr as Connection[];
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return [];
    }
    console.error("[persistence] Failed to load connections:", err);
    return [];
  }
}

export async function saveConnections(
  connections: Connection[]
): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const tmp = uniqueTmpPath(CONNECTIONS_FILE);
  await writeFile(tmp, JSON.stringify(connections, null, 2), "utf8");
  await rename(tmp, CONNECTIONS_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Token usage — one file, like connections; rewrites are infrequent (only
// after an LLM call completes) and the array is small (one entry per
// distinct model id we've ever seen).
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_USAGE_FILE = resolve(DATA_ROOT, "_token_usage.json");

/**
 * Load all token-usage entries from disk. Returns [] when the file is
 * missing or corrupt.
 */
export async function loadAllTokenUsage(): Promise<TokenUsageEntry[]> {
  await mkdir(DATA_ROOT, { recursive: true });
  try {
    const content = await readFile(TOKEN_USAGE_FILE, "utf8");
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) return [];
    return arr as TokenUsageEntry[];
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return [];
    }
    console.error("[persistence] Failed to load token usage:", err);
    return [];
  }
}

export async function saveTokenUsage(
  entries: TokenUsageEntry[]
): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true });
  const tmp = uniqueTmpPath(TOKEN_USAGE_FILE);
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
  await rename(tmp, TOKEN_USAGE_FILE);
}

/**
 * Per-call unique temp path for the write-then-rename pattern above.
 * A fixed `${path}.tmp` name races when two saves of the SAME file land
 * concurrently (observed: parallel connection-health checks each calling
 * saveConnections — one call's rename() found the other's tmp file
 * already moved, ENOENT). PID + a monotonic counter is enough; two calls
 * in the same tick of the same process still get distinct names.
 */
let tmpCounter = 0;
function uniqueTmpPath(path: string): string {
  return `${path}.tmp-${process.pid}-${++tmpCounter}`;
}