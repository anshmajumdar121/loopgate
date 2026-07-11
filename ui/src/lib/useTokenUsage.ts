import { useCallback, useEffect, useRef, useState } from "react";
import type { TokenUsageSnapshot } from "@/types/loop";

/**
 * Polls `/api/token-usage` while a panel is mounted. We don't poll
 * forever — the panel disables polling when the popover is closed to
 * avoid hammering the backend. When the popover is open we poll every
 * 2s so new usage (from in-flight tasks) shows up live.
 */
export function useTokenUsage(active: boolean, pollMs = 2000) {
  const [snapshot, setSnapshot] = useState<TokenUsageSnapshot>({
    entries: [],
    totals: {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      callCount: 0,
      modelCount: 0,
    },
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setLoading(true);
      const res = await fetch("/api/token-usage");
      if (!res.ok) throw new Error(`GET /api/token-usage → ${res.status}`);
      const data = (await res.json()) as TokenUsageSnapshot;
      setSnapshot(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    // Always fetch once on mount so the panel header pill shows the
    // current total even when the popover is closed.
    void refresh();
    if (!active) return;
    const id = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [active, pollMs, refresh]);

  return { snapshot, loading, error, refresh };
}
