import { useState, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  FolderOpen,
  Plus,
  Check,
  Inbox,
  ChevronDown,
  ChevronRight,
  Loader2,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectList, useSessionList } from "@/lib/useProjectTree";
import type { Project, Session } from "@/types/loop";

interface ProjectPickerProps {
  /** Currently selected project id, or `undefined` for unassigned. */
  projectId: string | undefined;
  /** Currently selected session id (must be inside `projectId` if set). */
  sessionId?: string;
  /**
   * Called whenever the user picks a project and/or session. Pass
   * `projectId=undefined` (and `sessionId=undefined`) for unassigned.
   * The picker always sends the pair — never just a session without
   * its project.
   */
  onChange: (projectId: string | undefined, sessionId?: string) => void;
  /**
   * Called when the user clicks "New project" — the host owns the
   * NewProjectModal so it stays composable.
   */
  onNewProject: () => void;
  /**
   * Called when the user clicks "New session" inside a project. The
   * host receives the `projectId` so it can open NewSessionModal with
   * the right parent pre-filled.
   */
  onNewSession: (projectId: string) => void;
  /** Optional Tailwind classNames for the trigger button. */
  triggerClassName?: string;
  /** Optional icon shown on the left of the trigger. */
  triggerIcon?: LucideIcon;
  /**
   * If true, the trigger is `nodrag` and stops propagation — useful when
   * embedded inside a React Flow custom node.
   */
  noDrag?: boolean;
}

/**
 * Project + Session picker used by the chatbot header chip and the
 * NewTaskModal. Renders as a single-button trigger that opens a
 * floating popover anchored below it.
 *
 * The popover shows:
 *   - "Unassigned" at the top (clears both project + session)
 *   - Each project with an expand chevron
 *   - When expanded, the project's sessions are listed inline
 *   - A "+" button on each project row to create a new session under it
 *   - A "+ New project" footer button to create a new project
 *
 * Implementation notes:
 *  - We portal the popover into `document.body` so it can escape the
 *    React Flow node's `overflow-hidden` wrapper and the canvas's
 *    z-index stacking.
 *  - Positioning is `position: fixed` with viewport-relative coords
 *    from `getBoundingClientRect()`. We recompute on open and on
 *    window resize / scroll while open.
 *  - Click-outside (mousedown) and Escape both close. `mousedown` is
 *    used (not `click`) so it fires before the trigger's own
 *    onMouseDown, preventing a single click from both opening and
 *    immediately closing the menu.
 *  - Sessions are fetched per-project on demand. We use a per-project
 *    session cache so opening the same project twice doesn't re-fetch.
 *  - The currently-selected project auto-expands so the selected
 *    session is visible without an extra click.
 */
