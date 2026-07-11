import { memo, useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  Paperclip,
  Crosshair,
  Mic,
  ArrowUp,
  Pause,
  Plus,
  Pencil,
  type LucideIcon,
  X,
  Image as ImageIcon,
  CheckCircle2,
  Sparkles,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflow } from "@/lib/store";
import { useLoopSocket } from "@/hooks/useLoopSocket";
import type { RunStatus } from "@/data/workflow";
import type { Task, Project } from "@/types/loop";
import { ProjectPicker } from "@/components/ProjectPicker";
import { NewProjectModal } from "@/components/NewProjectModal";
import { NewSessionModal } from "@/components/NewSessionModal";
import { useProjectList } from "@/lib/useProjectTree";
import { matchIntent, type ChatbotState } from "./chatbotIntents.js";
import { PersistentTaskCard } from "./PersistentTaskCard.js";
import { ChatThread, type ChatMessage } from "./ChatThread.js";
import { ChatInput } from "./ChatInput.js";

// Why this is here and not in a separate hook: the chatbot node is the
// ONLY place in the UI that mints new tasks, and we want the
// attach-image flow + the create-task call co-located so the two are
// kept in sync. Other entry points (TopBar's "New Task", Sidebar's
// "+ New Task") reuse the same NewTaskModal and don't support image
// attachments, so this is a deliberate divergence.

interface AttachedImage {
  id: string;
  dataUrl: string;
  name: string;
  size: number;
}

interface ChatbotNodeData extends Record<string, unknown> {
  spec: {
    id: string;
    kind: string;
    title: string;
    subtitle?: string;
    iconName: string;
  };
  icon: LucideIcon;
  status: RunStatus;
}

const HIGHLIGHT_KEYWORDS = [
  "ascending",
  "descending",
  "asc",
  "desc",
  "true",
  "false",
  "null",
  "today",
  "yesterday",
  "this week",
  "all",
];

/**
 * Render the prompt with a few keywords highlighted in the same mint
 * green used for the running status — mirrors Image 1 where the word
 * "descending" is highlighted. Matching is case-insensitive, longest
 * match first to avoid partial-word collisions.
 */
