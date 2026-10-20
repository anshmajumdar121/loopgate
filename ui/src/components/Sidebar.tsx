import { useState } from "react";
import {
  LayoutDashboard,
  Workflow,
  History,
  LayoutTemplate,
  Plug,
  Settings,
  ChevronDown,
  Plus,
  ChevronRight,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CircleDashed,
  Trash2,
  Folder,
  FolderOpen,
  Layers,
  X,
  Sparkles,
  Boxes,
} from "lucide-react";
import { useTaskList } from "@/lib/useTaskList";
import { useProjectList, useSessionList } from "@/lib/useProjectTree";
import { useWorkflow } from "@/lib/store";
import { cn } from "@/lib/utils";
import { NewProjectModal } from "@/components/NewProjectModal";
import type { Project, Session, TaskSummary, TaskStatus } from "@/types/loop";
import { useSelectTask } from "@/lib/selectTask";
import { isBatchActive, useBatchStore } from "@/lib/batchStore";

export type SidebarView = "workflow" | "connections" | "improve";

interface SidebarProps {
  onNewTask: () => void;
  /** The view currently shown in the main area — drives the active state
   *  in the primary nav. */
  activeView: SidebarView;
  onNavigate: (view: SidebarView) => void;
  /** Opens the Batch drawer (rendered by App over the current view). */
  onOpenBatch?: () => void;
  batchOpen?: boolean;
}

export function Sidebar({ onNewTask, activeView, onNavigate, onOpenBatch, batchOpen }: SidebarProps) {
  const [showNewProject, setShowNewProject] = useState(false);
  const batchRunning = useBatchStore((s) => s.batches.some(isBatchActive));

  return (
    <aside className="flex h-full w-[268px] flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Workspace card */}
      <div className="px-3 pt-3">
        <button className="group flex w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white p-2.5 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/60">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-xs font-semibold text-white">
            LA
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                Loop Agent
              </span>
              <ChevronDown size={12} className="text-zinc-400" />
            </div>
            <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              Plan → Implement → Verify
            </div>
          </div>
        </button>
      </div>

      {/* Primary nav */}
      <nav className="mt-3 flex flex-col gap-0.5 px-2">
        <NavItem
          icon={Workflow}
          label="Workflow"
          active={activeView === "workflow"}
          onClick={() => onNavigate("workflow")}
        />
        <NavItem icon={History} label="History" disabled />
        <NavItem icon={LayoutTemplate} label="Templates" disabled />
        <NavItem
          icon={Plug}
          label="Connections"
          active={activeView === "connections"}
          onClick={() => onNavigate("connections")}
        />
        <NavItem
          icon={Sparkles}
          label="Recursive Improve"
          active={activeView === "improve"}
          onClick={() => onNavigate("improve")}
        />
        {onOpenBatch && (
          <NavItem
            icon={Boxes}
            label="Batch"
            active={batchOpen}
            onClick={onOpenBatch}
            dot={batchRunning}
          />
        )}
        <NavItem icon={Settings} label="Settings" disabled />
      </nav>

      {/* Tasks (flat list of every task across every project) */}
      <TasksSection onNewTask={onNewTask} />

      {/* Projects (Project > Session > Task tree) */}
      <ProjectsSection
        onNewTask={onNewTask}
        onCreateProject={() => setShowNewProject(true)}
      />

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={() => setShowNewProject(false)}
        />
      )}
    </aside>
  );
}

// ─── Tasks section ─────────────────────────────────────────