export function ProjectPicker({
  projectId,
  sessionId,
  onChange,
  onNewProject,
  onNewSession,
  triggerClassName,
  triggerIcon: TriggerIcon,
  noDrag,
}: ProjectPickerProps) {
  const { projects, loading, refresh: refreshProjects } = useProjectList();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Per-project session cache. Keyed by projectId → sessions. We avoid
  // fetching every project's sessions on open (could be many); we only
  // fetch for the project the user expands.
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, Session[]>
  >({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loadingSessions, setLoadingSessions] = useState<Set<string>>(
    new Set()
  );

  const selectedProject = projects.find((p) => p.id === projectId);
  const selectedSession =
    projectId && sessionId
      ? sessionsByProject[projectId]?.find((s) => s.id === sessionId)
      : undefined;

  // Auto-expand the currently-selected project so the selected session
  // (if any) is visible without an extra click. This also triggers a
  // session fetch for that project if we don't have sessions yet.
  useEffect(() => {
    if (!projectId) return;
    setExpandedIds((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, [projectId]);

  // When the popover opens, ensure we have sessions for the selected
  // project (if any) so the user immediately sees the chip's session
  // reflected in the list. Sessions for other projects are lazy.
  useEffect(() => {
    if (!open) return;
    if (projectId && !sessionsByProject[projectId]) {
      void fetchSessions(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  async function fetchSessions(pid: string) {
    setLoadingSessions((prev) => new Set(prev).add(pid));
    try {
      const res = await fetch(
        `/api/sessions?projectId=${encodeURIComponent(pid)}`
      );
      if (!res.ok) throw new Error(`GET /api/sessions → ${res.status}`);
      const data = (await res.json()) as { sessions: Session[] };
      setSessionsByProject((prev) => ({ ...prev, [pid]: data.sessions }));
    } catch {
      // Silent — the user just won't see sessions for this project.
    } finally {
      setLoadingSessions((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }
  }

  const toggleExpand = (pid: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
        // Lazy fetch on first expand
        if (!sessionsByProject[pid] && !loadingSessions.has(pid)) {
          void fetchSessions(pid);
        }
      }
      return next;
    });
  };

  // ── Popover positioning ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // ── Close on outside mousedown / Escape ─────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // ── Refresh triggers ───────────────────────────────────────────────
  // Re-fetch projects when the popover opens, when the selection
  // changes, or when a project is created (signalled by projectId
  // changing from undefined → defined).
  useEffect(() => {
    if (open) void refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (projectId) void refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Also re-fetch sessions whenever a project is selected (so a
  // session created in another tab shows up).
  useEffect(() => {
    if (projectId) void fetchSessions(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId]);

  // ── Trigger label ──────────────────────────────────────────────────
  // The chip shows project + session when both are picked, just the
  // project otherwise, or the placeholder.
  const triggerLabel = useMemo(() => {
    if (selectedProject && selectedSession) {
      return `${selectedProject.name} / ${selectedSession.name}`;
    }
    if (selectedProject) return selectedProject.name;
    return "Pick a project";
  }, [selectedProject, selectedSession]);

  const triggerTitle = useMemo(() => {
    if (selectedProject && selectedSession) {
      return `${selectedProject.name} → ${selectedSession.name}`;
    }
    if (selectedProject) return `Project: ${selectedProject.name}`;
    return "Pick a project";
  }, [selectedProject, selectedSession]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => {
          if (noDrag) e.stopPropagation();
        }}
        className={cn(
          "nodrag flex w-full min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-[11.5px] font-medium transition-colors",
          selectedProject
            ? "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600"
            : "border-dashed border-zinc-300 bg-white text-zinc-500 hover:border-emerald-400 hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-emerald-500",
          noDrag && "nodrag",
          triggerClassName
        )}
        title={triggerTitle}
      >
        {TriggerIcon ? (
          <TriggerIcon
            size={10}
            className={cn(
              "shrink-0",
              selectedProject ? "text-emerald-500" : "text-zinc-400"
            )}
          />
        ) : selectedProject ? (
          <Folder size={10} className="shrink-0 text-amber-500" />
        ) : (
          <FolderOpen size={10} className="shrink-0 text-zinc-400" />
        )}
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown
          size={10}
          className={cn(
            "ml-auto shrink-0 text-zinc-400 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="z-[9999] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl ring-1 ring-black/5 dark:border-zinc-700 dark:bg-zinc-900"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            minWidth: Math.max(pos.width, 280),
            maxHeight: "min(560px, 80vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <h3 className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
              Select a project
            </h3>
            <p className="mt-0.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
              Tasks you send will be scoped to a project and session.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {loading && projects.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-zinc-500">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <PickerRow
                  icon={Inbox}
                  label="Unassigned"
                  selected={!projectId}
                  onClick={() => {
                    onChange(undefined, undefined);
                    setOpen(false);
                  }}
                />
                {projects.length > 0 && (
                  <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                )}
                {projects.map((p) => {
                  const expanded = expandedIds.has(p.id);
                  const sessions = sessionsByProject[p.id];
                  const isLoadingSessions = loadingSessions.has(p.id);
                  return (
                    <div key={p.id}>
                      <div
                        className={cn(
                          "nodrag group flex items-center gap-1 px-1 py-0.5",
                          // Highlight when the project itself is the
                          // current selection (regardless of session).
                          projectId === p.id &&
                            !sessionId &&
                            "bg-violet-50 dark:bg-violet-500/10"
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(p.id);
                          }}
                          className="nodrag grid h-6 w-5 shrink-0 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title={expanded ? "Collapse" : "Expand sessions"}
                        >
                          <ChevronRight
                            size={10}
                            className={cn(
                              "transition-transform",
                              expanded && "rotate-90"
                            )}
                          />
                        </button>
                        <PickerRow
                          icon={Folder}
                          iconClass="text-amber-500"
                          label={p.name}
                          sublabel={p.description}
                          selected={projectId === p.id && !sessionId}
                          onClick={() => {
                            // Picking a project without a session.
                            onChange(p.id, undefined);
                            setOpen(false);
                          }}
                          className="flex-1 rounded-md"
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(false);
                            onNewSession(p.id);
                          }}
                          className="nodrag grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-violet-50 hover:text-violet-700 dark:hover:bg-violet-500/15 dark:hover:text-violet-300"
                          title={`New session in ${p.name}`}
                        >
                          <Plus size={11} />
                        </button>
                      </div>
                      {expanded && (
                        <div className="ml-6 mr-1 mb-1 border-l border-zinc-100 pl-1 dark:border-zinc-800">
                          {isLoadingSessions && (
                            <div className="flex items-center gap-1.5 px-2 py-1 text-[10.5px] text-zinc-400">
                              <Loader2 size={10} className="animate-spin" />
                              Loading sessions…
                            </div>
                          )}
                          {sessions && sessions.length === 0 && !isLoadingSessions && (
                            <p className="px-2 py-1 text-[10.5px] italic text-zinc-400">
                              No sessions yet.
                            </p>
                          )}
                          {sessions?.map((s) => (
                            <PickerRow
                              key={s.id}
                              icon={Layers}
                              iconClass="text-violet-500"
                              label={s.name}
                              sublabel={s.description}
                              selected={projectId === p.id && sessionId === s.id}
                              indent
                              onClick={() => {
                                onChange(p.id, s.id);
                                setOpen(false);
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!loading && projects.length === 0 && (
                  <p className="px-3 py-3 text-center text-[11px] text-zinc-400">
                    No projects yet. Create one below.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="border-t border-zinc-100 p-1 dark:border-zinc-800">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onNewProject();
              }}
              className="nodrag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-500/15"
            >
              <Plus size={11} />
              New project
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function PickerRow({
  icon: Icon,
  label,
  sublabel,
  selected,
  selectedIcon: SelectedIcon = Check,
  iconClass,
  onClick,
  indent,
  className,
}: {
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  selected: boolean;
  selectedIcon?: LucideIcon;
  iconClass?: string;
  onClick: () => void;
  /** When true, add a small left indent so the row sits under a
   *  project header like a sub-item. */
  indent?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "nodrag flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left transition-colors",
        selected
          ? "bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200"
          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800/60",
        indent && "rounded-md",
        className
      )}
    >
      <Icon
        size={11}
        className={cn("shrink-0", iconClass ?? "text-zinc-400")}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] font-medium">{label}</div>
        {sublabel && (
          <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">
            {sublabel}
          </div>
        )}
      </div>
      {selected && (
        <SelectedIcon
          size={11}
          className="shrink-0 text-violet-600 dark:text-violet-300"
        />
      )}
    </button>
  );
}

// Re-export the types so the host component can pass callbacks that
// receive the new project / session (e.g. for auto-selecting after creation).
export type { Project, Session };
