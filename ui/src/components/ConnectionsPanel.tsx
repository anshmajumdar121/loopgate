import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plug,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Globe,
  KeyRound,
  Cpu,
  ArrowLeft,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  ChevronDown,
  X,
  BarChart3,
  Play,
  ShieldCheck,
} from "lucide-react";
import { useConnectionList } from "@/lib/useConnectionList";
import { useTokenUsage } from "@/lib/useTokenUsage";
import { formatTokenCount, formatExactTokens, formatRelativeTime } from "@/lib/format";
import { NewConnectionModal } from "@/components/NewConnectionModal";
import type {
  Connection,
  ConnectionHealth,
  ConnectionTestResult,
  ConnectionTestStatus,
  TokenUsageEntry,
} from "@/types/loop";

// Auto-verify is purely event-driven:
//   - on create / update (handled in the NewConnectionModal onSubmit below
//     via `await handleTest(...)` after create/update)
//   - on backend startup + every 5 min via connection-health.ts monitor
// No client-side interval is needed (or exposed) — the user just adds a
// connection and sees the dot turn green immediately.

interface ConnectionsPanelProps {
  /** Called when the user wants to go back to the canvas. Top-bar style
   *  navigates back to the workflow view. */
  onBack: () => void;
}

/**
 * Full-bleed page that replaces the canvas when the sidebar's Connections
 * nav is selected. Lists configured external API endpoints and lets the
 * user add / edit / delete them. Models exposed by connections show up in
 * the model picker (in NewTaskModal + NodeModelPanel) — this panel is
 * only the management surface.
 */
