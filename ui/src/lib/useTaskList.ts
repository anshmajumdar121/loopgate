import { useEffect, useState, useCallback } from "react";
import type { TaskSummary } from "@/types/loop";

/**
 * Fetches the list of tasks from `/api/tasks` and exposes a `refresh` method
 * the caller can invoke after a task is created/deleted/etc. Used by the
 * sidebar's "Tasks" section.
 *
 * Returns row-sized summaries only; open a task with `useSelectTask`.
 * No caching layer — re-fetches on mount, after `refresh()` calls, and every
 * 5s while the tab is visible (batch items create tasks server-side).
 */
export function useTaskList() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error(`GET /api/tasks → ${res.status}`);
      const data = (await res.json()) as { tasks: TaskSummary[] };
      setTasks(data.tasks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Tasks are also created server-side (batch items), so poll lightly
    // while the tab is visible instead of relying on local create events.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { tasks, loading, error, refresh };
}