import { useEffect, useState, useCallback } from "react";
import {
  Sparkles,
  RefreshCw,
  Camera,
  Undo2,
  Copy,
  Check,
  AlertCircle,
  Loader2,
  Play,
  FileDiff,
  ChevronDown,
  ChevronRight,
  MessageSquareWarning,
  ListChecks,
  ShieldAlert,
  Clock,
  Repeat,
  Coins,
  type LucideIcon,
} from "lucide-react";
import { useTaskList } from "@/lib/useTaskList";

// ponytail: matching the ConnectionsPanel Tailwind look (the newest
// sibling). One scrollable page, three sections (Insights / Recipe /
// Snapshots), no tabs. Less chrome, less state.

interface ImprovePanelProps {
  /**
   * Called after "Run as task" creates a new task from the current
   * recipe. The App uses this to switch the active view to "workflow"
   * and bind the canvas to the new task. Optional — when omitted
   * (e.g. tests), the panel just shows a success banner with the id.
   */
  onTaskCreated?: (taskId: string) => void;
}

type FindingKind =
  | "repeated-reject"
  | "criteria-miss"
  | "validation-regression"
  | "stall-cluster"
  | "no-op-attempts"
  | "token-blow-up";

interface Finding {
  kind: FindingKind;
  pattern: string;
  count: number;
  examples: { taskId: string; attempt: number }[];
  role: "planner" | "maker" | "verifier" | "unknown";
  suggestedFix: "prompt" | "code" | "discard";
}

interface Snapshot {
  id: string;
  path: string;
  createdAt: string;
  fileCount: number;
}

type FileStatus = "added" | "removed" | "modified" | "unchanged";

interface FileChange {
  path: string;
  status: FileStatus;
  beforeBytes: number | null;
  afterBytes: number | null;
}

