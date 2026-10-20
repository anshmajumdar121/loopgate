import { useMemo, useState, type FormEvent } from "react";
import { Play, Loader2, Info } from "lucide-react";
import { useWorkflow } from "@/lib/store";
import { useConnectionList } from "@/lib/useConnectionList";
import { createBatch } from "@/lib/batchApi";
import { dynamicModelOptions } from "@/types/loop";
import {
  ITEM_PLACEHOLDER_RE,
  MAX_BATCH_ITEMS,
  type Batch,
  type CreateBatchBody,
} from "@/types/batch";

/** Sentinel for "use the per-role picks from the canvas side panel". */
const CANVAS_MODELS = "__canvas__";

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";
const labelCls =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400";

export function parseItems(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Client-side mirror of the backend's zod schema. Returns null when valid. */
export function validateBatchInput(template: string, items: string[]): string | null {
  if (!template.trim()) return "Prompt template is required.";
  if (!ITEM_PLACEHOLDER_RE.test(template)) return "Prompt template must contain {{item}}.";
  if (items.length === 0) return "Add at least one item (one per line).";
  if (items.length > MAX_BATCH_ITEMS) return `Too many items: ${items.length} (max ${MAX_BATCH_ITEMS}).`;
  if (items.some((i) => i.length > 4000)) return "Each item must be 4000 characters or fewer.";
  return null;
}

/** Render the template exactly like the backend does ({{index}} is 1-based). */
export function renderTemplate(template: string, item: string, index: number): string {
  return template
    .replace(/\{\{\s*item\s*\}\}/g, item)
    .replace(/\{\{\s*index\s*\}\}/g, String(index + 1));
}

export function BatchForm({ onCreated }: { onCreated: (batch: Batch) => void }) {
  const nodeModels = useWorkflow((s) => s.nodeModels);
  const { connections } = useConnectionList();
  const modelOptions = useMemo(() => dynamicModelOptions(connections), [connections]);

  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("");
  const [itemsRaw, setItemsRaw] = useState("");
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [model, setModel] = useState<string>(CANVAS_MODELS);
  const [workdir, setWorkdir] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => parseItems(itemsRaw), [itemsRaw]);
  const hasPlaceholder = ITEM_PLACEHOLDER_RE.test(template);
  const preview = hasPlaceholder && items.length > 0 ? renderTemplate(template, items[0], 0) : null;
  const labelFor = (id: string) => modelOptions.find((m) => m.id === id)?.label ?? id;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const invalid = validateBatchInput(template, items);
    if (invalid) {
      setError(invalid);
      return;
    }
    // Same contract as NewTaskModal / ChatbotNode: always send explicit
    // per-role overrides so connection-only setups don't 400.
    const modelOverrides =
      model === CANVAS_MODELS
        ? { planning: nodeModels.planning, implementation: nodeModels.implementation, review: nodeModels.review }
        : { planning: model, implementation: model, review: model };
    const body: CreateBatchBody = {
      promptTemplate: template,
      items,
      title: title.trim() || undefined,
      maxAttempts,
      modelOverrides,
      ...(model !== CANVAS_MODELS ? { model } : {}),
      ...(workdir.trim() ? { workdir: workdir.trim() } : {}),
    };
    setSubmitting(true);
    setError(null);
    try {
      const batch = await createBatch(body);
      onCreated(batch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3.5" aria-label="New batch">
      <div>
        <label htmlFor="batch-title" className={labelCls}>
          Title (optional)
        </label>
        <input
          id="batch-title"
          type="text"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Add unit tests to every util"
          disabled={submitting}
          className={`${inputCls} h-9`}
        />
      </div>

      <div>
        <label htmlFor="batch-template" className={labelCls}>
          Prompt template
        </label>
        <textarea
          id="batch-template"
          rows={4}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder={"Write a vitest suite for {{item}}. All tests must pass."}
          disabled={submitting}
          aria-describedby="batch-template-hint"
          className={`${inputCls} resize-y py-2.5 font-mono text-[12.5px]`}
        />
        <p id="batch-template-hint" className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <Info size={11} aria-hidden />
          Use <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">{"{{item}}"}</code> for each
          line below; <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">{"{{index}}"}</code> is
          optional (1-based).
          {template.trim() && !hasPlaceholder && (
            <span className="ml-1 font-medium text-amber-600 dark:text-amber-400">Missing {"{{item}}"}</span>
          )}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="batch-items" className={labelCls}>
            Items (one per line)
          </label>
          <span
            data-testid="batch-item-count"
            className={`text-[11px] font-semibold ${
              items.length > MAX_BATCH_ITEMS ? "text-rose-600" : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        </div>
        <textarea
          id="batch-items"
          rows={6}
          value={itemsRaw}
          onChange={(e) => setItemsRaw(e.target.value)}
          placeholder={"src/lib/format.ts\nsrc/lib/layout.ts\nsrc/lib/utils.ts"}
          disabled={submitting}
          className={`${inputCls} resize-y py-2.5 font-mono text-[12px]`}
        />
      </div>

      {preview && (
        <div className="rounded-lg border border-dashed border-violet-300 bg-violet-50/50 px-3 py-2 dark:border-violet-500/30 dark:bg-violet-500/5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
            Preview — item 1
          </div>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[11.5px] text-zinc-700 dark:text-zinc-300">
            {preview}
          </p>
        </div>
      )}

      <div className="grid grid-cols-[1fr_110px] gap-2">
        <div>
          <label htmlFor="batch-model" className={labelCls}>
            Model
          </label>
          <select
            id="batch-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={submitting}
            className={`${inputCls} h-9 px-2.5`}
          >
            <option value={CANVAS_MODELS}>Canvas picks (per role)</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.provider}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="batch-attempts" className={labelCls}>
            Max attempts
          </label>
          <select
            id="batch-attempts"
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
            disabled={submitting}
            className={`${inputCls} h-9 px-2.5`}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      {model === CANVAS_MODELS && (
        <p className="-mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          Plan: <span className="font-medium text-zinc-700 dark:text-zinc-300">{labelFor(nodeModels.planning)}</span> ·
          Build: <span className="font-medium text-zinc-700 dark:text-zinc-300">{labelFor(nodeModels.implementation)}</span> ·
          Review: <span className="font-medium text-zinc-700 dark:text-zinc-300">{labelFor(nodeModels.review)}</span>
        </p>
      )}

      <div>
        <label htmlFor="batch-workdir" className={labelCls}>
          Working directory root (optional)
        </label>
        <input
          id="batch-workdir"
          type="text"
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          placeholder="Defaults to data/workspaces/batches/<id>"
          disabled={submitting}
          className={`${inputCls} h-9 font-mono text-[12px]`}
        />
      </div>

      {error && (
        <div role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          aria-label="Start batch"
          className="flex h-9 items-center gap-1.5 rounded-md bg-gradient-to-r from-violet-600 to-violet-500 px-4 text-[13px] font-medium text-white shadow-sm transition hover:from-violet-700 hover:to-violet-600 disabled:opacity-50"
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} fill="currentColor" />}
          {submitting
            ? "Starting…"
            : items.length
            ? `Run ${items.length} ${items.length === 1 ? "item" : "items"}`
            : "Run batch"}
        </button>
      </div>
    </form>
  );
}
