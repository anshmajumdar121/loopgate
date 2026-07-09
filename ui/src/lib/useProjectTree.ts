import { useState, useEffect, useCallback } from "react";
import type { Project, Session } from "@/types/loop";

/**
 * Fetches the project list from `/api/projects`. Used by the sidebar.
 * Mirrors `useTaskList` — same single-fetch-on-mount pattern, no polling.
 * Refresh after mutations (create/delete).
 */
export function useProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`GET /api/projects → ${res.status}`);
      const data = (await res.json()) as { projects: Project[] };
      setProjects(data.projects);
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

  return { projects, loading, error, refresh };
}

/**
 * Fetches sessions, optionally filtered to one project. Pass
 * `projectId=null` for "all sessions across all projects" (rare in the
 * sidebar — usually you want one project's sessions).
 */
export function useSessionList(projectId?: string | null) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const url = projectId
        ? `/api/sessions?projectId=${encodeURIComponent(projectId)}`
        : "/api/sessions";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const data = (await res.json()) as { sessions: Session[] };
      setSessions(data.sessions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, loading, error, refresh };
}