import { useState, useEffect, useCallback } from "react";
import { TopBar } from "@/components/TopBar";
import { Sidebar, type SidebarView } from "@/components/Sidebar";
import { Canvas } from "@/components/canvas/Canvas";
import { NodeConfigPanel } from "@/components/NodeConfigPanel";
import { LiveLogStrip } from "@/components/LiveLogStrip";
import { StopConfirmModal } from "@/components/StopConfirmModal";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { ImprovePanel } from "@/components/ImprovePanel";
import { useLoopSocket } from "@/hooks/useLoopSocket";
import { useWorkflow } from "@/lib/store";
import { useTaskList } from "@/lib/useTaskList";
import { NewTaskModal } from "@/components/NewTaskModal";
import { ChatbotLab } from "@/pages/ChatbotLab";
import { BatchPanel } from "@/components/batch/BatchPanel";
import { selectTask } from "@/lib/selectTask";
import { useFollowActiveTask } from "@/lib/useFollowActiveTask";
import { PublicDemoBanner } from "@/components/PublicDemoBanner";

export default function App() {
  // Dev-only escape hatch: /chatbot-lab renders the lab page instead of
  // the main UI. Vite tree-shakes the import.meta.env.DEV branch from prod.
  if (import.meta.env.DEV && window.location.pathname === "/chatbot-lab") {
    return <ChatbotLab />;
  }
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showNewTask, setShowNewTask] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  // "workflow" → Canvas + NodeConfigPanel (default)
  // "connections" → ConnectionsPanel replaces Canvas
  const [activeView, setActiveView] = useState<SidebarView>("workflow");
  const { subscribe } = useLoopSocket();
  // Mounted once at the app root so every view follows the same active loop
  // and batch updates can trigger an immediate active-task refresh.
  useFollowActiveTask({ subscribe });
  const isRunning = useWorkflow((s) => s.isRunning);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const setCurrentTask = useWorkflow((s) => s.setCurrentTask);
  const setFollowLive = useWorkflow((s) => s.setFollowLive);
  const resetNodeStatuses = useWorkflow((s) => s.resetNodeStatuses);
  const taskMirror = useWorkflow((s) => s.taskMirror);
  const loadTask = useWorkflow((s) => s.loadTask);
  const { refresh: refreshTasks } = useTaskList();

  // Stop is destructive. Both the TopBar and the canvas-level RunButton
  // fire window "loop:requestStop" — App owns the confirmation modal so
  // there's one place to centralise the actual POST + reset.
  useEffect(() => {
    const onRequestStop = () => {
      if (!isRunning) return;
      setShowStopConfirm(true);
    };
    window.addEventListener("loop:requestStop", onRequestStop);
    return () => window.removeEventListener("loop:requestStop", onRequestStop);
  }, [isRunning]);

  const handleStopConfirm = useCallback(async () => {
    if (!currentTaskId) return;
    try {
      await fetch(`/api/tasks/${currentTaskId}/stop`, { method: "POST" });
    } catch {
      /* best-effort — backend may already be down */
    }
    // Do NOT call resetTaskState() here — we want the UI to stay bound
    // to the just-cancelled task so the user can see the "Cancelled" badge
    // and click Resume/Reset. The backend's stopLoop() broadcasts a
    // task_update with status="cancelled"; the WS handler in
    // useLoopSocket.ts will flip isRunning to false via
    // applyTaskStatusToNodes. Wiping currentTaskId here would also drop
    // that update (the handler filters by currentTaskId), leaving the top
    // bar stuck on "running" — which is what the user was reporting.
    setShowStopConfirm(false);
    void refreshTasks();
  }, [currentTaskId, refreshTasks]);

  // Refresh the task list whenever the active task changes (new task started
  // or current one finished/cancelled). The hook is cheap — single GET.
  useEffect(() => {
    void refreshTasks();
  }, [currentTaskId, isRunning, refreshTasks]);

  // Listen for the CustomEvent dispatched by the canvas-level RunButton's
  // "+" icon. The canvas doesn't have direct access to setShowNewTask, so
  // it bubbles up through the window. A global Zustand action would also
  // work — chosen here to avoid touching the store for one consumer.
  useEffect(() => {
    const onNewTask = () => {
      if (isRunning) return;
      setShowNewTask(true);
    };
    window.addEventListener("loop:newTask", onNewTask);
    return () => window.removeEventListener("loop:newTask", onNewTask);
  }, [isRunning]);

  const handleNewTask = () => {
    if (isRunning) return;
    setShowNewTask(true);
  };

  const handleTaskCreated = (taskId: string) => {
    setShowNewTask(false);
    setCurrentTask(taskId);
    // For a freshly-created task, the orchestrator is just kicking off, so
    // mark it running. setCurrentTask alone leaves isRunning=false (the
    // conservative default for selecting an existing task); we flip it
    // here because we know the backend just started the loop.
    useWorkflow.setState({ isRunning: true });
    resetNodeStatuses();
    subscribe(taskId);
    void refreshTasks();
  };

  // Clicking a batch item jumps to its task on the canvas. Uses App's own
  // socket handle (not useSelectTask) so the drawer never owns a socket.
  const handleSelectBatchTask = useCallback(
    (taskId: string) => {
      setShowBatch(false);
      setActiveView("workflow");
      // A deliberate batch-item click opts out of automatic following.
      setFollowLive(false);
      void selectTask(taskId, loadTask, subscribe);
    },
    [loadTask, setFollowLive, subscribe]
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white text-zinc-900 transition-colors duration-200 dark:bg-zinc-950 dark:text-zinc-100">
      <PublicDemoBanner />
      <TopBar
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onNewTask={handleNewTask}
        onOpenBatch={() => setShowBatch(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <Sidebar
            onNewTask={handleNewTask}
            activeView={activeView}
            onNavigate={setActiveView}
            onOpenBatch={() => setShowBatch(true)}
            batchOpen={showBatch}
          />
        )}
        {activeView === "connections" ? (
          <ConnectionsPanel onBack={() => setActiveView("workflow")} />
        ) : activeView === "improve" ? (
          <ImprovePanel
            onTaskCreated={(taskId) => {
              setActiveView("workflow");
              setCurrentTask(taskId);
              useWorkflow.setState({ isRunning: true });
              resetNodeStatuses();
              subscribe(taskId);
              void refreshTasks();
            }}
          />
        ) : (
          <>
            <Canvas />
            <NodeConfigPanel />
          </>
        )}
      </div>
      <LiveLogStrip />
      {showNewTask && (
        <NewTaskModal
          onClose={() => setShowNewTask(false)}
          onCreated={handleTaskCreated}
        />
      )}
      {showBatch && (
        <BatchPanel
          onClose={() => setShowBatch(false)}
          onSelectTask={handleSelectBatchTask}
        />
      )}
      {showStopConfirm && taskMirror && (
        <StopConfirmModal
          taskTitle={taskMirror.title}
          attempt={taskMirror.attempt}
          maxAttempts={taskMirror.maxAttempts}
          onClose={() => setShowStopConfirm(false)}
          onConfirm={handleStopConfirm}
        />
      )}
    </div>
  );
}