export function ConnectionsPanel({ onBack }: ConnectionsPanelProps) {
  const { connections, loading, error, create, update, remove, refresh } =
    useConnectionList();
  const [editing, setEditing] = useState<Connection | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-connection test results, keyed by connection id. Cleared when
  // the user edits the connection (since the result is no longer
  // representative of the new key/endpoint).
  const [testResults, setTestResults] = useState<
    Record<string, ConnectionTestResult>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const usageButtonRef = useRef<HTMLButtonElement>(null);

  const handleDelete = async (c: Connection) => {
    if (
      !confirm(
        `Delete connection "${c.name}"? Models from it will disappear from the picker.`
      )
    )
      return;
    setBusyId(c.id);
    try {
      await remove(c.id);
      setTestResults((prev) => {
        const { [c.id]: _drop, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = useCallback(async (c: Connection) => {
    setTestingId(c.id);
    try {
      const res = await fetch(`/api/connections/${c.id}/test`, {
        method: "POST",
      });
      const data = (await res.json()) as Omit<ConnectionTestResult, "testedAt">;
      setTestResults((prev) => ({
        ...prev,
        [c.id]: { ...data, testedAt: new Date().toISOString() },
      }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [c.id]: {
          ok: false,
          status: "failed",
          message: e instanceof Error ? e.message : String(e),
          testedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  }, []);

  /**
   * "Verify all" — tests every connection in sequence. Connections that
   * don't yet have a stored result are tested first (so a fresh list
   * gets fully populated in one click). The button is disabled while a
   * verification round is in progress.
   */
  const [verifyingAll, setVerifyingAll] = useState(false);
  const handleVerifyAll = useCallback(async () => {
    if (connections.length === 0) return;
    setVerifyingAll(true);
    // Test in parallel — independent calls, no order dependency. The
    // worst case latency is the slowest individual test, not the sum.
    await Promise.all(connections.map((c) => handleTest(c)));
    setVerifyingAll(false);
    // The test endpoint also records health server-side — refresh so the
    // per-card dot + "checked …" label pick up the new state.
    void refresh();
  }, [connections, handleTest, refresh]);

  // Live dot updates: the backend broadcasts `connection_health` over WS
  // whenever the monitor sees a status change; useLoopSocket re-emits it
  // as a DOM event. Refreshing re-reads /api/connections (which now
  // carries the `health` field).
  useEffect(() => {
    const onHealth = () => void refresh();
    window.addEventListener("loop:connection-health", onHealth);
    return () => window.removeEventListener("loop:connection-health", onHealth);
  }, [refresh]);

  const modalOpen = creating || editing !== null;

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <button
          onClick={onBack}
          className="grid h-8 w-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          title="Back to workflow"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
          <Plug size={16} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            Connections
          </h1>
          <p className="mt-0.5 truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
            External API endpoints. Models exposed by these show up in the
            model picker.
          </p>
        </div>
        {/* Verify all — tests every connection in parallel. Disabled
            when there are none, or while a round is in flight. */}
        <button
          onClick={handleVerifyAll}
          disabled={connections.length === 0 || verifyingAll}
          className="flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-[12.5px] font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60"
          title="Test every connection at once"
        >
          {verifyingAll ? (
            <Loader2 size={12} className="animate-spin text-zinc-500" />
          ) : (
            <ShieldCheck size={13} className="text-zinc-500 dark:text-zinc-400" />
          )}
          Verify all
        </button>
        {/* Token usage popover trigger. Clicking opens a panel that
            breaks down cumulative prompt/completion tokens per model. */}
        <button
          ref={usageButtonRef}
          onClick={() => setUsageOpen((o) => !o)}
          className="flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-[12.5px] font-medium text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60"
          title="View per-model token usage"
        >
          <BarChart3 size={13} className="text-zinc-500 dark:text-zinc-400" />
          Token usage
          <ChevronDown
            size={12}
            className={`text-zinc-400 transition-transform ${
              usageOpen ? "rotate-180" : ""
            }`}
          />
        </button>
        <button
          onClick={() => setCreating(true)}
          className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          <Plus size={13} />
          Add connection
        </button>
      </header>

      {/* Token usage popover — anchored under the header. Renders inline
          (not portaled) because the panel scroll container clips it
          correctly; a portal would be hidden by the panel's overflow
          boundary. */}
      {usageOpen && (
        <TokenUsagePopover
          anchorRef={usageButtonRef}
          onClose={() => setUsageOpen(false)}
        />
      )}

      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        {loading && connections.length === 0 && (
          <div className="flex items-center gap-2 text-[13px] text-zinc-500">
            <Loader2 size={13} className="animate-spin" />
            Loading connections…
          </div>
        )}
        {error && (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}

        {!loading && !error && connections.length === 0 && (
          <EmptyState onAdd={() => setCreating(true)} />
        )}

        {/* Health summary — shows how many connections are ready to use
            at a glance. Hidden when there are no connections (empty
            state above already conveys the situation). */}
        {!loading && !error && connections.length > 0 && (
          <HealthSummary
            connections={connections}
            testResults={testResults}
            onVerifyAll={handleVerifyAll}
            verifyingAll={verifyingAll}
          />
        )}

        {/* Auto-verify status hint. No timer / no toggle — the panel
            auto-tests on create and on edit, and the backend monitor
            keeps things fresh. The "Verify all" button above is the
            manual escape hatch. */}
        {!loading && !error && connections.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[10.5px] text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Auto-verifies on add and edit · backend monitor runs continuously
          </div>
        )}

        <div className="mt-3 flex flex-col gap-3">
          {connections.map((c) => (
            <ConnectionCard
              key={c.id}
              connection={c}
              onEdit={() => {
                setTestResults((prev) => {
                  const { [c.id]: _drop, ...rest } = prev;
                  return rest;
                });
                setEditing(c);
              }}
              onDelete={() => handleDelete(c)}
              onTest={() => handleTest(c)}
              testResult={testResults[c.id] ?? null}
              testing={testingId === c.id}
              busy={busyId === c.id}
            />
          ))}
        </div>

        <Footer />
      </div>

      {modalOpen && (
        <NewConnectionModal
          initial={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={async (input) => {
            // Save the connection, then immediately test it so the user
            // sees a result without clicking Verify. We await the test
            // (which records health on the server), then refresh so the
            // connection list picks up the fresh health dot immediately
            // — no waiting for a background timer.
            if (editing) {
              await update(editing.id, input);
              await handleTest(editing);
            } else {
              const created = await create(input);
              await handleTest(created);
            }
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact rollup shown above the connection list. Tells the user "N of M
 * connections are ready to use" at a glance, with a coloured status dot
 * and a one-click "Verify all" action. Hidden if every connection is
 * already verified AND all green — keeps the panel clean when there's
 * nothing to worry about.
 */
function HealthSummary({
  connections,
  testResults,
  onVerifyAll,
  verifyingAll,
}: {
  connections: Connection[];
  testResults: Record<string, ConnectionTestResult>;
  onVerifyAll: () => void;
  verifyingAll: boolean;
}) {
  const total = connections.length;
  let connected = 0;
  let failed = 0;
  let noKey = 0;
  let untested = 0;
  for (const c of connections) {
    const r = testResults[c.id];
    if (r) {
      if (r.status === "connected") connected++;
      else if (r.status === "no_key") noKey++;
      else failed++;
      continue;
    }
    // No explicit test run in THIS browser tab yet — fall back to
    // connection.health, the server's own periodic check (startup +
    // every 5 min + on create/update). Without this fallback the banner
    // called every connection "untested" forever on a fresh page load
    // even though its per-card dot was already green from an automated
    // check (live report: card said "checked 10s ago" while the banner
    // above it said "0 of 1 ready · 1 untested").
    if (c.health) {
      if (c.health.ok) connected++;
      else failed++;
      continue;
    }
    untested++;
  }
  const ready = connected;
  const needAttention = failed + noKey + untested;
  // If everything is green, drop the summary — the per-card "Connected"
  // pills are sufficient and the banner becomes visual noise.
  if (needAttention === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[12px] text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:text-emerald-300">
        <CheckCircle2 size={13} />
        All <span className="font-semibold">{total}</span> connections are
        ready to use.
      </div>
    );
  }
  const allGood = ready === total;
  const headline = allGood
    ? `${ready} of ${total} ready`
    : `${ready} of ${total} ready · ${needAttention} need${
        needAttention === 1 ? "s" : ""
      } attention`;
  const dotClasses = allGood
    ? "bg-emerald-500"
    : ready === 0
    ? "bg-rose-500"
    : "bg-amber-500";
  const containerClasses = allGood
    ? "border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:text-emerald-300"
    : ready === 0
    ? "border-rose-200 bg-rose-50/60 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/5 dark:text-rose-300"
    : "border-amber-200 bg-amber-50/60 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[12px] ${containerClasses}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${dotClasses}`}
          aria-hidden
        />
        <span className="font-medium">{headline}</span>
        {untested > 0 && (
          <span className="text-[11px] opacity-75">
            ({untested} untested)
          </span>
        )}
      </div>
      <button
        onClick={onVerifyAll}
        disabled={verifyingAll}
        className="flex h-7 items-center gap-1.5 rounded-md border border-current/20 bg-white/40 px-2.5 text-[11.5px] font-medium hover:bg-white/70 disabled:opacity-60 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/70"
      >
        {verifyingAll ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <ShieldCheck size={11} />
        )}
        {verifyingAll ? "Verifying…" : "Verify all"}
      </button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        <Globe size={22} />
      </div>
      <h3 className="mt-4 text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
        No connections yet
      </h3>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-zinc-500 dark:text-zinc-400">
        Add an OpenAI-compatible endpoint (OpenRouter, Together, local
        Ollama, vLLM, etc.) or an Anthropic-compatible proxy. Its models
        will appear in the model picker.
      </p>
      <button
        onClick={onAdd}
        className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3.5 text-[13px] font-medium text-white hover:bg-violet-700"
      >
        <Plus size={13} />
        Add your first connection
      </button>
    </div>
  );
}

function Footer() {
  return (
    <p className="mt-8 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
      API keys are stored locally in <code className="font-mono">_connections.json</code>{" "}
      and never leave your machine.
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ConnectionCard({
  connection,
  onEdit,
  onDelete,
  onTest,
  testResult,
  testing,
  busy,
}: {
  connection: Connection;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  testResult: ConnectionTestResult | null;
  testing: boolean;
  busy: boolean;
}) {
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Globe size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
              {connection.name}
            </h3>
            <span className="rounded-md bg-zinc-100 px-1.5 py-px font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {connection.providerId ?? connection.providerType}
            </span>
            {connection.hasApiKey ? (
              <span className="flex items-center gap-0.5 rounded-md bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <KeyRound size={9} /> key set
              </span>
            ) : (
              <span className="rounded-md bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                no key
              </span>
            )}
            <HealthDot health={connection.health} checking={testing} />
          </div>
          <code className="mt-1 block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            {connection.baseUrl}
          </code>
          {connection.description && (
            <p className="mt-1 text-[11.5px] text-zinc-500 dark:text-zinc-400">
              {connection.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onEdit}
            disabled={busy || testing}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Edit connection"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={onDelete}
            disabled={busy || testing}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-rose-500 dark:hover:bg-zinc-800"
            title="Delete connection"
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
          </button>
        </div>
      </header>

      <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Cpu size={10} />
            Model
          </div>
          <div className="flex items-center gap-2">
            <TestActionButton
              result={testResult}
              testing={testing}
              onTest={onTest}
            />
          </div>
        </div>
        {connection.model ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-800">
              <span className="text-zinc-700 dark:text-zinc-200">
                {connection.modelLabel || connection.model}
              </span>
              {connection.modelLabel && (
                <span className="ml-1 font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
                  {connection.model}
                </span>
              )}
            </span>
            {typeof connection.temperature === "number" && (
              <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                T={connection.temperature.toFixed(2)}
              </span>
            )}
          </div>
        ) : connection.models && connection.models.length > 0 ? (
          // Legacy multi-model card.
          <div className="flex flex-wrap gap-1.5">
            {connection.models.map((m) => (
              <span
                key={m.id}
                className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10.5px] dark:border-zinc-700 dark:bg-zinc-800"
                title={m.id}
              >
                <span className="text-zinc-700 dark:text-zinc-200">
                  {m.label || m.id}
                </span>
                {m.label && (
                  <span className="ml-1 font-mono text-[9.5px] text-zinc-500 dark:text-zinc-400">
                    {m.id}
                  </span>
                )}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] text-zinc-400 dark:text-zinc-500">
            No model set — edit the connection to pick one.
          </p>
        )}
      </div>
    </article>
  );
}

/**
 * Live health dot (Part D2): green = last automated check passed, red =
 * failed (error text on hover), gray = never checked, amber = a check is
 * running right now. The "checked 2m ago" label reads the monitor's
 * `checkedAt` timestamp.
 */
function HealthDot({
  health,
  checking,
}: {
  health?: ConnectionHealth;
  checking: boolean;
}) {
  const color = checking
    ? "bg-amber-400 animate-pulse"
    : !health
    ? "bg-zinc-300 dark:bg-zinc-600"
    : health.ok
    ? "bg-emerald-500"
    : "bg-rose-500";
  const title = checking
    ? "Checking…"
    : !health
    ? "Never checked — the backend monitor will test it shortly."
    : health.ok
    ? `Healthy${typeof health.latencyMs === "number" ? ` — ${health.latencyMs}ms` : ""}`
    : `Failed: ${health.error ?? "unknown error"}`;
  return (
    <span className="flex items-center gap-1" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
        {checking
          ? "checking…"
          : health
          ? `checked ${formatRelativeTime(health.checkedAt)}`
          : "never checked"}
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection status badge — sits on the right side of the Model row.
// Shows the latest test result (or "Not tested") and a "Test" action
// inline. Click anywhere on the badge to re-test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test-action button. Three visual modes:
 *  - Not tested → prominent violet-outlined "Test" button (the entry
 *    point; the user knows it's a button, not a status label).
 *  - Testing → small "Testing…" pill with a spinner.
 *  - Tested → status pill in the appropriate colour, with a tiny
 *    re-test icon revealed on hover.
 *
 * Hover the tested pill for a tooltip with the test message + latency.
 */
function TestActionButton({
  result,
  testing,
  onTest,
}: {
  result: ConnectionTestResult | null;
  testing: boolean;
  onTest: () => void;
}) {
  if (testing) {
    return (
      <button
        onClick={onTest}
        disabled
        className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-[11.5px] font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      >
        <Loader2 size={11} className="animate-spin" />
        Testing…
      </button>
    );
  }

  if (!result) {
    return (
      <button
        onClick={onTest}
        className="flex h-7 items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-2.5 text-[11.5px] font-medium text-violet-700 transition-colors hover:border-violet-400 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200 dark:hover:border-violet-400/60 dark:hover:bg-violet-500/20"
        title="Test this connection"
      >
        <Play size={10} fill="currentColor" />
        Test
      </button>
    );
  }

  return (
    <div className="group flex items-center gap-1">
      <StatusPill result={result} />
      <button
        onClick={onTest}
        className="grid h-5 w-5 place-items-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        title="Re-test connection"
      >
        <Activity size={10} />
      </button>
    </div>
  );
}

function StatusPill({ result }: { result: ConnectionTestResult }) {
  const [hovered, setHovered] = useState(false);
  const { label, classes, icon } = styleForStatus(result.status);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex h-7 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-medium ${classes}`}
    >
      {icon}
      {label}
      {hovered && (
        <div
          className="pointer-events-none absolute right-0 top-full z-10 mt-1.5 w-max max-w-xs rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-left text-[11px] font-normal text-zinc-700 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          role="tooltip"
        >
          <div className="break-words">{result.message}</div>
          {typeof result.latencyMs === "number" && (
            <div className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
              {result.latencyMs}ms · {formatRelativeTime(result.testedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function styleForStatus(status: ConnectionTestStatus): {
  label: string;
  classes: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "connected":
      return {
        label: "Connected",
        classes:
          "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
        icon: <CheckCircle2 size={10} />,
      };
    case "no_key":
      return {
        label: "No API key",
        classes:
          "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
        icon: <KeyRound size={10} />,
      };
    case "unsupported":
      return {
        label: "Unsupported",
        classes:
          "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
        icon: <AlertTriangle size={10} />,
      };
    case "failed":
    default:
      return {
        label: "Not connected",
        classes:
          "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
        icon: <XCircle size={10} />,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token usage popover — drops under the "Token usage" header button.
// Shows aggregate totals + a per-model breakdown table with prompt /
// completion / total / calls / last-used.
// ─────────────────────────────────────────────────────────────────────────────

function TokenUsagePopover({
  anchorRef,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  onClose: () => void;
}) {
  const { snapshot, loading, error, refresh } = useTokenUsage(true);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Click-outside to close. Bind only while the popover is open.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      ref={popoverRef}
      className="absolute right-6 top-[60px] z-20 w-[min(520px,calc(100vw-3rem))] rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
            <BarChart3 size={13} />
          </div>
          <div>
            <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              Token usage
            </h2>
            <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
              Cumulative across all LLM calls.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Refresh"
          >
            <Loader2 size={11} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        <UsageSummary
          totalTokens={snapshot.totals.totalTokens}
          promptTokens={snapshot.totals.promptTokens}
          completionTokens={snapshot.totals.completionTokens}
          callCount={snapshot.totals.callCount}
          modelCount={snapshot.totals.modelCount}
        />

        {error && (
          <div className="mt-3 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-3 max-h-80 overflow-y-auto">
          {snapshot.entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <div className="grid h-8 w-8 place-items-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
                <Zap size={14} />
              </div>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                No usage yet. Run a task to start tracking.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="py-1.5 pr-2 font-medium">Model</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Prompt</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    Completion
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">Total</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Calls</th>
                  <th className="py-1.5 text-right font-medium">Last</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.entries.map((e) => (
                  <UsageRow key={e.modelId} entry={e} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function UsageSummary({
  totalTokens,
  promptTokens,
  completionTokens,
  callCount,
  modelCount,
}: {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  modelCount: number;
}) {
  const stats = [
    {
      label: "Total tokens",
      value: formatTokenCount(totalTokens),
      sub: `${formatExactTokens(totalTokens)} exact`,
      color: "text-violet-600 dark:text-violet-300",
    },
    {
      label: "Prompt",
      value: formatTokenCount(promptTokens),
      sub: `${formatExactTokens(promptTokens)} exact`,
      color: "text-zinc-700 dark:text-zinc-200",
    },
    {
      label: "Completion",
      value: formatTokenCount(completionTokens),
      sub: `${formatExactTokens(completionTokens)} exact`,
      color: "text-zinc-700 dark:text-zinc-200",
    },
    {
      label: "Calls",
      value: callCount.toLocaleString("en-US"),
      sub: `${modelCount} model${modelCount === 1 ? "" : "s"}`,
      color: "text-zinc-700 dark:text-zinc-200",
    },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-md border border-zinc-200 bg-zinc-50/60 px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-950/40"
        >
          <div className="text-[9.5px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {s.label}
          </div>
          <div className={`mt-0.5 text-[15px] font-semibold ${s.color}`}>
            {s.value}
          </div>
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {s.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function UsageRow({ entry }: { entry: TokenUsageEntry }) {
  const promptPct =
    entry.totalTokens > 0
      ? Math.round((entry.promptTokens / entry.totalTokens) * 100)
      : 0;
  return (
    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
      <td className="py-1.5 pr-2 align-top">
        <div className="font-medium text-zinc-900 dark:text-zinc-100">
          {entry.upstreamModel}
        </div>
        {entry.connectionName && (
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
            via {entry.connectionName}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2 text-right align-top font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
        {formatTokenCount(entry.promptTokens)}
        <div className="text-[9.5px] font-sans text-zinc-400 dark:text-zinc-500">
          {promptPct}%
        </div>
      </td>
      <td className="py-1.5 pr-2 text-right align-top font-mono tabular-nums text-zinc-700 dark:text-zinc-200">
        {formatTokenCount(entry.completionTokens)}
        <div className="text-[9.5px] font-sans text-zinc-400 dark:text-zinc-500">
          {100 - promptPct}%
        </div>
      </td>
      <td className="py-1.5 pr-2 text-right align-top font-mono tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">
        {formatTokenCount(entry.totalTokens)}
      </td>
      <td className="py-1.5 pr-2 text-right align-top tabular-nums text-zinc-700 dark:text-zinc-200">
        {entry.callCount}
      </td>
      <td
        className="py-1.5 text-right align-top text-[10px] text-zinc-500 dark:text-zinc-400"
        title={entry.lastUsed}
      >
        {formatRelativeTime(entry.lastUsed)}
      </td>
    </tr>
  );
}
