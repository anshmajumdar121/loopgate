// Automatic connection health monitor (Part D of
// 2026-07-12-snake-run-diagnosis-and-auto-verify).
//
// Reuses the exact probe behind `POST /api/connections/:id/test`
// (api/connectionMeta.ts → testConnection) and runs it WITHOUT the user:
//   - once for every connection at backend startup,
//   - every CONN_HEALTH_INTERVAL_MS thereafter (default 5 min),
//   - immediately when a connection is created or updated,
//   - on-demand from the orchestrator's pre-flight (ensureFreshHealth).
//
// Results land on the connection record's optional `health` field
// ({ok, latencyMs?, error?, checkedAt}) and every status CHANGE is
// broadcast as a `connection_health` WS message so the UI dot updates
// live. ADDITIVE ONLY: the manual Verify endpoints and every existing
// field/message type are untouched.

import type { Connection, ConnectionHealth } from "../types.js";
import {
  getConnection,
  listConnections,
  setConnectionHealth,
} from "../store/connections.js";
import { testConnection, type TestResult } from "../api/connectionMeta.js";
import { broadcaster } from "../ws/broadcaster.js";

/** Re-check cadence. Env-overridable so tests can drive seconds, and so a
 *  user on a metered endpoint can slow it down. */
export const CONN_HEALTH_INTERVAL_MS = Number(
  process.env.CONN_HEALTH_INTERVAL_MS || 5 * 60_000
);

let intervalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background monitor: one startup sweep now, then a re-check of
 * every connection each interval. Call once from index.ts after
 * connections are loaded from disk. Returns a stop function (tests use it;
 * the server never stops it).
 */
export function startConnectionHealthMonitor(
  intervalMs: number = CONN_HEALTH_INTERVAL_MS
): () => void {
  void sweepAllConnections("startup");
  intervalTimer = setInterval(() => {
    void sweepAllConnections("interval");
  }, intervalMs);
  // Don't hold the process open just for health checks.
  intervalTimer.unref?.();
  return stopConnectionHealthMonitor;
}

export function stopConnectionHealthMonitor(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/** Test every connection in parallel. Exposed for tests. */
export async function sweepAllConnections(
  reason: "startup" | "interval" | "manual"
): Promise<void> {
  const conns = listConnections();
  if (conns.length === 0) return;
  await Promise.all(conns.map((c) => checkConnectionHealth(c.id)));
  const after = listConnections();
  const bad = after.filter((c) => c.health && !c.health.ok);
  console.log(
    `[connection-health] ${reason} sweep: ${after.length} checked, ${bad.length} unhealthy` +
      (bad.length > 0 ? ` (${bad.map((c) => c.name).join(", ")})` : "")
  );
}

/**
 * Run one health check for a connection id and record the result. Called
 * by the sweep, by the create/update hooks in api/connections.ts, and by
 * the orchestrator pre-flight. Returns the recorded health, or null when
 * the connection no longer exists.
 */
export async function checkConnectionHealth(
  connectionId: string
): Promise<ConnectionHealth | null> {
  const conn = getConnection(connectionId);
  if (!conn) return null;
  let result: TestResult;
  try {
    result = await testConnection(conn);
  } catch (err) {
    // testConnection catches its own fetch errors; this is belt+braces so
    // a monitor crash can never take the server down.
    result = {
      ok: false,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return recordHealthResult(connectionId, result);
}

/**
 * Translate a TestResult into ConnectionHealth, persist it, and broadcast
 * `connection_health`. Shared by the automatic monitor and the manual
 * `POST /connections/:id/test` endpoint so both paths keep the dot live.
 *
 * EVERY result broadcasts, not just status changes: the UI refetches only
 * on this event, so gating on change left a steadily-healthy connection's
 * "checked N min ago" display permanently stale (live user report — they
 * had to click Verify to see updates). It also made any change-event lost
 * to a WS reconnect unrecoverable. One small message per connection per
 * sweep (5 min default) is negligible traffic.
 */
export function recordHealthResult(
  connectionId: string,
  result: TestResult
): ConnectionHealth | null {
  const health: ConnectionHealth = {
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.ok ? undefined : result.message,
    checkedAt: new Date().toISOString(),
  };
  const updated = setConnectionHealth(connectionId, health);
  if (!updated) return null; // deleted mid-check
  broadcaster.broadcastAll({
    type: "connection_health",
    connectionId,
    health,
  });
  return health;
}

/**
 * Orchestrator pre-flight: make sure a connection's health is fresh and
 * ok BEFORE spawning an agent on it. If the last check is missing, stale
 * (older than the monitor interval), or failed, re-test right now.
 * Returns the up-to-date health (never null for an existing connection).
 * The caller decides what to do with `ok: false` — fail over or escalate
 * with the connection name instead of burning a 4-minute stall window.
 */
export async function ensureFreshHealth(
  connection: Connection,
  maxAgeMs: number = CONN_HEALTH_INTERVAL_MS
): Promise<ConnectionHealth> {
  const h = getConnection(connection.id)?.health ?? connection.health;
  if (h && h.ok && Date.now() - Date.parse(h.checkedAt) < maxAgeMs) {
    return h;
  }
  const fresh = await checkConnectionHealth(connection.id);
  return (
    fresh ?? {
      ok: false,
      error: "connection no longer exists",
      checkedAt: new Date().toISOString(),
    }
  );
}
