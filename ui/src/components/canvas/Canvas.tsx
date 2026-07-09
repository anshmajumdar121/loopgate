import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type NodeMouseHandler,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { WorkflowNode } from "./WorkflowNode";
import { ChatbotNode } from "./ChatbotNode";
import { ProgressNode } from "./ProgressNode";
import { AnimatedEdge } from "./AnimatedEdge";
import { useWorkflow } from "@/lib/store";
import type { WorkflowNodeData } from "@/lib/layout";
import { RunButton } from "./RunButton";
import { CanvasToolbar } from "./CanvasToolbar";

// React Flow's `nodeTypes` map. The keys here must match the `type`
// field set by `layoutFromSpec` (workflow / chatbot / progress).
const nodeTypes = {
  workflow: WorkflowNode,
  chatbot: ChatbotNode,
  progress: ProgressNode,
};
const edgeTypes = { animated: AnimatedEdge };

function CanvasInner() {
  const nodes = useWorkflow((s) => s.nodes);
  const edges = useWorkflow((s) => s.edges);
  const onNodesChange = useWorkflow((s) => s.onNodesChange);
  const onEdgesChange = useWorkflow((s) => s.onEdgesChange);
  const onConnect = useWorkflow((s) => s.onConnect);
  const setSelected = useWorkflow((s) => s.setSelected);
  const isRunning = useWorkflow((s) => s.isRunning);
  const theme = useWorkflow((s) => s.theme);
  const locked = useWorkflow((s) => s.locked);

  // Mark edges "active" while a run is in flight
  const styledEdges = useMemo(() => {
    if (!isRunning) {
      return edges.map((e) => ({ ...e, data: { ...e.data, active: false } }));
    }
    // Edges that should animate while a task is running. We light up the
    // entry point (chatbot → orchestrator) so the user sees their input
    // traveling into the loop, and the orchestrator → progress wire so
    // the progress node "receives" updates. The remaining wires (the
    // main spine) are highlighted by `node_status` events through the
    // pill node's status — no need to re-mark them here.
    const runSet = new Set([
      "chatbot-orchestrator",
      "orchestrator-planner",
      "orchestrator-progress",
    ]);
    return edges.map((e) => ({
      ...e,
      data: {
        ...e.data,
        active: runSet.has(`${e.source}-${e.target}`),
      },
    }));
  }, [edges, isRunning]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => setSelected(node.id),
    [setSelected]
  );

  return (
    <div className="relative flex-1 bg-zinc-50 transition-colors duration-200 dark:bg-zinc-950">
      <CanvasToolbar />
      <ReactFlow
        nodes={nodes as Node<WorkflowNodeData>[]}
        edges={styledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ type: "animated" }}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
        nodesDraggable={!locked}
        nodesConnectable={!locked}
        elementsSelectable
        className="bg-zinc-50 dark:bg-zinc-950"
      >
        <defs>
          {/* Arrowhead markers — sized small so they sit flush against
              the icon-circle without dominating it. Fill matches the
              edge tone (see AnimatedEdge.markerName). */}
          <marker
            id="marker-primary"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
          </marker>
          <marker
            id="marker-success"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
          </marker>
          <marker
            id="marker-danger"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f43f5e" />
          </marker>
          <marker
            id="marker-muted"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
          <marker
            id="marker-active"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10b981" />
          </marker>
        </defs>
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color={theme === "dark" ? "#3f3f46" : "#d4d4d8"}
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(n) => {
            const status = (n.data as { status?: string })?.status;
            if (status === "success") return "#10b981";
            if (status === "running") return "#10b981";
            if (status === "error") return "#f43f5e";
            if (status === "skipped") return "#a1a1aa";
            return "#a1a1aa";
          }}
        />
      </ReactFlow>
      {locked && (
        <div className="pointer-events-none absolute right-4 top-20 z-10 flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50/95 px-2.5 py-1 text-[11px] font-medium text-amber-700 shadow-sm backdrop-blur dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Workflow locked
        </div>
      )}
      <RunButton onNewTask={() => {
        // The canvas-level RunButton only opens the modal when idle; for the
        // running-state it has its own stop button. The actual new-task
        // modal is mounted at App level so both TopBar and Sidebar can
        // trigger it; here we just dispatch a CustomEvent the App listens
        // for.
        window.dispatchEvent(new CustomEvent("loop:newTask"));
      }} />
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
