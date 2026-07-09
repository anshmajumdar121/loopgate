import { Plus, Sparkles, Square } from "lucide-react";
import { useWorkflow } from "@/lib/store";

/**
 * Floating action button at the bottom of the canvas. Two states:
 *   - idle: "+" — fires `loop:newTask` (App picks it up and opens the modal)
 *   - running: red square — fires `loop:requestStop` (App shows a
 *     confirmation modal before issuing POST /tasks/:id/stop)
 *
 * Both events bubble up to App so the modal state lives in one place.
 */
interface RunButtonProps {
  onNewTask: () => void;
}

export function RunButton({ onNewTask }: RunButtonProps) {
  const isRunning = useWorkflow((s) => s.isRunning);
  const phase = useWorkflow((s) => s.phase);

  const handleStop = () => {
    window.dispatchEvent(new CustomEvent("loop:requestStop"));
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-zinc-200 bg-white/95 p-1 shadow-card backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
        {isRunning ? (
          <button
            onClick={handleStop}
            className="relative grid h-10 w-10 place-items-center rounded-full bg-rose-500 text-white shadow-sm transition hover:bg-rose-600"
            title="Stop loop"
          >
            <Square size={14} fill="currentColor" />
            <span className="absolute inset-0 animate-ping rounded-full bg-rose-400 opacity-40" />
          </button>
        ) : (
          <button
            onClick={onNewTask}
            className="relative grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-violet-500 text-white shadow-sm transition hover:from-violet-700 hover:to-violet-600"
            title="Start a new task"
          >
            <Plus size={16} />
          </button>
        )}
        {isRunning && phase && (
          <span className="flex h-9 items-center gap-1.5 px-2 text-[12px] font-medium capitalize text-violet-700 dark:text-violet-300">
            {phase.replace("_", " ")}
          </span>
        )}
        <button className="flex h-9 items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-600/10 to-fuchsia-500/10 px-3 text-[12px] font-medium text-violet-700 hover:from-violet-600/20 hover:to-fuchsia-500/20 dark:text-violet-300">
          <Sparkles size={12} />
          AI Assistant
        </button>
      </div>
    </div>
  );
}