function renderHighlighted(text: string) {
  if (!text.trim()) return null;
  const sorted = [...HIGHLIGHT_KEYWORDS].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `\\b(${sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "gi"
  );
  const parts: Array<{ text: string; highlight: boolean }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), highlight: false });
    }
    parts.push({ text: match[0], highlight: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), highlight: false });
  }
  return parts.map((p, i) =>
    p.highlight ? (
      <span
        key={i}
        className="rounded bg-emerald-100 px-1 py-px text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
      >
        {p.text}
      </span>
    ) : (
      <span key={i}>{p.text}</span>
    )
  );
}

function ChatbotNodeImpl({ data, selected }: NodeProps) {
  const Icon = (data.icon as LucideIcon) ?? Sparkles;
  const spec = data.spec as ChatbotNodeData["spec"];

  const isRunning = useWorkflow((s) => s.isRunning);
  const currentTask = useWorkflow((s) => s.taskMirror);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const phase = useWorkflow((s) => s.phase);
  const plan = useWorkflow((s) => s.plan);
  const diff = useWorkflow((s) => s.diff);
  const verdict = useWorkflow((s) => s.verdict);
  const logs = useWorkflow((s) => s.logs);
  const { subscribe } = useLoopSocket();

  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chat thread state — clears when activeTaskId changes (delete or new assign).
  // Re-prompt keeps the same taskId so the thread is preserved across rewrites.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const lastTaskIdRef = useRef<string | null>(currentTaskId);
  useEffect(() => {
    if (currentTaskId !== lastTaskIdRef.current) {
      setMessages([]);
      lastTaskIdRef.current = currentTaskId;
    }
  }, [currentTaskId]);

  const chatbotState: ChatbotState = {
    currentTaskId,
    taskMirror: currentTask,
    plan,
    diff,
    verdict,
    logs,
  };

  const handleRewrite = async (newPrompt: string) => {
    if (!currentTaskId) return;
    const res = await fetch(`/api/tasks/${currentTaskId}/re-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: newPrompt }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError((data as { error?: string }).error ?? `Re-prompt failed (${res.status})`);
      return;
    }
    setError(null);
  };

  const handleDelete = async () => {
    if (!currentTaskId) return;
    const res = await fetch(`/api/tasks/${currentTaskId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      setError(`Delete failed (${res.status})`);
      return;
    }
    setError(null);
    // Backend emits task_deleted which the store handler picks up to clear taskMirror.
    // Our lastTaskIdRef effect above will clear messages when currentTaskId goes null.
  };

  const handleChatSubmit = (message: string) => {
    const intent = matchIntent(message, chatbotState);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: message, timestamp: Date.now() },
      { role: "bot", content: intent.render(chatbotState), timestamp: Date.now() },
    ]);
  };
  // Project list — we need the project *name* (not just the id) when
  // the "New session" modal opens, so it can show "in <project name>"
  // in its title. The ProjectPicker has its own copy; this is a
  // separate subscription that lets the modal show the name without
  // having to plumb a callback through the picker.
  const { projects: allProjects } = useProjectList();

  // Project scoping. Picked from the header chip's dropdown — every
  // task the chatbot sends is attached to this project so the user can
  // keep their work organized in the sidebar. `null` = unassigned.
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  // Session scoping (sub-project). Always paired with projectId — a
  // session without its project is meaningless on the wire, so the
  // picker always sends the pair.
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  // Local "New project" / "New session" modals — owned by the chatbot
  // so the user can create + immediately use a new project/session
  // without leaving the canvas.
  const [showNewProject, setShowNewProject] = useState(false);
  // Project id of the project the user is creating a session under.
  // null = no modal open.
  const [newSessionProjectId, setNewSessionProjectId] = useState<
    string | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Pre-fill from current task when entering edit mode.
  useEffect(() => {
    if (editing && currentTask?.prompt && !prompt) {
      setPrompt(currentTask.prompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, currentTask?.id]);

  // Auto-focus the textarea whenever the user enters edit mode so they
  // can start typing immediately. Without this, clicking Edit shows the
  // textarea but doesn't focus it — the user has to click again inside
  // the textarea, which is exactly the friction we want to remove.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  // Auto-grow the prompt textarea up to a max height, then turn on
  // vertical scroll. The cap (~200px ≈ 8 lines) keeps the input from
  // dominating the node body once the user pastes a long spec; the
  // user can still scroll inside the field to see everything.
  // Triggered on every prompt change so it works for both typing and
  // pre-fill (e.g. entering Edit mode with an existing task prompt).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 200; // px — about 8 lines at the current font size
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [prompt, editing]);

  const chipLabel = currentTask?.title ?? "New task";

  const handleSend = async () => {
    if (submitting) return;
    if (!prompt.trim() && images.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const imageNote =
        images.length > 0
          ? `\n\n[Attached images: ${images
              .map((i) => i.name)
              .join(", ")}]`
          : "";
      const body = {
        prompt: (prompt.trim() || "(see attached images)") + imageNote,
        title: chipLabel === "New task" ? prompt.trim().slice(0, 60) : undefined,
        // Scope the task to the project + session picked from the
        // header chip. `null` for either is fine — backend treats it
        // as "unassigned within parent".
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
      };
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        const data = (await res.json()) as { activeTask?: { id: string } };
        setError(
          "Another task is already running. Stop it before starting a new one."
        );
        if (data.activeTask?.id) subscribe(data.activeTask.id);
        return;
      }
      if (!res.ok) {
        setError(`Server returned ${res.status}`);
        return;
      }
      const data = (await res.json()) as { task: Task };
      useWorkflow.getState().setCurrentTask(data.task.id);
      useWorkflow.getState().setTaskMirror(data.task);
      useWorkflow.setState({ isRunning: true });
      useWorkflow.getState().resetNodeStatuses();
      subscribe(data.task.id);
      setPrompt("");
      setImages([]);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === "Escape") {
      // Esc exits edit mode without sending. Common chat UX.
      setEditing(false);
      e.currentTarget.blur();
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setImages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            name: file.name,
            size: file.size,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (id: string) =>
    setImages((prev) => prev.filter((i) => i.id !== id));

  const running = isRunning && !paused;
  const statusText = paused
    ? "Paused"
    : running
    ? "Running…"
    : currentTask
    ? "Ready"
    : "Idle";

  /**
   * Stop mouse / touch events from propagating up to React Flow's node
   * event handlers. React Flow installs a mousedown listener on the
   * whole node to start a drag; if we let that fire, the user's click
   * on a button / textarea is consumed before the button's onClick
   * handler can run, and the drag indicator starts flashing. Calling
   * stopPropagation in the `pointerDown` capture phase is the
   * officially-supported escape hatch — see React Flow's
   * "interaction elements inside a node" docs.
   *
   * We attach it to the whole body once, and rely on event bubbling
   * to catch every button / input inside.
   */
  const stopReactFlowPointer = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-2xl border bg-white shadow-card transition-shadow dark:bg-zinc-900",
        selected
          ? "border-emerald-400 ring-2 ring-emerald-400/30 dark:border-emerald-500 dark:ring-emerald-500/30"
          : "border-zinc-200 dark:border-zinc-800"
      )}
    >
      {/* React Flow handles — left/right so wires enter/exit cleanly. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-emerald-500 dark:!border-zinc-900"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-zinc-300 dark:!border-zinc-900"
      />

      {/* Status header — matches Image 1: mint chip with running status
          on the left, pause toggle on the right. The header is the
          ONLY drag handle (the rest of the node has `nodrag` applied
          via the body div below). */}
      <div
        className={cn(
          "nodrag flex cursor-move items-center gap-2 px-3 py-2 transition-colors",
          running
            ? "bg-emerald-50 dark:bg-emerald-500/10"
            : paused
            ? "bg-amber-50 dark:bg-amber-500/10"
            : "bg-zinc-50 dark:bg-zinc-800/40"
        )}
      >
        <GripVertical
          size={11}
          className="shrink-0 text-zinc-400 dark:text-zinc-500"
        />
        <div
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md",
            running
              ? "bg-emerald-500 text-white"
              : paused
              ? "bg-amber-500 text-white"
              : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
          )}
        >
          <Icon size={12} strokeWidth={2.4} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              "text-[12.5px] font-semibold",
              running
                ? "text-emerald-800 dark:text-emerald-200"
                : paused
                ? "text-amber-800 dark:text-amber-200"
                : "text-zinc-700 dark:text-zinc-200"
            )}
          >
            {statusText}
          </span>
          {phase && running && (
            <span className="truncate rounded bg-white/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-zinc-900/40 dark:text-emerald-300">
              {phase.replace("_", " ")}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!isRunning) {
              setPaused(false);
              return;
            }
            setPaused((v) => !v);
            window.dispatchEvent(new CustomEvent("loop:requestStop"));
          }}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
            paused
              ? "text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
              : "text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60"
          )}
        >
          <Pause size={10} />
          {paused ? "Paused" : "Pause"}
        </button>
      </div>

      {/* Body — `nodrag nopan` here means React Flow won't try to drag
          or pan the canvas when the user mouses down on any of the
          children below. The drag handle is exclusively the header. */}
      <div
        className="nodrag nopan flex h-[calc(100%-36px)] flex-col gap-2 p-2.5"
        onPointerDown={stopReactFlowPointer}
        onMouseDown={stopReactFlowPointer}
        onTouchStart={stopReactFlowPointer}
        onClick={stopReactFlowPointer}
      >
        {/* Project picker — the user picks which workspace this task
            belongs to. Click the chip to open a popover with existing
            projects (expandable to show sessions) + a "New project"
            affordance + per-project "+" to add a session. */}
        <ProjectPicker
          projectId={projectId}
          sessionId={sessionId}
          onChange={(pid, sid) => {
            setProjectId(pid);
            setSessionId(sid);
          }}
          onNewProject={() => setShowNewProject(true)}
          onNewSession={(pid) => setNewSessionProjectId(pid)}
          noDrag
        />

        {/* Task chip row. Shows the current task title; the + resets
            the chatbot (clears the prompt + editing state) without
            touching the project selection. */}
        <div className="flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11.5px] font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            <Sparkles size={10} className="shrink-0 text-emerald-500" />
            <span className="truncate">{chipLabel}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              useWorkflow.getState().setCurrentTask(null);
              useWorkflow.getState().resetNodeStatuses();
              setEditing(false);
              setPrompt("");
            }}
className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-dashed border-zinc-300 text-zinc-400 transition-colors hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
             title="Start a new task"
          >
            <Plus size={12} />
          </button>
        </div>

        {/* Prompt — auto-enters edit mode on click anywhere in the area.
            The textarea is the same component either way; the only
            difference is the visual treatment (text vs highlighted
            preview). The progress panel lives on the dedicated
            Progress node on the canvas (its own rich-UI card),
            not inside the chatbot — keeps the chat surface focused
            on typing + dispatching. */}
        <div
          onClick={() => !isRunning && setEditing(true)}
          className={cn(
            "nodrag min-h-[68px] flex-1 cursor-text rounded-lg border bg-white px-2.5 py-1.5 text-[12px] leading-relaxed dark:bg-zinc-900",
            editing
              ? "border-emerald-400 ring-1 ring-emerald-400/30"
              : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600",
            isRunning && "pointer-events-none opacity-60"
          )}
        >
          {editing ? (
            <textarea
              ref={textareaRef}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              placeholder="Describe what you want done. e.g. 'Show me who's using the keyword in H1, and sort by page load time descending'"
              className="nodrag block w-full resize-none border-0 bg-transparent text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-600"
            />
          ) : prompt.trim() ? (
            <p className="pointer-events-none text-zinc-800 dark:text-zinc-100">
              {renderHighlighted(prompt)}
            </p>
          ) : (
            <p className="pointer-events-none text-zinc-400">
              Click to type instructions. Press{" "}
              <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-800">
                Enter
              </kbd>{" "}
              to send.
            </p>
          )}
        </div>

        {/* Attached images. */}
        {images.length > 0 && (
          <div className="nodrag flex flex-wrap gap-1">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative h-10 w-10 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700"
                title={img.name}
              >
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImage(img.id);
                  }}
                  className="absolute right-0 top-0 grid h-3.5 w-3.5 place-items-center rounded-bl-md bg-black/60 text-white"
                >
                  <X size={8} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="nodrag text-[10.5px] text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}

        {/* Action row — Attach, Edit, mic, send. */}
        <div className="nodrag mt-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <ActionPill
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            icon={<Paperclip size={11} />}
            label="Attach"
          />
          <ActionPill
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
            icon={<Pencil size={11} />}
            label={editing ? "Done" : "Edit"}
            active={editing}
          />
          <div className="flex flex-1 items-center justify-end gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // Mic is a UI placeholder in v1.
                setPaused((v) => !v);
              }}
              className="nodrag grid h-7 w-7 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="Voice input (coming soon)"
            >
              <Mic size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleSend();
              }}
              disabled={
                submitting ||
                (!prompt.trim() && images.length === 0) ||
                isRunning
              }
              className={cn(
                "nodrag grid h-7 w-7 place-items-center rounded-full transition-colors",
                submitting || (!prompt.trim() && images.length === 0) || isRunning
                  ? "cursor-not-allowed bg-zinc-200 text-zinc-400 dark:bg-zinc-800"
                  : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              )}
              title={isRunning ? "Stop the loop first" : "Send (Enter)"}
            >
              {submitting ? (
                <Crosshair size={12} className="animate-spin" />
              ) : (
                <ArrowUp size={13} strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>

        {isRunning && currentTask && (
          <div className="nodrag flex items-center gap-1 border-t border-zinc-100 pt-1.5 text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <CheckCircle2 size={10} className="text-emerald-500" />
            <span className="truncate">
              Attempt {currentTask.attempt}/{currentTask.maxAttempts}
            </span>
            <span className="ml-auto flex items-center gap-0.5">
              <ImageIcon size={9} />
              {images.length} attached
            </span>
          </div>
        )}

        {/* Persistent task card — visible only when a task is active.
            Hosts the Rewrite (inline edit) and Delete (confirmation modal)
            actions. See docs/superpowers/specs/2026-07-04-chatbot-...md. */}
        <PersistentTaskCard
          state={chatbotState}
          onRewrite={handleRewrite}
          onDelete={handleDelete}
        />

        {/* Hybrid chatbot thread + input. Renders canned replies keyed
            off the active taskMirror / plan / diff / verdict / logs. */}
        <ChatThread messages={messages} />
        <ChatInput
          placeholder={
            currentTaskId
              ? "Ask me about the task or project…"
              : "No active task — assign one above to chat"
          }
          onSubmit={handleChatSubmit}
        />
      </div>

      {/* New-project modal — opened from the project picker's footer.
          After create, we auto-select the new project so the user
          doesn't have to re-open the popover and find it. */}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={(p: Project) => {
            setProjectId(p.id);
            setSessionId(undefined);
            setShowNewProject(false);
          }}
        />
      )}

      {/* New-session modal — opened from the per-project "+" icon in
          the picker. The picker passes the project id; we look up
          its name for the modal title. On create, the new session
          is auto-selected so the chip immediately reflects the
          project / session pair. */}
      {newSessionProjectId && (
        <NewSessionModal
          projectId={newSessionProjectId}
          projectName={
            allProjects.find((p) => p.id === newSessionProjectId)?.name ??
            "(unknown project)"
          }
          onClose={() => setNewSessionProjectId(null)}
          onCreated={(s) => {
            setProjectId(s.projectId);
            setSessionId(s.id);
            setNewSessionProjectId(null);
          }}
        />
      )}
    </div>
  );
}

function ActionPill({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "nodrag flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export const ChatbotNode = memo(ChatbotNodeImpl);
