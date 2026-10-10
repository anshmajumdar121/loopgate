import { useCallback } from "react";
import { useLoopSocket } from "@/hooks/useLoopSocket";
import { useWorkflow } from "@/lib/store";
import type { Task } from "@/types/loop";

// The sidebar list only carries TaskSummary rows (no plan/diff/logs), so
// selecting a task has to fetch the full record before loading it. Each call
// bumps this counter; a response that arrives after a newer click is dropped,
// so clicking A then B quickly can never leave A on screen.
let latestSelect = 0;

export async function selectTask(
  id: string,
  loadTask: (task: Task) => void,
  subscribe: (id: string) => void
): Promise<void> {
  const mine = ++latestSelect;
  try {
    const res = await fetch(`/api/tasks/${id}`);
    if (!res.ok) throw new Error(`GET /api/tasks/${id} → ${res.status}`);
    const { task } = (await res.json()) as { task: Task };
    if (mine !== latestSelect) return;
    loadTask(task);
    subscribe(task.id);
  } catch (e) {
    console.error("[selectTask] failed to load task", id, e);
  }
}

export function useSelectTask(): (id: string) => void {
  const loadTask = useWorkflow((s) => s.loadTask);
  const { subscribe } = useLoopSocket();
  return useCallback(
    (id: string) => {
      void selectTask(id, loadTask, subscribe);
    },
    [loadTask, subscribe]
  );
}
