import { useEffect, useState, useCallback } from "react";
import type { TaskSummary } from "@/types/loop";

/**
 * Fetches the list of tasks from `/api/tasks` and exposes a `refresh` method
 * the caller can invoke after a task is created/deleted/etc. Used by the
 * sidebar's "Tasks" section.
 *
 * Returns row-sized summaries only; open a task with `useSelectTask`.
 * No caching layer — re-fetches on mount and after `refresh()` calls. A polling interval or
 * SSE-based push would be the next step if list size grows.
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
  }, [refresh]);

  return { tasks, loading, error, refresh };
}