import { join, resolve } from "node:path";
import type { Task, TaskStatus } from "../../types.js";
import {
  SQLiteEventLog,
  type ItemRecord,
  type RunRecord,
} from "./event-log.js";
import type { ItemStatus } from "./state-machine.js";

export const V2_ENGINE_NAME = "v2" as const;

/** The feature flag is read at call time so tests and isolated demo processes
 * can choose an engine without reloading the module graph. */
export function isV2EngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOP_ENGINE?.trim().toLowerCase() === V2_ENGINE_NAME;
}

export function resolveEventLogPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.LOOP_EVENT_LOG_PATH?.trim()) {
    return resolve(env.LOOP_EVENT_LOG_PATH);
  }
  const dataDir = env.LOOP_DATA_DIR?.trim() || resolve(process.cwd(), "data", "tasks");
  return resolve(dataDir, "..", "loop-events.sqlite");
}

interface V2Ids {
  runId: string;
  itemId: string;
}

function idsForTask(taskId: string): V2Ids {
  return { runId: `run:${taskId}`, itemId: `item:${taskId}` };
}

function runStatusForTask(status: TaskStatus): string {
  switch (status) {
    case "draft":
      return "queued";
    case "done":
      return "approved";
    case "escalated":
      return "escalated";
    case "cancelled":
      return "cancelled";
    case "planning":
    case "plan_review":
    case "implementing":
    case "verifying":
      return "running";
    default:
      return "failed";
  }
}

function targetItemStatus(status: TaskStatus): ItemStatus {
  switch (status) {
    case "draft":
      return "queued";
    case "planning":
    case "plan_review":
      return "planning";
    case "implementing":
      return "making";
    case "verifying":
      return "verifying";
    case "done":
      return "approved";
    case "escalated":
      return "escalated";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

/**
 * Shadow adapter that gives the legacy loop a durable v2 run/item model.
 * The legacy loop remains responsible for user-visible behavior in Phase A;
 * this adapter records its lifecycle and is the seam Phase B workers replace.
 */
export class V2RunModel {
  constructor(
    private readonly log: SQLiteEventLog,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  ensureTask(task: Task): { run: RunRecord; item: ItemRecord } {
    const ids = idsForTask(task.id);
    const run = this.log.ensureRun({
      id: ids.runId,
      status: runStatusForTask(task.status),
      metadata: { taskId: task.id, title: task.title },
    });
    const item = this.log.ensureItem({
      id: ids.itemId,
      runId: ids.runId,
      metadata: { taskId: task.id, workdir: task.workdir },
    });
    this.sync(task);
    return {
      run: this.log.getRun(run.id) ?? run,
      item: this.log.getItem(item.id) ?? item,
    };
  }

  sync(task: Task): ItemRecord {
    const ids = idsForTask(task.id);
    const item = this.log.getItem(ids.itemId);
    if (!item) {
      throw new Error(`v2 item ${ids.itemId} is missing; call ensureTask first`);
    }

    let state = this.log.rebuildItemState(ids.itemId);

    // The legacy task model keeps a rejected verdict while it re-enters
    // implementing. Preserve that important edge in the v2 event stream.
    if (
      state.status === "verifying" &&
      task.status === "implementing" &&
      task.verdict?.outcome === "REJECT"
    ) {
      this.log.appendItemTransition({
        itemId: ids.itemId,
        to: "rejected",
        occurredAt: task.updatedAt || this.now(),
        reason: task.verdict.oneLineReason,
      });
      state = this.log.rebuildItemState(ids.itemId);
    }

    const target = targetItemStatus(task.status);
    this.advance(ids.itemId, state.status, target, task);
    this.log.setRunStatus({
      runId: ids.runId,
      status: runStatusForTask(task.status),
      occurredAt: task.updatedAt || this.now(),
      metadata: { taskStatus: task.status },
    });
    return this.log.getItem(ids.itemId)!;
  }

  private advance(
    itemId: string,
    startingStatus: ItemStatus,
    target: ItemStatus,
    task: Task
  ): void {
    let status = startingStatus;
    while (status !== target) {
      const next = nextStatusToward(status, target);
      if (!next) {
        // A terminal event may already be ahead of a stale JSON task record;
        // do not invent a second terminal transition.
        return;
      }
      this.log.appendItemTransition({
        itemId,
        to: next,
        occurredAt: task.updatedAt || this.now(),
        reason: `legacy task status: ${task.status}`,
      });
      status = next;
    }
  }
}

function nextStatusToward(
  current: ItemStatus,
  target: ItemStatus
): ItemStatus | undefined {
  if (current === target) return undefined;
  if (target === "cancelled" || target === "failed") return target;
  if (current === "queued") return "planning";
  if (current === "planning") return "making";
  if (current === "making") return "checking";
  if (current === "checking") return "verifying";
  if (current === "rejected") return "making";
  if (current === "verifying" && ["approved", "rejected", "escalated"].includes(target)) {
    return target;
  }
  return undefined;
}

const eventLogs = new Map<string, SQLiteEventLog>();

export function getV2EventLog(
  env: NodeJS.ProcessEnv = process.env
): SQLiteEventLog {
  const path = resolveEventLogPath(env);
  const existing = eventLogs.get(path);
  if (existing) return existing;
  const created = new SQLiteEventLog(path);
  eventLogs.set(path, created);
  return created;
}

export function closeV2EventLogs(): void {
  for (const log of eventLogs.values()) log.close();
  eventLogs.clear();
}

export async function runLoopV2(
  taskId: string,
  legacyRunner: (taskId: string) => Promise<void>,
  options: { pollMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  const { getTask } = await import("../../store/tasks.js");
  const initial = getTask(taskId);
  if (!initial) return;

  const model = new V2RunModel(getV2EventLog(options.env));
  model.ensureTask(initial);
  const pollMs = Math.max(5, options.pollMs ?? 25);
  const timer = setInterval(() => {
    const current = getTask(taskId);
    if (current) {
      try {
        model.sync(current);
      } catch (error) {
        console.error(`[loop-v2] failed to project ${taskId}:`, error);
      }
    }
  }, pollMs);
  timer.unref?.();

  try {
    await legacyRunner(taskId);
  } finally {
    clearInterval(timer);
    const finalTask = getTask(taskId);
    if (finalTask) model.sync(finalTask);
  }
}
