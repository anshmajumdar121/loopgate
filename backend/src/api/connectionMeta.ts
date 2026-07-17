// REST endpoints for connection health checks + aggregated token usage.
//
// Health check (`POST /api/connections/:id/test`): makes a lightweight
// request against the configured baseUrl to verify the API key + endpoint
// are reachable. Result is returned to the caller but not persisted (it's
// a point-in-time read; the UI's status badge shows the latest).
//
// Token usage (`GET /api/token-usage`): returns the aggregated per-model
// token counters that the agent-spawner has been recording. Counts
// persist across restarts (see store/tokenUsage.ts).

import { Hono } from "hono";
import { getConnection } from "../store/connections.js";
import {
  dropConnectionUsage,
  listUsage,
  usageTotals,
} from "../store/tokenUsage.js";
import { recordHealthResult } from "../loop/connection-health.js";

export const connectionMetaApi = new Hono();

export interface TestResult {
  ok: boolean;
  status: "connected" | "failed" | "no_key" | "unsupported";
  message: string;
  latencyMs?: number;
  /** Echoed for the UI's badge — which endpoint was reached. */
  endpoint?: string;
}

connectionMetaApi.post("/connections/:id/test", async (c) => {
  const id = c.req.param("id");
  const connection = getConnection(id);
  if (!connection) {
    return c.json({ error: "connection not found" }, 404);
  }
  const result = await testConnection(connection);
  // A manual Verify is also the freshest health signal we have — record it
  // so the auto-verify status dot and the orchestrator pre-flight see it.
  recordHealthResult(id, result);
  return c.json(result);
});

connectionMetaApi.get("/token-usage", (c) => {
  return c.json({
    entries: listUsage(),
    totals: usageTotals(),
  });
});

/**
 * Drop persisted usage rows for a connection. Called by the connections
 * DELETE handler so the usage panel doesn't show stale rows after a
 * provider is removed.
 */
export function onConnectionDeleted(connectionId: string): void {
  const n = dropConnectionUsage(connectionId);
  if (n > 0) {
    console.log(
      `[connection-meta] dropped ${n} usage row(s) for deleted connection ${connectionId}`
    );
  }
}

/**
 * Probe the connection's endpoint with a minimal request. Strategy:
 *   1. OpenAI-compatible → GET <baseUrl>/models (cheap list call; many
 *      providers also expose it as a "key works" check). If the URL ends
 *      with `/v1` already, we use `<baseUrl>/models`. If a custom prefix
 *      is configured (e.g. `/v1/chat/completions` for a chat-only proxy),
 *      we fall back to HEAD on the bare baseUrl.
 *   2. Anthropic-compatible → GET <baseUrl>/v1/models (Anthropic's Models
 *      API is the standard health probe).
 *
 * 401/403 → "key rejected" (the user can see this is an auth issue, not
 * a network outage). 404 on `/models` → fall back to HEAD on the bare
 * URL so providers that don't expose a list endpoint aren't falsely
 * flagged as broken.
 */
export async function testConnection(connection: {
  baseUrl: string;
  apiKey?: string;
  providerType: "openai-compatible" | "anthropic-compatible";
}): Promise<TestResult> {
  const baseUrl = connection.baseUrl.replace(/\/+$/, "");
  if (!connection.apiKey) {
    return {
      ok: false,
      status: "no_key",
      message: "No API key set — edit the connection to add one.",
    };
  }
  const start = Date.now();
  const primaryUrl =
    connection.providerType === "anthropic-compatible"
      ? `${baseUrl}/v1/models`
      : `${baseUrl}/models`;
  try {
    const res = await fetch(primaryUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "x-api-key": connection.apiKey,
        // Anthropic expects the anthropic-version header on every call.
        "anthropic-version": "2023-06-01",
      },
    });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return {
        ok: true,
        status: "connected",
        message: `Reached ${primaryUrl} (${res.status})`,
        latencyMs,
        endpoint: primaryUrl,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: "failed",
        message: `Auth rejected by ${primaryUrl} (${res.status}) — check the API key.`,
        latencyMs,
        endpoint: primaryUrl,
      };
    }
    if (res.status === 404) {
      // Provider doesn't expose /models — try a HEAD on the baseUrl itself
      // so a "chat-only" provider still passes.
      try {
        const head = await fetch(baseUrl, { method: "HEAD" });
        const headLatency = Date.now() - start;
        if (head.ok || (head.status >= 200 && head.status < 500)) {
          return {
            ok: true,
            status: "connected",
            message: `Reached ${baseUrl} (${head.status}); provider doesn't expose /models, used HEAD fallback.`,
            latencyMs: headLatency,
            endpoint: baseUrl,
          };
        }
        return {
          ok: false,
          status: "failed",
          message: `${primaryUrl} returned 404 and HEAD ${baseUrl} returned ${head.status}.`,
          latencyMs: headLatency,
          endpoint: baseUrl,
        };
      } catch (err) {
        return {
          ok: false,
          status: "failed",
          message: `${primaryUrl} returned 404; HEAD fallback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          latencyMs: Date.now() - start,
          endpoint: baseUrl,
        };
      }
    }
    return {
      ok: false,
      status: "failed",
      message: `${primaryUrl} returned ${res.status} ${res.statusText}.`,
      latencyMs,
      endpoint: primaryUrl,
    };
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      message: `Network error reaching ${primaryUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      latencyMs: Date.now() - start,
      endpoint: primaryUrl,
    };
  }
}
