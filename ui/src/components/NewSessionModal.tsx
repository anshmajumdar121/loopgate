import { useState } from "react";
import { Plus, X, Layers } from "lucide-react";
import type { Session } from "@/types/loop";

interface NewSessionModalProps {
  /** The project this session will live under. Pre-filled & locked. */
  projectId: string;
  /** Project name, shown in the modal title for context. */
  projectName: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}

/**
 * Quick-create modal for a Session inside a Project. Mirrors
 * `NewProjectModal` — same shell, same input layout — so creating a
 * session feels identical to creating a project. The project is fixed
 * (the user picked it from the project picker); only the session name
 * and description are user input.
 */
export function NewSessionModal({
  projectId,
  projectName,
  onClose,
  onCreated,
}: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: trimmed,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `POST /api/sessions → ${res.status}`
        );
      }
      const data = (await res.json()) as { session: Session };
      onCreated(data.session);
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
        className="w-[460px] max-w-[90vw] rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Layers size={16} className="text-violet-600" />
            <h2 className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
              New Session
            </h2>
            <span className="truncate rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              in {projectName}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X size={15} />
          </button>
        </div>

        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Session name
        </label>
        <input
          autoFocus
          type="text"
          placeholder="e.g. Real Agent Spawning, Phase 4 polish, …"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) void handleCreate();
            if (e.key === "Escape" && !submitting) onClose();
          }}
          className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Description (optional)
        </label>
        <textarea
          rows={2}
          placeholder="What is this session about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

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
            onClick={handleCreate}
            disabled={!name.trim() || submitting}
            className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
          >
            <Plus size={13} />
            {submitting ? "Creating…" : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
