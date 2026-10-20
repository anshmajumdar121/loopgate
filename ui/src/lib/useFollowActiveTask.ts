import { useCallback, useEffect, useRef } from "react";
import { selectTask } from "@/lib/selectTask";
import { useWorkflow } from "@/lib/store";
import type { TaskSummary } from "@/types/loop";

export const ACTIVE_TASK_POLL_MS = 2000;

interface FollowActiveTaskOptions {
  subscribe: (taskId: string) => void;
}

/**
 * Keep a lightweight mirror of the server's active task and, when the user
 * has Follow live enabled, move the main task view onto it. The full task is
 * still loaded through selectTask so the canvas, persisted details, logs and
 * WebSocket subscription all use the same path as a manual selection.
 */
export function useFollowActiveTask({
  subscribe,
}: FollowActiveTaskOptions): void {
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const switchingId = useRef<string | null>(null);
  const loadTask = useWorkflow((s) => s.loadTask);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const res = await fetch("/api/tasks/active");
      if (res.status === 204 || res.status === 404) {
        // A missing/empty active endpoint means no task is currently active.
        // Do not clear currentTaskId: a finished task should remain visible
        // until a new active task appears.
        useWorkflow.getState().setActiveTask(null);
        return;
      }
      if (!res.ok) return;

      const payload: unknown = await res.json();
      const activeTask = activeTaskFromPayload(payload);
      useWorkflow.getState().setActiveTask(activeTask);

      const state = useWorkflow.getState();
      const selectedTaskNeedsHydration =
        !state.taskMirror ||
        state.taskMirror.id !== activeTask?.id ||
        state.taskMirror.status !== activeTask?.status;
      if (
        activeTask &&
        state.followLive &&
        (activeTask.id !== state.currentTaskId || selectedTaskNeedsHydration) &&
        switchingId.current !== activeTask.id
      ) {
        switchingId.current = activeTask.id;
        try {
          await selectTask(activeTask.id, loadTask, subscribe);
        } finally {
          switchingId.current = null;
        }
      }
    } catch {
      // Polling is best-effort. Keep the last known active task and the
      // currently displayed task if the backend is temporarily unavailable.
    } finally {
      inFlight.current = false;
    }
  }, [loadTask, subscribe]);

  useEffect(() => {
    mounted.current = true;
    void poll();

    const timer = window.setInterval(() => {
      if (mounted.current) void poll();
    }, ACTIVE_TASK_POLL_MS);

    const onBatchUpdate = () => {
      // Batch items create their task server-side. The WebSocket event is a
      // stronger signal than waiting for the next two-second poll tick.
      void poll();
    };
    window.addEventListener("loop:batch-update", onBatchUpdate);

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("loop:batch-update", onBatchUpdate);
    };
  }, [poll]);
}

function activeTaskFromPayload(payload: unknown): TaskSummary | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const candidate =
    record.task ?? record.activeTask ?? record.active ?? payload;
  if (!candidate || typeof candidate !== "object") return null;

  const task = candidate as Record<string, unknown>;
  if (typeof task.id !== "string" || typeof task.status !== "string") {
    return null;
  }
  return task as unknown as TaskSummary;
}