function TasksSection({ onNewTask }: { onNewTask: () => void }) {
  const { tasks, loading, error, refresh } = useTaskList();
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const selectTaskById = useSelectTask();
  const isRunning = useWorkflow((s) => s.isRunning);

  const handleSelect = (task: TaskSummary) => selectTaskById(task.id);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      await refresh();
    } catch {
      /* ignore — best effort */
    }
  };

  return (
    <div className="mt-4 flex flex-col overflow-hidden px-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        <span>Tasks</span>
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        <button
          onClick={() => void refresh()}
          title="Refresh"
          className="grid h-5 w-5 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <RefreshCw size={10} />
        </button>
      </div>

      <div className="-mx-1 max-h-44 overflow-y-auto pr-1">
        {loading && (
          <div className="flex items-center px-2 py-3 text-[11.5px] text-zinc-400">
            <Loader2 size={11} className="mr-1.5 animate-spin" /> loading…
          </div>
        )}
        {error && (
          <div className="rounded-md bg-rose-50 px-2 py-2 text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}
        {!loading && !error && tasks.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <p>No tasks yet.</p>
            <button
              onClick={onNewTask}
              className="text-violet-700 hover:underline dark:text-violet-300"
            >
              Start your first task →
            </button>
          </div>
        )}
        {!loading && tasks.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {tasks.slice(0, 6).map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                isActive={t.id === currentTaskId}
                onSelect={() => handleSelect(t)}
                onDelete={(e) => handleDelete(e, t.id)}
              />
            ))}
            {tasks.length > 6 && (
              <li className="px-2 pt-1 text-[10.5px] text-zinc-400 dark:text-zinc-500">
                +{tasks.length - 6} more (use Projects to scope)
              </li>
            )}
          </ul>
        )}
      </div>

      <button
        onClick={onNewTask}
        disabled={isRunning}
        title={isRunning ? "Another task is already running" : "Start a new task"}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-300 px-2 py-2 text-[12px] font-medium text-zinc-700 transition-colors hover:border-violet-400 hover:bg-violet-50/40 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-violet-500 dark:hover:bg-violet-500/10 dark:hover:text-violet-300"
      >
        <Plus size={13} />
        New Task
      </button>
    </div>
  );
}

function TaskRow({
  task,
  isActive,
  onSelect,
  onDelete,
}: {
  task: TaskSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors",
          isActive
            ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
            : "text-zinc-600 hover:bg-zinc-100/40 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
        )}
      >
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5"
          title={task.title}
        >
          <StatusDot status={task.status} />
          <span className="truncate text-[12.5px]">{task.title}</span>
          {task.sessionId && (
            <span className="rounded bg-zinc-100 px-1 py-px text-[9px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              in session
            </span>
          )}
        </button>
        <button
          onClick={onDelete}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Delete task"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {task.attempt > 0 && (
        <div className="ml-[18px] px-2 pb-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
          attempt {task.attempt}/{task.maxAttempts}
        </div>
      )}
    </li>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const map: Record<
    TaskStatus,
    { icon: React.ElementType; cls: string; spin?: boolean }
  > = {
    draft: { icon: CircleDashed, cls: "text-zinc-400" },
    planning: { icon: Loader2, cls: "text-violet-500", spin: true },
    plan_review: { icon: CircleDashed, cls: "text-amber-500" },
    implementing: { icon: Loader2, cls: "text-violet-500", spin: true },
    verifying: { icon: Loader2, cls: "text-violet-500", spin: true },
    done: { icon: CheckCircle2, cls: "text-emerald-500" },
    escalated: { icon: AlertTriangle, cls: "text-rose-500" },
    cancelled: { icon: CircleDashed, cls: "text-zinc-400" },
  };
  const cfg = map[status];
  const Icon = cfg.icon;
  return <Icon size={11} className={cn(cfg.cls, cfg.spin && "animate-spin")} />;
}

// ─── Projects section ─────────────────────────────────────────

/**
 * Tree: Project > Session > Task. Each project can be expanded to show its
 * sessions; each session expands to show tasks. Tasks outside any project
 * are listed separately.
 *
 * Expand state is local per project/session. Persisting expand state
 * would be a nice v2 — skipped for now.
 */
