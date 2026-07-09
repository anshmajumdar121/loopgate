import { useState, useEffect, useMemo } from "react";
import {
  Sparkles,
  Save,
  ChevronDown,
  ChevronUp,
  Globe,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWorkflow } from "@/lib/store";
import { useConnectionList } from "@/lib/useConnectionList";
import { cn } from "@/lib/utils";
import {
  type NodeGroup,
  type NodeGroupId,
  getGroupForNode,
  NODE_GROUPS,
  NON_AGENT_NODES,
} from "@/lib/nodeGroups";
import {
  MODEL_OPTIONS,
  dynamicModelOptions,
} from "@/types/loop";

/**
 * Right-panel content when no task is active. Click any canvas node →
 * shows the model config for that node's group (orchestration / planning /
 * implementation / review). Single picker per group — nodes that share a
 * group share the same model.
 *
 * Save collapses the picker into a compact chip showing the chosen model.
 * Double-click the chip to expand again. Local state; reset on node
 * change so the next node the user clicks is visible.
 */
export function NodeModelPanel() {
  const selectedNodeId = useWorkflow((s) => s.selectedNodeId);
  const group = getGroupForNode(selectedNodeId);

  // Auto-expand when the user selects a different node (so they see
  // what's there rather than a stale collapsed chip from the previous
  // node).
  const [isOpen, setIsOpen] = useState(true);
  useEffect(() => {
    setIsOpen(true);
  }, [selectedNodeId]);

  if (!group) {
    return <NonAgentPanel nodeId={selectedNodeId} />;
  }

  return (
    <GroupPanel
      key={group.id}
      group={group}
      isOpen={isOpen}
      onCollapse={() => setIsOpen(false)}
      onExpand={() => setIsOpen(true)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GroupPanel — the main panel for groups that DO have a model picker
// ─────────────────────────────────────────────────────────────────────────────

function GroupPanel({
  group,
  isOpen,
  onCollapse,
  onExpand,
}: {
  group: NodeGroup;
  isOpen: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  const currentModel = useWorkflow((s) => s.nodeModels[group.id]);
  const setNodeModel = useWorkflow((s) => s.setNodeModel);
  const { connections } = useConnectionList();
  const modelOptions = useMemo(
    () => dynamicModelOptions(connections),
    [connections]
  );
  const modelLabel =
    modelOptions.find((m) => m.id === currentModel)?.label ?? currentModel;

  if (!isOpen) {
    // Collapsed chip — clickable to expand on double-click.
    return (
      <aside
        className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
        onDoubleClick={onExpand}
      >
        <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            {group.label} — model
          </div>
          <button
            type="button"
            onDoubleClick={onExpand}
            onClick={onExpand}
            className="group flex w-full items-center gap-2 rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2.5 text-left transition-colors hover:border-violet-400 hover:bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10 dark:hover:border-violet-400/60 dark:hover:bg-violet-500/15"
            title="Double-click to expand"
          >
            <Sparkles size={14} className="text-violet-600 dark:text-violet-400" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                {modelLabel}
              </div>
              <div className="truncate font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
                {currentModel}
              </div>
            </div>
            <ChevronDown
              size={14}
              className="text-zinc-400 transition-transform group-hover:translate-y-0.5"
            />
          </button>
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            {group.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            {group.nodeIds.map((nid) => (
              <span
                key={nid}
                className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              >
                {nid}
              </span>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
          <Sparkles size={16} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
            {group.label} — Model
          </h2>
          <p className="mt-0.5 truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
            {group.description}
          </p>
        </div>
        <button
          onClick={onCollapse}
          className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Collapse panel (save)"
        >
          <ChevronUp size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Currently
        </div>
        <SelectedChip modelId={currentModel} />

        <div className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Choose a model
        </div>
        <ModelOptionList
          value={currentModel}
          onChange={(id) => setNodeModel(group.id, id)}
        />

        <div className="mt-5 rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Affects
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {group.nodeIds.map((nid) => (
              <span
                key={nid}
                className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 shadow-sm dark:bg-zinc-800 dark:text-zinc-300"
              >
                {nid}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            Any node in this group will spawn with this model. Pick once —
            applies everywhere in the group.
          </p>
        </div>

        <OtherGroups />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <Button variant="ghost" size="md" onClick={onCollapse}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={onCollapse}>
          <Save size={13} />
          Save
        </Button>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pill showing which model is currently selected for this group.
 * Renders even before the user picks anything (initial state). Resolves
 * the id through the dynamic options list so custom models get their
 * friendly label too (falls back to raw id when we can't resolve).
 */
function SelectedChip({ modelId }: { modelId: string }) {
  const { connections } = useConnectionList();
  const options = useMemo(
    () => dynamicModelOptions(connections),
    [connections]
  );
  const opt = options.find((m) => m.id === modelId);
  return (
    <div className="flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50/40 px-3 py-2 dark:border-violet-500/30 dark:bg-violet-500/10">
      <Sparkles size={13} className="text-violet-600 dark:text-violet-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
          {opt?.label ?? modelId}
        </div>
        <div className="truncate font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400">
          {modelId}
        </div>
      </div>
      <CheckCircle2
        size={13}
        className="shrink-0 text-violet-600 dark:text-violet-400"
      />
    </div>
  );
}

/**
 * Same ModelPicker card layout as NewTaskModal. Kept inline here so the
 * NodeModelPanel doesn't import the modal's internal type. If the layout
 * drifts between the two, consider extracting to a shared component.
 *
 * Built-in models are listed first, followed by a divider, then user
 * connections' models — same ordering convention as NewTaskModal.
 */
function ModelOptionList({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { connections } = useConnectionList();
  const options = useMemo(
    () => dynamicModelOptions(connections),
    [connections]
  );
  const builtinCount = MODEL_OPTIONS.length;
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((m, idx) => {
        const isFirstCustom = idx === builtinCount;
        const selected = m.id === value;
        return (
          <div key={m.id}>
            {isFirstCustom && (
              <div className="my-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                Your connections
                <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              </div>
            )}
            <button
              type="button"
              onClick={() => onChange(m.id)}
              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                selected
                  ? "border-violet-500 bg-violet-50/60 dark:border-violet-400 dark:bg-violet-500/15"
                  : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/40 dark:border-zinc-700 dark:bg-zinc-800/60 dark:hover:border-zinc-600"
              }`}
            >
              <div
                className={cn(
                  "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2",
                  selected
                    ? "border-violet-600 bg-violet-600 dark:border-violet-400 dark:bg-violet-400"
                    : "border-zinc-300 dark:border-zinc-600"
                )}
              >
                {selected && (
                  <div className="h-1.5 w-1.5 rounded-full bg-white" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Sparkles
                    size={11}
                    className={
                      selected
                        ? "text-violet-600 dark:text-violet-400"
                        : "text-zinc-400"
                    }
                  />
                  <span className="truncate text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
                    {m.label}
                  </span>
                  <span className="ml-auto truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                    {m.provider}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  {m.blurb}
                </p>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Lets the user jump to a different group without losing the current
 * group's selection. Rendered at the bottom of an open GroupPanel.
 */
function OtherGroups() {
  const openGroup = useWorkflow((s) => {
    // Roundabout: we can't read selectedNodeId through the callback
    // pattern here, so re-derive from the store's selectedNodeId.
    return null;
  });
  const selectedNodeId = useWorkflow((s) => s.selectedNodeId);
  const setSelected = useWorkflow((s) => s.setSelected);
  const open = getGroupForNode(selectedNodeId)?.id;
  return (
    <details className="mt-5">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
        Switch to another group
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        {NODE_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            disabled={g.id === open}
            onClick={() => {
              // Pick the first node in the target group so the panel
              // updates its "selected node" state.
              setSelected(g.nodeIds[0]);
            }}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors",
              g.id === open
                ? "border-violet-300 bg-violet-50/60 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"
            )}
          >
            <span className="font-medium">{g.label}</span>
            <span className="ml-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              ({g.nodeIds.length} node{g.nodeIds.length === 1 ? "" : "s"})
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

/**
 * The right-panel content for nodes that don't run an agent (task input,
 * done, escalated). We use the same component shell so the panel always
 * renders a consistent aside — no awkward missing-panel state.
 *
 * Special cases for the new rich-UI nodes:
 *   - "chatbot"  → the live chat surface lives on the canvas itself;
 *     here we just point the user to the right place.
 *   - "progress" → mirrors the orchestrator's live phase; again, the
 *     canvas node is the source of truth, this panel just explains.
 */
function NonAgentPanel({ nodeId }: { nodeId: string | null }) {
  // Friendly copy for the new rich-UI nodes. Returning a different
  // component here would also work, but the shell stays consistent
  // across non-configurable nodes so the panel doesn't pop in/out.
  const isChatbot = nodeId === "chatbot";
  const isProgress = nodeId === "progress";

  let title = "Not a model-configurable node";
  let subtitle = nodeId
    ? `The “${nodeId}” node is a decision / terminal node — no LLM model applies.`
    : "Click any node on the canvas to configure its model.";

  if (isChatbot) {
    title = "Chatbot lives on the canvas";
    subtitle =
      "Type instructions, attach images, and press Enter to dispatch a task. Configure models per agent group on the planner / maker / verifier nodes instead.";
  } else if (isProgress) {
    title = "Progress is read-only here";
    subtitle =
      "This node mirrors the live status of the running task. Click any step in the node to expand its details — no configuration needed.";
  }

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          <Globe size={16} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            {subtitle}
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!isChatbot && !isProgress && (
          <>
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
              Nodes with model pickers:
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {NODE_GROUPS.map((g) => (
                <div
                  key={g.id}
                  className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[12px] dark:border-zinc-700 dark:bg-zinc-800/60"
                >
                  <div className="font-medium text-zinc-800 dark:text-zinc-200">
                    {g.label}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {g.nodeIds.map((nid) => (
                      <span
                        key={nid}
                        className="rounded bg-zinc-100 px-1 py-px font-mono text-[10px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                      >
                        {nid}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                Non-configurable: {NON_AGENT_NODES.join(", ")}, chatbot,
                progress
              </p>
            </div>
          </>
        )}
        {isChatbot && (
          <ol className="flex flex-col gap-2 text-[12.5px] text-zinc-700 dark:text-zinc-300">
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">1.</span>
              <span>
                Type your instructions in the prompt area. Press{" "}
                <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-800">
                  Enter
                </kbd>{" "}
                to send.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">2.</span>
              <span>
                Use <strong>Attach</strong> to add reference images to the
                task.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">3.</span>
              <span>
                Press <strong>Pause</strong> in the header to stop the loop
                mid-run.
              </span>
            </li>
          </ol>
        )}
        {isProgress && (
          <ol className="flex flex-col gap-2 text-[12.5px] text-zinc-700 dark:text-zinc-300">
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">1.</span>
              <span>Planning — agent writes GOAL.md.</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">2.</span>
              <span>Plan review — you confirm or adjust.</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">3.</span>
              <span>Implementation — agent edits the code.</span>
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-emerald-500">4.</span>
              <span>Verification — independent pass to approve or reject.</span>
            </li>
          </ol>
        )}
      </div>
    </aside>
  );
}