export function ImprovePanel({ onTaskCreated }: ImprovePanelProps = {}) {
  const { tasks } = useTaskList();
  // Prefill workdir from the most recent task. The user can override.
  const recentWorkdir = tasks[0]?.workdir ?? "";
  const [workdir, setWorkdir] = useState(recentWorkdir);

  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [recipe, setRecipe] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);

  const [loadingInsights, setLoadingInsights] = useState(false);
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Per-snapshot diff state: which snapshots are expanded, and the
  // fetched changes for each. Keeping it per-id avoids refetching the
  // diff for a snapshot the user has already viewed.
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, FileChange[] | "loading" | "error">>({});

  // Keep workdir in sync with the most recent task when the list updates
  // and the user hasn't typed anything yet.
  useEffect(() => {
    if (!workdir && recentWorkdir) setWorkdir(recentWorkdir);
  }, [recentWorkdir, workdir]);

  const fetchInsights = useCallback(async () => {
    setLoadingInsights(true);
    setError(null);
    try {
      const r = await fetch("/api/insights");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { findings: Finding[] };
      setFindings(data.findings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingInsights(false);
    }
  }, []);

  const fetchRecipe = useCallback(async () => {
    setLoadingRecipe(true);
    setError(null);
    try {
      const r = await fetch("/api/improve-recipe");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const md = await r.text();
      setRecipe(md);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRecipe(false);
    }
  }, []);

  const fetchSnapshots = useCallback(async () => {
    if (!workdir) return;
    try {
      const r = await fetch(
        `/api/ratchet/snapshots?workdir=${encodeURIComponent(workdir)}`
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { snapshots: Snapshot[] };
      setSnapshots(data.snapshots);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workdir]);

  // Auto-fetch insights on mount (the only endpoint that doesn't need
  // a workdir). Snapshots wait for the user to confirm a workdir.
  useEffect(() => {
    void fetchInsights();
  }, [fetchInsights]);

  useEffect(() => {
    if (workdir) void fetchSnapshots();
  }, [workdir, fetchSnapshots]);

  const handleSnapshot = async () => {
    if (!workdir) return;
    setSnapshotting(true);
    setError(null);
    try {
      const r = await fetch("/api/ratchet/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workdir }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      await fetchSnapshots();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSnapshotting(false);
    }
  };

  const handleRevert = async (snapshotId: string | null) => {
    if (!workdir) return;
    setReverting(snapshotId ?? "latest");
    setError(null);
    try {
      const r = await fetch("/api/ratchet/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workdir, snapshotId }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      await fetchSnapshots();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReverting(null);
    }
  };

  const handleCopy = async () => {
    if (!recipe) return;
    try {
      await navigator.clipboard.writeText(recipe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  const handleToggleDiff = async (snapshotId: string) => {
    setOpenDiffs((prev) => {
      const next = new Set(prev);
      if (next.has(snapshotId)) {
        next.delete(snapshotId);
        return next;
      }
      next.add(snapshotId);
      return next;
    });
    // Lazy fetch — only load the diff the first time a snapshot is
    // expanded. The result is cached in `diffs` keyed by snapshot id.
    if (diffs[snapshotId] === undefined) {
      setDiffs((prev) => ({ ...prev, [snapshotId]: "loading" }));
      try {
        const r = await fetch("/api/ratchet/diff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workdir, snapshotId }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        const data = (await r.json()) as { changes: FileChange[] };
        setDiffs((prev) => ({ ...prev, [snapshotId]: data.changes }));
      } catch (e) {
        setDiffs((prev) => ({
          ...prev,
          [snapshotId]: "error",
        }));
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const handleRunAsTask = async () => {
    if (!recipe || !workdir) return;
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: recipe,
          workdir,
          // The recipe is itself the user's manual approval — they
          // read the markdown, decided to run it. No second human gate.
          autoApprovePlan: true,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { id: string };
      setLastTaskId(data.id);
      onTaskCreated?.(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-50 p-6 dark:bg-zinc-950">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
            <Sparkles size={18} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Recursive Improve
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Detect failure patterns, generate a recipe to patch the agent
              prompts, snapshot before you run it.
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* Workdir */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Workdir
          </label>
          <input
            type="text"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder="/path/to/project/.opencode/agents lives here"
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-mono text-xs text-zinc-900 focus:border-violet-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </div>

        {/* Insights */}
        <Section
          title="Insights"
          subtitle="Top repeated rejection patterns across every task"
          actions={
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              onClick={fetchInsights}
              loading={loadingInsights}
            />
          }
        >
          {findings === null && loadingInsights && (
            <SpinnerRow text="Loading findings…" />
          )}
          {findings !== null && findings.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No patterns detected across the current task set. Run more
              tasks to surface patterns.
            </p>
          )}
          {findings !== null && findings.length > 0 && (
            <ul className="flex flex-col gap-2">
              {findings.map((f, i) => {
                const meta = KIND_META[f.kind];
                const KindIcon = meta.icon;
                return (
                  <li
                    key={`${f.kind}-${f.pattern}-${i}`}
                    className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.badge}`}
                          title={meta.label}
                        >
                          <KindIcon size={11} />
                          {meta.label}
                        </span>
                        <span className="truncate font-mono text-xs text-zinc-900 dark:text-zinc-100">
                          "{f.pattern}"
                        </span>
                      </div>
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {f.count} ×
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                      role: {f.role} · fix: {f.suggestedFix}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* Recipe */}
        <Section
          title="Recipe"
          subtitle="A pre-baked GOAL.md targeting the top 3 patterns. Paste it as a new task's prompt."
          actions={
            <IconButton
              icon={RefreshCw}
              label="Get recipe"
              onClick={fetchRecipe}
              loading={loadingRecipe}
            />
          }
        >
          {recipe === null && !loadingRecipe && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Click "Get recipe" to fetch a recipe tailored to the current
              findings.
            </p>
          )}
          {recipe !== null && (
            <div className="flex flex-col gap-2">
              <textarea
                value={recipe}
                readOnly
                rows={14}
                className="w-full resize-y rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy to clipboard"}
                </button>
                <button
                  onClick={handleRunAsTask}
                  disabled={running || !workdir}
                  title={!workdir ? "Set a workdir first" : "Create a task with this recipe"}
                  className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-900/40"
                >
                  {running ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Play size={12} />
                  )}
                  Run as task
                </button>
              </div>
              {lastTaskId && (
                <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Created task <span className="font-mono">{lastTaskId}</span>.
                  Watch it run in the Workflow view.
                </p>
              )}
            </div>
          )}
        </Section>

        {/* Snapshots */}
        <Section
          title="Snapshots"
          subtitle="Back up <workdir>/.opencode/agents/ before running the recipe. One click to revert."
          actions={
            <IconButton
              icon={Camera}
              label="Snapshot now"
              onClick={handleSnapshot}
              loading={snapshotting}
              disabled={!workdir}
            />
          }
        >
          {!workdir && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Set a workdir above to manage snapshots.
            </p>
          )}
          {workdir && snapshots !== null && snapshots.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No snapshots yet for this workdir.
            </p>
          )}
          {workdir && snapshots !== null && snapshots.length > 0 && (
            <ul className="flex flex-col gap-2">
              {snapshots.map((s) => {
                const isOpen = openDiffs.has(s.id);
                const diffState = diffs[s.id];
                return (
                  <li
                    key={s.id}
                    className="rounded-md border border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <div className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs text-zinc-900 dark:text-zinc-100">
                          {s.id}
                        </div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          {new Date(s.createdAt).toLocaleString()} ·{" "}
                          {s.fileCount} file{s.fileCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => handleToggleDiff(s.id)}
                          title={
                            isOpen ? "Hide diff" : "Show diff against current prompts"
                          }
                          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                          {isOpen ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronRight size={12} />
                          )}
                          <FileDiff size={12} />
                          Diff
                        </button>
                        <button
                          onClick={() => handleRevert(s.id)}
                          disabled={reverting !== null}
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
                        >
                          {reverting === s.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Undo2 size={12} />
                          )}
                          Revert
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <DiffPanel state={diffState} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  loading,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <Icon
        size={12}
        className={loading ? "animate-spin" : undefined}
      />
      {label}
    </button>
  );
}

const FILE_STATUS_STYLES: Record<FileStatus, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  removed: "text-rose-700 dark:text-rose-300",
  modified: "text-amber-700 dark:text-amber-300",
  unchanged: "text-zinc-500 dark:text-zinc-400",
};

const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  added: "+ added",
  removed: "- removed",
  modified: "~ modified",
  unchanged: "  unchanged",
};

function DiffPanel({
  state,
}: {
  state: FileChange[] | "loading" | "error" | undefined;
}) {
  if (state === undefined) return null;
  if (state === "loading") {
    return (
      <div className="border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <Loader2 size={12} className="mr-1 inline animate-spin" />
        Loading diff…
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        Failed to load diff. Check the error banner above.
      </div>
    );
  }
  const changed = state.filter((c) => c.status !== "unchanged");
  const unchanged = state.filter((c) => c.status === "unchanged");
  if (changed.length === 0) {
    return (
      <div className="border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        No changes — current prompts match this snapshot.
      </div>
    );
  }
  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <ul className="font-mono text-[11px]">
        {changed.map((c) => (
          <li
            key={c.path}
            className="flex items-center justify-between gap-2 px-3 py-1"
          >
            <span className={FILE_STATUS_STYLES[c.status]}>
              {FILE_STATUS_LABELS[c.status].padEnd(11)}
              {c.path}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {c.beforeBytes ?? "—"} → {c.afterBytes ?? "—"} bytes
            </span>
          </li>
        ))}
        {unchanged.length > 0 && (
          <li className="px-3 py-1 text-zinc-500 dark:text-zinc-400">
            {"  "}
            {unchanged.length} unchanged file
            {unchanged.length === 1 ? "" : "s"}
          </li>
        )}
      </ul>
    </div>
  );
}

function SpinnerRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
      <Loader2 size={14} className="animate-spin" />
      {text}
    </div>
  );
}

// Visual treatment per finding kind. Color + icon lets the user scan
// the list and see "this is a connection issue" vs "this is a
// prompt issue" without reading the pattern text. The kind label is
// ALSO rendered explicitly in the card so the user doesn't have to
// memorize the color map.
//
// ponytail: kept inline instead of a separate config file because
// it's only used here. If a second component ever needs this, lift
// it to `ui/src/lib/findingKinds.ts`.
const KIND_META: Record<
  FindingKind,
  {
    label: string;
    icon: LucideIcon;
    /** Badge + accent border classes. Use sparingly — the same color
     *  signals the same kind everywhere. */
    badge: string;
  }
> = {
  "repeated-reject": {
    label: "Repeated reject",
    icon: MessageSquareWarning,
    badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  "criteria-miss": {
    label: "Criteria miss",
    icon: ListChecks,
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  "validation-regression": {
    label: "Validation regression",
    icon: ShieldAlert,
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  },
  "stall-cluster": {
    label: "Stall cluster",
    icon: Clock,
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  },
  "no-op-attempts": {
    label: "No-op attempts",
    icon: Repeat,
    badge: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  },
  "token-blow-up": {
    label: "Token blow-up",
    icon: Coins,
    badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  },
};
