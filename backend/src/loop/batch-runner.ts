// Map node runner: loops one prompt template over N items. Each item is an
// ordinary task (plan → make → verify, independent verifier, approval gate,
// enforced write policy) run with autoApprovePlan + autoIterate, so the
// whole batch proceeds without a human until an item exhausts its attempts
// — that item is marked escalated and the batch moves on. Items run one at a
// time (the orchestrator is single-active-task); progress is checkpointed
// after every transition, so restart → resume picks up at the first
// unfinished item and never redoes completed ones.

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runLoop, stopLoop } from "./orchestrator.js";
import { createTask, getTask } from "../store/tasks.js";
import { broadcaster } from "../ws/broadcaster.js";
import {
  type Batch,
  getBatch,
  listBatches,
  renderPrompt,
  saveBatches,
  updateBatch,
  updateBatchItem,
} from "../store/batches.js";

const RUNNING = new Set<string>();
const CANCELLED = new Set<string>();

function emit(batch: Batch | undefined) {
  if (!batch) return;
  broadcaster.broadcastAll({ type: "batch_update", batchId: batch.id, batch });
}

export function isBatchRunning(id: string): boolean {
  return RUNNING.has(id);
}

export function anyBatchRunning(): boolean {
  return RUNNING.size > 0;
}

export async function runBatch(batchId: string): Promise<void> {
  if (RUNNING.has(batchId)) return;
  const batch = getBatch(batchId);
  if (!batch) return;
  RUNNING.add(batchId);
  CANCELLED.delete(batchId);
  emit(updateBatch(batchId, { status: "running" }));
  try {
    for (const item of batch.items) {
      if (CANCELLED.has(batchId)) break;
      if (item.status !== "pending" && item.status !== "running") continue; // checkpoint: skip finished
      const task = createTask({
        prompt: renderPrompt(batch.promptTemplate, item),
        title: `${batch.title} [${item.index + 1}/${batch.items.length}]`,
        workdir: join(batch.workdirRoot, `item-${String(item.index + 1).padStart(3, "0")}`),
        model: batch.model,
        modelOverrides: batch.modelOverrides,
        maxAttempts: batch.maxAttempts,
        autoApprovePlan: true,
        autoIterate: true,
        batchId,
      });
      broadcaster.broadcast(task.id, { type: "task_update", taskId: task.id, task });
      emit(updateBatchItem(batchId, item.index, { status: "running", taskId: task.id, startedAt: new Date().toISOString(), reason: undefined }));

      try {
        await runLoop(task.id);
      } catch (err) {
        // runLoop broadcasts its own errors; record and move on.
        updateBatchItem(batchId, item.index, { reason: err instanceof Error ? err.message : String(err) });
      }

      const finished = getTask(task.id);
      const status =
        CANCELLED.has(batchId) || finished?.status === "cancelled"
          ? "cancelled"
          : finished?.status === "done"
          ? "done"
          : finished?.status === "escalated"
          ? "escalated"
          : "failed";
      emit(
        updateBatchItem(batchId, item.index, {
          status,
          attempts: finished?.attempt,
          reason:
            status === "done"
              ? finished?.verdict?.oneLineReason ?? "approved"
              : finished?.escalationReason ?? getBatch(batchId)?.items[item.index]?.reason ?? `ended in status ${finished?.status}`,
          finishedAt: new Date().toISOString(),
        })
      );
    }
  } finally {
    RUNNING.delete(batchId);
    const b = getBatch(batchId);
    if (b) {
      if (CANCELLED.has(batchId)) {
        for (const it of b.items) if (it.status === "pending" || it.status === "running") it.status = "cancelled";
      }
      const allDone = b.items.every((i) => i.status === "done");
      const status = CANCELLED.has(batchId) ? "cancelled" : allDone ? "done" : "partial";
      const reportPath = await writeReport(b).catch(() => undefined);
      emit(updateBatch(batchId, { status, reportPath }));
    }
    CANCELLED.delete(batchId);
  }
}

export function cancelBatch(batchId: string): boolean {
  const b = getBatch(batchId);
  if (!b) return false;
  CANCELLED.add(batchId);
  const live = b.items.find((i) => i.status === "running");
  if (live?.taskId) stopLoop(live.taskId);
  if (!RUNNING.has(batchId)) {
    for (const it of b.items) if (it.status === "pending" || it.status === "running") it.status = "cancelled";
    emit(updateBatch(batchId, { status: "cancelled" }));
    CANCELLED.delete(batchId);
  }
  return true;
}

/**
 * Called once at boot. A batch that was running when the process died is
 * resumed from its checkpoint: items marked "running" (their task was cut
 * off) go back to pending and get a fresh task; finished items are skipped.
 */
export function resumeInterruptedBatches(): string[] {
  const resumed: string[] = [];
  for (const b of listBatches()) {
    if (b.status !== "running" && b.status !== "queued") continue;
    for (const it of b.items) if (it.status === "running") it.status = "pending";
    resumed.push(b.id);
  }
  void saveBatches();
  // Sequential: one batch at a time, matching the single-active-task loop.
  void (async () => {
    for (const id of resumed) await runBatch(id);
  })();
  return resumed;
}

async function writeReport(b: Batch): Promise<string> {
  await mkdir(b.workdirRoot, { recursive: true });
  const count = (s: string) => b.items.filter((i) => i.status === s).length;
  const lines = [
    `# Batch report — ${b.title}`,
    "",
    `Batch id: ${b.id}  ·  items: ${b.items.length}  ·  done: ${count("done")}  ·  escalated: ${count("escalated")}  ·  failed: ${count("failed")}  ·  cancelled: ${count("cancelled")}`,
    "",
    "| # | Input | Status | Attempts | Task | Reason |",
    "|---|---|---|---|---|---|",
    ...b.items.map(
      (i) =>
        `| ${i.index + 1} | ${i.input.replace(/\|/g, "\\|").slice(0, 80)} | ${i.status} | ${i.attempts ?? ""} | ${i.taskId ?? ""} | ${(i.reason ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)} |`
    ),
    "",
  ];
  const path = join(b.workdirRoot, "BATCH_REPORT.md");
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}
