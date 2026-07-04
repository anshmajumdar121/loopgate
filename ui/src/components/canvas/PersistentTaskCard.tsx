import { useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { ChatbotState } from "./chatbotIntents.js";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal.js";

interface Props {
  state: ChatbotState;
  onRewrite: (newPrompt: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

function formatElapsed(createdAt: string | undefined, now: number): string {
  if (!createdAt) return "—";
  const start = new Date(createdAt).getTime();
  if (Number.isNaN(start)) return "—";
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function PersistentTaskCard({ state, onRewrite, onDelete }: Props) {
  const task = state.taskMirror;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Tick elapsed time every second
  useEffect(() => {
    if (!task) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [task?.id]);

  if (!task) return null;

  const phase = task.status;
  const isLocked = phase === "implementing" || phase === "verifying";

  const enterEdit = () => {
    setDraft(task.prompt);
    setEditing(true);
  };

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === task.prompt) return;
    setBusy(true);
    try {
      await onRewrite(trimmed);
      setEditing(false);
    } catch {
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3 mt-2 rounded-xl border border-white/10 bg-white/5 p-3">
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className="w-full text-sm bg-zinc-900/60 border border-white/10 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-sky-400/60"
            rows={3}
            disabled={busy}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="px-2 py-1 text-xs rounded bg-white/5 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !draft.trim() || draft.trim() === task.prompt}
              className="px-2 py-1 text-xs rounded bg-sky-500 text-white font-medium hover:bg-sky-400 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className="text-sm font-medium text-zinc-100 truncate"
                title={task.prompt}
              >
                {task.prompt.length > 60 ? task.prompt.slice(0, 60) + "…" : task.prompt}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={enterEdit}
                disabled={isLocked}
                title={isLocked ? "Wait for current phase to finish" : "Rewrite prompt"}
                className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
                aria-label="Rewrite"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={isLocked}
                title={isLocked ? "Wait for current phase to finish" : "Delete task"}
                className="p-1 rounded hover:bg-white/10 text-rose-400 disabled:opacity-30"
                aria-label="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-zinc-400">
            <span className="font-mono">{phase}</span>
            <span>·</span>
            <span>
              attempt {task.attempt} of {task.maxAttempts}
            </span>
            <span>·</span>
            <span className="font-mono">{formatElapsed(task.createdAt, now)} elapsed</span>
          </div>
        </>
      )}

      <ConfirmDeleteModal
        open={confirmOpen}
        title="Delete this task and its history?"
        body="This can't be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          setConfirmOpen(false);
          await onDelete();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}