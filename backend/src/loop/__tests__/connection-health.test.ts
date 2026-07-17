// Tests for the automatic connection health monitor (Part D of
// 2026-07-12-snake-run-diagnosis-and-auto-verify):
//   1. startup sweep populates health for every connection
//   2. interval re-check picks up a status change
//   3. create/update via the API triggers an immediate re-check
//   4. pre-flight (ensureFreshHealth) failure path: stale/failed health is
//      re-tested now and reported ok:false with the error message
//
// The store persists to LOOP_DATA_DIR — pointed at a temp dir BEFORE the
// dynamic imports below so the user's real _connections.json (which holds
// API keys) is never touched. `fetch` is stubbed so no network happens.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOOP_DATA_DIR = join(
  mkdtempSync(join(tmpdir(), "loop-health-test-")),
  "tasks"
);

const {
  createConnection,
  getConnection,
  listConnections,
  deleteConnection,
} = await import("../../store/connections.js");
const {
  sweepAllConnections,
  startConnectionHealthMonitor,
  stopConnectionHealthMonitor,
  ensureFreshHealth,
} = await import("../connection-health.js");
const { connectionsApi } = await import("../../api/connections.js");
const { Hono } = await import("hono");

// ── fetch stub ───────────────────────────────────────────────────────────
// Health probes GET `<baseUrl>/models`. Hosts listed in `failingHosts`
// get a 401 (auth rejected → ok:false); everything else gets a 200.
const failingHosts = new Set<string>();
const fetchSpy = vi.fn(async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).host;
  if (failingHosts.has(host)) {
    return new Response("no", { status: 401, statusText: "Unauthorized" });
  }
  return new Response("{}", { status: 200, statusText: "OK" });
});
vi.stubGlobal("fetch", fetchSpy);

function makeConn(name: string, host: string) {
  return createConnection({
    name,
    providerType: "openai-compatible",
    baseUrl: `https://${host}/v1`,
    apiKey: "test-key",
    model: "vendor/test-model",
    roles: ["planning"],
  });
}

function app() {
  const a = new Hono();
  a.route("/api", connectionsApi);
  return a;
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  for (const c of listConnections()) deleteConnection(c.id);
  failingHosts.clear();
  fetchSpy.mockClear();
});

afterEach(() => {
  stopConnectionHealthMonitor();
});

describe("connection-health: startup sweep", () => {
  it("populates health for every connection, ok and failed alike", async () => {
    const good = makeConn("good", "good.example");
    const bad = makeConn("bad", "bad.example");
    failingHosts.add("bad.example");

    await sweepAllConnections("startup");

    const goodHealth = getConnection(good.id)?.health;
    const badHealth = getConnection(bad.id)?.health;
    expect(goodHealth?.ok).toBe(true);
    expect(typeof goodHealth?.checkedAt).toBe("string");
    expect(badHealth?.ok).toBe(false);
    expect(badHealth?.error).toMatch(/401|Auth rejected/i);
  });
});

describe("connection-health: interval re-check", () => {
  it("picks up a status change on the next interval tick", async () => {
    const conn = makeConn("flappy", "flappy.example");
    startConnectionHealthMonitor(40); // startup sweep + 40ms interval
    await waitFor(() => getConnection(conn.id)?.health?.ok === true);

    // Endpoint dies (key revoked / provider outage) — the next interval
    // sweep must flip the dot red without any user click.
    failingHosts.add("flappy.example");
    await waitFor(() => getConnection(conn.id)?.health?.ok === false);
    expect(getConnection(conn.id)?.health?.error).toMatch(/401|Auth/i);
  });
});

describe("connection-health: re-check on create/update via API", () => {
  it("tests a brand-new connection immediately after POST", async () => {
    const res = await app().request("/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "fresh",
        providerType: "openai-compatible",
        baseUrl: "https://fresh.example/v1",
        apiKey: "k",
        model: "vendor/m",
      }),
    });
    expect(res.status).toBe(201);
    const { connection } = (await res.json()) as { connection: { id: string } };
    await waitFor(() => Boolean(getConnection(connection.id)?.health));
    expect(getConnection(connection.id)?.health?.ok).toBe(true);
  });

  it("re-tests after PATCH so stored health never describes old credentials", async () => {
    const conn = makeConn("editable", "old.example");
    await sweepAllConnections("manual");
    expect(getConnection(conn.id)?.health?.ok).toBe(true);
    const before = getConnection(conn.id)!.health!.checkedAt;

    failingHosts.add("new.example");
    const res = await app().request(`/api/connections/${conn.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "editable",
        providerType: "openai-compatible",
        baseUrl: "https://new.example/v1",
        model: "vendor/test-model",
      }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => getConnection(conn.id)?.health?.ok === false);
    expect(getConnection(conn.id)!.health!.checkedAt >= before).toBe(true);
  });
});

describe("connection-health: pre-flight (ensureFreshHealth)", () => {
  it("returns cached health without re-testing when fresh and ok", async () => {
    const conn = makeConn("cached", "cached.example");
    await sweepAllConnections("manual");
    const callsAfterSweep = fetchSpy.mock.calls.length;

    const h = await ensureFreshHealth(getConnection(conn.id)!);
    expect(h.ok).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterSweep); // no new probe
  });

  it("re-tests a stale-ok connection and reports the failure with its error", async () => {
    const conn = makeConn("stale", "stale.example");
    await sweepAllConnections("manual");
    expect(getConnection(conn.id)?.health?.ok).toBe(true);

    // Age the record past the freshness window and kill the endpoint —
    // exactly the "task submitted against a revoked key" scenario. The
    // pre-flight must fail fast with the error, not spawn into a stall.
    const rec = getConnection(conn.id)!;
    rec.health = {
      ...rec.health!,
      checkedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    failingHosts.add("stale.example");

    const h = await ensureFreshHealth(rec);
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/401|Auth/i);
    // Recorded on the connection too, so the UI dot flips.
    expect(getConnection(conn.id)?.health?.ok).toBe(false);
  });

  it("re-tests immediately when the last check failed", async () => {
    const conn = makeConn("recovering", "recover.example");
    failingHosts.add("recover.example");
    await sweepAllConnections("manual");
    expect(getConnection(conn.id)?.health?.ok).toBe(false);

    // Endpoint comes back — a pre-flight against a failed record must
    // re-test now (not trust the stale failure) and see the recovery.
    failingHosts.delete("recover.example");
    const h = await ensureFreshHealth(getConnection(conn.id)!);
    expect(h.ok).toBe(true);
  });
});
