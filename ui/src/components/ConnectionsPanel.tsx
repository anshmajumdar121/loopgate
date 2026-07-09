import { useState } from "react";
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
} from "lucide-react";
import { useConnectionList } from "@/lib/useConnectionList";
import { NewConnectionModal } from "@/components/NewConnectionModal";
import type { Connection } from "@/types/loop";

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
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

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
        <button
          onClick={() => setCreating(true)}
          className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          <Plus size={13} />
          Add connection
        </button>
      </header>

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

        <div className="flex flex-col gap-3">
          {connections.map((c) => (
            <ConnectionCard
              key={c.id}
              connection={c}
              onEdit={() => setEditing(c)}
              onDelete={() => handleDelete(c)}
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
            if (editing) await update(editing.id, input);
            else await create(input);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

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
  busy,
}: {
  connection: Connection;
  onEdit: () => void;
  onDelete: () => void;
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
            disabled={busy}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Edit connection"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
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
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          <Cpu size={10} />
          Model
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
