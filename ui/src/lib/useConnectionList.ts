import { useState, useEffect, useCallback } from "react";
import type {
  Connection,
  UpsertConnectionBody,
} from "@/types/loop";

/**
 * Fetches the connection list from `/api/connections`. Mirrors the pattern
 * of `useProjectList` / `useSessionList` — single GET on mount, no
 * polling; call `refresh()` after mutations.
 *
 * The apiKey is intentionally never returned by the server (replaced with
 * `hasApiKey: boolean` on the wire). To update the apiKey, callers send
 * it as part of the body to `createConnection` / `updateConnection` and
 * the hook refreshes after success to pick up the new `hasApiKey`.
 */
export function useConnectionList() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/connections");
      if (!res.ok) throw new Error(`GET /api/connections → ${res.status}`);
      const data = (await res.json()) as { connections: Connection[] };
      setConnections(data.connections);
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

  const create = useCallback(
    async (body: UpsertConnectionBody): Promise<Connection> => {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/connections → ${res.status}`);
      const data = (await res.json()) as { connection: Connection };
      await refresh();
      return data.connection;
    },
    [refresh]
  );

  const update = useCallback(
    async (
      id: string,
      body: UpsertConnectionBody
    ): Promise<Connection> => {
      const res = await fetch(`/api/connections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH /api/connections/${id} → ${res.status}`);
      const data = (await res.json()) as { connection: Connection };
      await refresh();
      return data.connection;
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`/api/connections/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`DELETE /api/connections/${id} → ${res.status}`);
      await refresh();
    },
    [refresh]
  );

  return { connections, loading, error, refresh, create, update, remove };
}