function ProjectsSection({
  onNewTask,
  onCreateProject,
}: {
  onNewTask: () => void;
  onCreateProject: () => void;
}) {
  const { projects, loading, error, refresh } = useProjectList();
  const { tasks, refresh: refreshTasks } = useTaskList();

  return (
    <div className="mt-5 flex flex-1 flex-col overflow-hidden px-3 pb-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        <span>Projects</span>
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        <button
          onClick={() => void refresh()}
          title="Refresh"
          className="grid h-5 w-5 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <RefreshCw size={10} />
        </button>
      </div>

      <div className="-mx-1 flex-1 overflow-y-auto pr-1">
        {loading && projects.length === 0 && (
          <div className="flex items-center px-2 py-3 text-[11.5px] text-zinc-400">
            <Loader2 size={11} className="mr-1.5 animate-spin" /> loading…
          </div>
        )}
        {error && (
          <div className="rounded-md bg-rose-50 px-2 py-2 text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}
        {!loading && projects.length === 0 && !error && (
          <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <p>No projects yet.</p>
            <button
              onClick={onCreateProject}
              className="text-violet-700 hover:underline dark:text-violet-300"
            >
              Create your first project →
            </button>
          </div>
        )}
        {projects.map((p) => (
          <ProjectTree
            key={p.id}
            project={p}
            tasks={tasks}
            onTaskChanged={() => void refreshTasks()}
            onProjectChanged={() => void refresh()}
          />
        ))}
      </div>

      <button
        onClick={onCreateProject}
        className={cn(
          "mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 py-2",
          "text-[12px] font-medium transition-all duration-150",
          "border-zinc-300 text-zinc-700",
          "hover:border-violet-400 hover:bg-violet-50/60 hover:text-violet-700",
          "dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-violet-500 dark:hover:bg-violet-500/10 dark:hover:text-violet-300"
        )}
      >
        <Plus size={13} />
        New Project
      </button>
    </div>
  );
}

/**
 * Single project row: chevron + violet-gradient folder chip + name
 * (delete on hover). Click anywhere on the row toggles expand. Expanded
 * children show sessions, each also expandable; sessions expand to tasks.
 */
function ProjectTree({
  project,
  tasks,
  onTaskChanged,
  onProjectChanged,
}: {
  project: Project;
  tasks: TaskSummary[];
  onTaskChanged: () => void;
  onProjectChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (
      !confirm(
        `Delete project "${project.name}"? Tasks will become unassigned.`
      )
    )
      return;
    try {
      await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      onProjectChanged();
      onTaskChanged();
    } catch {
      /* ignore — list will refresh on next mount */
    }
  };

  return (
    <div className="mb-1">
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5",
          "transition-colors duration-150",
          "hover:bg-violet-50/60 dark:hover:bg-violet-500/[0.07]"
        )}
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 text-zinc-400 transition-transform duration-200 ease-out",
            expanded && "rotate-90"
          )}
        />
        {/* Violet-gradient folder chip — mirrors the "category" badges
            in image 2 (the rounded square with a glyph inside). */}
        <div
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-md",
            "bg-gradient-to-br from-violet-500 to-violet-600 text-white",
            "shadow-[0_1px_2px_rgba(124,58,237,0.25)]"
          )}
        >
          {expanded ? (
            <FolderOpen size={11} strokeWidth={2.4} />
          ) : (
            <Folder size={11} strokeWidth={2.4} />
          )}
        </div>
        <span className="flex-1 truncate text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">
          {project.name}
        </span>
        <button
          onClick={handleDelete}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Delete project"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {expanded && (
        <SessionsList
          projectId={project.id}
          tasks={tasks}
          onTaskChanged={onTaskChanged}
          onSessionsChanged={onProjectChanged}
        />
      )}
    </div>
  );
}

