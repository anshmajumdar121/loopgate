import { useState, useMemo } from "react";
import { Play, X, Folder, Layers, FolderOpen } from "lucide-react";
import { FolderBrowser } from "@/components/FolderBrowser";
import { type CreateTaskBody, type Task } from "@/types/loop";
import { useWorkflow } from "@/lib/store";
import { useProjectList, useSessionList } from "@/lib/useProjectTree";
import { useConnectionList } from "@/lib/useConnectionList";

interface NewTaskModalProps {
  onClose: () => void;
  onCreated: (taskId: string) => void;
  /** Optional pre-fill: when the modal is opened from a sidebar "New task in
   *  this session" affordance, callers can scope the task to that bucket. */
  initialProjectId?: string;
  initialSessionId?: string;
}

/**
 * Modal for creating a new task. The submit handler shows the 409 error from
 * the backend's single-active-task lock instead of silently failing. Called
 * from App's top-level render so it's reachable from both the TopBar and the
 * Sidebar's "New Task" buttons.
 */
export function NewTaskModal({
  onClose,
  onCreated,
  initialProjectId,
  initialSessionId,
}: NewTaskModalProps) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [contextFilesRaw, setContextFilesRaw] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>(
    initialProjectId
  );
  const [sessionId, setSessionId] = useState<string | undefined>(
    initialSessionId
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  const { projects } = useProjectList();
  // Filter sessions to the chosen project. When no project picked, the
  // session picker is disabled (a session must live inside a project).
  const { sessions: projectSessions } = useSessionList(projectId ?? null);
  // When a project has no sessions, fall back to showing the project's
  // session list anyway — we can still "unassigned within project".
  const sessionsForPicker = useMemo(
    () => (projectId ? projectSessions : []),
    [projectId, projectSessions]
  );

  // Preview the auto-derived workdir the backend will compute if the user
  // leaves the field blank. Mirrors `previewWorkdir` in
  // backend/src/store/tasks.ts. The path is shown as a placeholder so the
  // user can see where GOAL.md / STATE.md / diff output will land — they
  // can also override by typing their own path.
  const derivedWorkdirHint = useMemo(
    () => previewWorkdirLocal(projectId, sessionId),
    [projectId, sessionId]
  );

  // Used only for the helper-text footer (suggests Connections when the
  // user has added custom API endpoints). The actual model pickers live in
  // the per-node side panel, not here.
  const { connections } = useConnectionList();

  const handleStart = async () => {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      // Model selection is intentionally NOT part of this body — the
      // per-role model pickers in the side panel drive the actual picks
      // (resolved server-side from nodeModels + the project's default).
      // Keeping the New Task modal focused on prompt / project / session /
      // workdir is the simpler mental model: "create the task here,
      // configure models on the canvas".
      const body: CreateTaskBody = {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        workdir: workdir.trim() || undefined,
        contextFiles: contextFilesRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 10),
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
      };
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string; activeTask?: { id: string; title?: string } };
        const t = data.activeTask;
        setError(
          `Another task is already running${t?.title ? `: "${t.title}"` : ""}. ` +
            `Stop it first or wait for it to finish.`
        );
        return;
      }
      if (!res.ok) {
        setError(`Server returned ${res.status}`);
        return;
      }
      const data = (await res.json()) as { task: Task };
      onCreated(data.task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-[540px] max-w-[90vw] rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            New Task
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X size={15} />
          </button>
        </div>

        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Task Prompt
        </label>
        <textarea
          autoFocus
          rows={4}
          placeholder="Describe the work to be done. e.g. 'Fix the mask feather handle so it tracks the actual blur distance. Build and tests must pass.'"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Title (optional)
        </label>
        <input
          type="text"
          placeholder="Short label for this task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Working directory (optional)
        </label>
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder={
              derivedWorkdirHint ||
              "Defaults to the server's cwd"
            }
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            className="h-9 flex-1 rounded-lg border border-zinc-300 bg-white px-3 font-mono text-[12px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            type="button"
            onClick={() => setShowFolderBrowser(true)}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            title="Browse the server's filesystem"
          >
            <FolderOpen size={13} />
            Browse
          </button>
        </div>
        {derivedWorkdirHint && (
          <p className="mt-1.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
            Auto-derived from project / session. Leave blank to use it,
            or type / browse your own path to override.
          </p>
        )}

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Reference files (optional)
        </label>
        <textarea
          value={contextFilesRaw}
          onChange={(e) => setContextFilesRaw(e.target.value)}
          placeholder={"One absolute path per line, e.g.\n/Users/you/project/src/Editor/SplitMask.tsx"}
          rows={3}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-[12px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <p className="mt-1.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
          Contents are inlined into the planner and maker prompts (capped at 20KB/file, 60KB total).
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Project (optional)
            </label>
            <ProjectSelect
              value={projectId}
              onChange={(id) => {
                setProjectId(id);
                // Switching projects invalidates the session — reset it
                // rather than silently keep a session from the previous project.
                setSessionId(undefined);
              }}
              projects={projects}
              submitting={submitting}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Session (optional)
            </label>
            <SessionSelect
              value={sessionId}
              onChange={setSessionId}
              sessions={sessionsForPicker}
              disabled={!projectId}
              submitting={submitting}
            />
          </div>
        </div>
        {(projectId || sessionId) && (
          <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <Folder size={10} className="inline -mt-0.5 text-amber-500" />
            {projectId ? (
              <span className="ml-1">
                {projects.find((p) => p.id === projectId)?.name ?? "(unknown)"}
                {sessionId && (
                  <>
                    <Layers size={10} className="mx-1 inline -mt-0.5 text-violet-500" />
                    {projectSessions.find((s) => s.id === sessionId)?.name ??
                      "(unknown)"}
                  </>
                )}
              </span>
            ) : null}
          </p>
        )}

        <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
          Models are assigned per role from the side panel — click any
          node on the canvas to configure planning / implementation /
          review models independently.
          {connections.length > 0 && (
            <>
              {" "}
              External API endpoints live in{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Connections
              </span>{" "}
              (sidebar).
            </>
          )}
        </p>

        {error && (
          <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md px-4 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={!prompt.trim() || submitting}
            className="flex h-9 items-center gap-1.5 rounded-md bg-gradient-to-r from-violet-600 to-violet-500 px-4 text-[13px] font-medium text-white shadow-sm transition hover:from-violet-700 hover:to-violet-600 disabled:opacity-50"
          >
            <Play size={13} fill="currentColor" className="ml-0.5" />
            {submitting ? "Starting…" : "Start Loop"}
          </button>
        </div>
      </div>
      {showFolderBrowser && (
        <FolderBrowser
          initialPath={workdir || undefined}
          onSelect={(p) => {
            setWorkdir(p);
            setShowFolderBrowser(false);
          }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  );
}

/**
 // (ModelPicker removed — model selection now happens exclusively in the
// per-node side panel. NewTaskModal is intentionally model-agnostic.)

/**
 * Mirror of `previewWorkdir` in `backend/src/store/tasks.ts`. Kept in sync
 * manually — both functions share the same `data/workspaces/<p>/<s>/`
 * layout. Update both at once if the layout changes.
 *
 * Renders the path the backend will use IF the user leaves the workdir
 * field blank. Showing it as a placeholder (rather than auto-filling the
 * field) lets the user override with a single keystroke without first
 * having to clear the input.
 */
function previewWorkdirLocal(
  projectId: string | undefined,
  sessionId: string | undefined
): string | null {
  if (!projectId && !sessionId) return null;
  // We don't know the server's TASK_DATA_DIR from the client, but the
  // layout is stable: `<data>/workspaces/<projectId>/<sessionId?>`. The
  // server resolves the absolute path on create. Showing this hint lets
  // the user know the agent will write files in this layout.
  const parts = ["data", "workspaces", projectId, sessionId].filter(
    Boolean
  ) as string[];
  return parts.join("/");
}

/**
 * Project picker. Native <select> is fine here — the list is small and we
 * don't need blurb cards like for model picking. Empty value = no project.
 */
function ProjectSelect({
  value,
  onChange,
  projects,
  submitting,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  projects: { id: string; name: string }[];
  submitting: boolean;
}) {
  return (
    <select
      value={value ?? ""}
      disabled={submitting}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-[12.5px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
    >
      <option value="">— Unassigned —</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Session picker — only enabled when a project is picked. Empty value
 * means "no session" (task still belongs to the project, just not under a
 * specific session). When the project is unset, no sessions render (a
 * session must live inside a project).
 */
function SessionSelect({
  value,
  onChange,
  sessions,
  disabled,
  submitting,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  sessions: { id: string; name: string }[];
  disabled: boolean;
  submitting: boolean;
}) {
  return (
    <select
      value={value ?? ""}
      disabled={disabled || submitting}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-[12.5px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
    >
      <option value="">— Project only —</option>
      {sessions.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}