function SessionsList({
  projectId,
  tasks,
  onTaskChanged,
  onSessionsChanged,
}: {
  projectId: string;
  tasks: TaskSummary[];
  onTaskChanged: () => void;
  onSessionsChanged: () => void;
}) {
  const { sessions, refresh } = useSessionList(projectId);
  const [addingSession, setAddingSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");

  // Tasks belonging to this project — bucketed under their session.
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const unassignedTasks = projectTasks.filter((t) => !t.sessionId);

  return (
    <div className="ml-3.5 border-l border-zinc-200 pl-1.5 dark:border-zinc-800">
      {sessions.map((s) => (
        <SessionTree
          key={s.id}
          session={s}
          tasks={projectTasks.filter((t) => t.sessionId === s.id)}
          onTaskChanged={onTaskChanged}
          onSessionsChanged={() => {
            refresh();
            onSessionsChanged();
          }}
        />
      ))}

      {/* Unassigned tasks under this project (no session) */}
      {unassignedTasks.length > 0 && (
        <SessionlessTasks
          tasks={unassignedTasks}
          onTaskChanged={onTaskChanged}
        />
      )}

      {/* Inline "+ new session" form */}
      {addingSession ? (
        <InlineSessionForm
          value={newSessionName}
          onChange={setNewSessionName}
          onCancel={() => {
            setAddingSession(false);
            setNewSessionName("");
          }}
          onSubmit={async () => {
            const name = newSessionName.trim();
            if (!name) return;
            try {
              await fetch("/api/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, name }),
              });
              setNewSessionName("");
              setAddingSession(false);
              refresh();
              onSessionsChanged();
            } catch {
              /* ignore */
            }
          }}
        />
      ) : (
        <button
          onClick={() => setAddingSession(true)}
          className={cn(
            "mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1",
            "text-left text-[11.5px] font-medium text-zinc-500",
            "transition-colors duration-150",
            "hover:bg-violet-50/60 hover:text-violet-700 dark:text-zinc-400 dark:hover:bg-violet-500/[0.07] dark:hover:text-violet-300"
          )}
        >
          <Plus size={10} />
          New session
        </button>
      )}
    </div>
  );
}

function SessionTree({
  session,
  tasks,
  onTaskChanged,
  onSessionsChanged,
}: {
  session: Session;
  tasks: TaskSummary[];
  onTaskChanged: () => void;
  onSessionsChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete session "${session.name}"?`)) return;
    try {
      await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
      onSessionsChanged();
      onTaskChanged();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mt-0.5">
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1",
          "transition-colors duration-150",
          "hover:bg-violet-50/40 dark:hover:bg-violet-500/[0.06]"
        )}
      >
        <ChevronRight
          size={10}
          className={cn(
            "shrink-0 text-zinc-400 transition-transform duration-200 ease-out",
            expanded && "rotate-90"
          )}
        />
        {/* Smaller violet-tinted chip for sessions — same gradient
            family as the project chip so the tree reads as one palette. */}
        <div
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center rounded",
            "bg-violet-100 text-violet-600",
            "dark:bg-violet-500/20 dark:text-violet-300"
          )}
        >
          <Layers size={9} strokeWidth={2.5} />
        </div>
        <span className="flex-1 truncate text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          {session.name}
        </span>
        <span
          className={cn(
            "rounded-full bg-zinc-100 px-1.5 py-px text-[9.5px] font-medium tabular-nums text-zinc-500",
            "dark:bg-zinc-800 dark:text-zinc-400"
          )}
        >
          {tasks.length}
        </span>
        <button
          onClick={handleDelete}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          title="Delete session"
        >
          <Trash2 size={10} />
        </button>
      </div>
      {expanded && tasks.length > 0 && (
        <div className="ml-3 border-l border-dashed border-zinc-200/70 pl-1.5 dark:border-zinc-800/70">
          <TasksUnderSession tasks={tasks} onTaskChanged={onTaskChanged} />
        </div>
      )}
    </div>
  );
}

/**
 * Tasks belonging to a session. Pretty much the same as the top-level
 * TasksSection but constrained to those that match.
 */
function TasksUnderSession({
  tasks,
  onTaskChanged,
}: {
  tasks: TaskSummary[];
  onTaskChanged: () => void;
}) {
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const selectTaskById = useSelectTask();

  const handleSelect = (task: TaskSummary) => selectTaskById(task.id);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      onTaskChanged();
    } catch {
      /* ignore */
    }
  };

  return (
    <ul className="flex flex-col py-0.5">
      {tasks.map((t, i) => (
        <li
          key={t.id}
          className={cn(
            "border-b border-zinc-200/40 last:border-b-0 dark:border-zinc-800/40",
            i > 0 && "pt-px"
          )}
        >
          <div
            className={cn(
              "group flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px]",
              "transition-colors duration-150",
              t.id === currentTaskId
                ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                : "text-zinc-600 hover:bg-zinc-100/40 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
            )}
          >
            <button
              onClick={() => handleSelect(t)}
              className="flex min-w-0 flex-1 items-center gap-1.5"
              title={t.title}
            >
              <StatusDot status={t.status} />
              <span className="truncate">{t.title}</span>
            </button>
            <button
              onClick={(e) => handleDelete(e, t.id)}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-zinc-300 opacity-0 hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Delete task"
            >
              <X size={10} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tasks under a project with no session. Just like TasksUnderSession but
 * keyed off the unassigned bucket.
 */
function SessionlessTasks({
  tasks,
  onTaskChanged,
}: {
  tasks: TaskSummary[];
  onTaskChanged: () => void;
}) {
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const selectTaskById = useSelectTask();

  const handleSelect = (task: TaskSummary) => selectTaskById(task.id);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      onTaskChanged();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mt-1">
      <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        Unassigned
      </div>
      <ul className="flex flex-col py-0.5">
        {tasks.map((t, i) => (
          <li
            key={t.id}
            className={cn(
              "border-b border-zinc-200/40 last:border-b-0 dark:border-zinc-800/40",
              i > 0 && "pt-px"
            )}
          >
            <div
              className={cn(
                "group flex items-center gap-2 rounded-md px-2 py-1 text-[11.5px]",
                "transition-colors duration-150",
                t.id === currentTaskId
                  ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                  : "text-zinc-600 hover:bg-zinc-100/40 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
              )}
            >
              <button
                onClick={() => handleSelect(t)}
                className="flex min-w-0 flex-1 items-center gap-1.5"
                title={t.title}
              >
                <StatusDot status={t.status} />
                <span className="truncate">{t.title}</span>
              </button>
              <button
                onClick={(e) => handleDelete(e, t.id)}
                className="grid h-4 w-4 shrink-0 place-items-center rounded text-zinc-300 opacity-0 hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                title="Delete task"
              >
                <X size={10} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inline "+ new session" form so creating a session is one click + name. */
function InlineSessionForm({
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-1 rounded-md bg-zinc-50 px-1.5 py-1 dark:bg-zinc-900/60">
      <input
        autoFocus
        type="text"
        placeholder="Session name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        className="h-7 flex-1 rounded border border-zinc-300 bg-white px-2 text-[11.5px] text-zinc-900 outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <button
        onClick={onSubmit}
        disabled={!value.trim()}
        className="rounded bg-violet-600 px-2 py-1 text-[10.5px] font-medium text-white hover:bg-violet-700 disabled:opacity-50"
      >
        Add
      </button>
      <button
        onClick={onCancel}
        className="grid h-7 w-7 place-items-center rounded text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800"
      >
        <X size={10} />
      </button>
    </div>
  );
}

// ─── Static nav (kept from original) ───────────────────────

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  disabled,
  dot,
}: {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** Small pulsing indicator (e.g. a batch is running). */
  dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
          : disabled
          ? "cursor-not-allowed text-zinc-400 dark:text-zinc-600"
          : "text-zinc-700 hover:bg-zinc-100/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
      }`}
    >
      <Icon
        size={15}
        className={
          active
            ? "text-violet-600 dark:text-violet-400"
            : "text-zinc-500 dark:text-zinc-400"
        }
      />
      <span>{label}</span>
      {dot && (
        <span
          className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500"
          aria-label="running"
        />
      )}
    </button>
  );
}

// Re-export so other modules can import the section if needed.
export { TasksSection, ProjectsSection };