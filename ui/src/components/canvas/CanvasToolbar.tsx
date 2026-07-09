import {
  Lock,
  Unlock,
  LayoutGrid,
  Crosshair,
  RotateCcw,
} from "lucide-react";
import { useWorkflow } from "@/lib/store";
import { useReactFlow } from "@xyflow/react";

export function CanvasToolbar() {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const locked = useWorkflow((s) => s.locked);
  const toggleLock = useWorkflow((s) => s.toggleLock);
  const resetNodeStatuses = useWorkflow((s) => s.resetNodeStatuses);
  const resetTaskState = useWorkflow((s) => s.resetTaskState);

  const handleResetLayout = () => {
    useWorkflow.getState().resnapLayout();
    setTimeout(() => fitView({ duration: 350, padding: 0.18 }), 30);
  };

  const handleClear = () => {
    resetNodeStatuses();
    resetTaskState();
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-zinc-200 bg-white/90 px-1.5 py-1 shadow-card backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
        <ToolbarButton aria-label="Zoom out" onClick={() => zoomOut({ duration: 200 })}>
          <span className="text-[12px] font-semibold">−</span>
        </ToolbarButton>
        <button
          onClick={() => fitView({ duration: 350, padding: 0.18 })}
          className="grid h-7 w-14 place-items-center rounded-md text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Fit
        </button>
        <ToolbarButton aria-label="Zoom in" onClick={() => zoomIn({ duration: 200 })}>
          <span className="text-[12px] font-semibold">+</span>
        </ToolbarButton>
        <Divider />

        <button
          aria-label={locked ? "Unlock workflow" : "Lock workflow"}
          title={locked ? "Unlock — allow editing" : "Lock — freeze nodes"}
          onClick={toggleLock}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium transition-colors ${
            locked
              ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:hover:bg-amber-500/30"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
        >
          {locked ? <Lock size={12} /> : <Unlock size={12} />}
          {locked ? "Locked" : "Unlocked"}
        </button>

        <ToolbarButton
          aria-label="Reset layout"
          title="Reset nodes to default positions"
          onClick={handleResetLayout}
        >
          <LayoutGrid size={13} />
        </ToolbarButton>
        <ToolbarButton
          aria-label="Clear state"
          title="Clear run state + disconnect from task"
          onClick={handleClear}
        >
          <RotateCcw size={13} />
        </ToolbarButton>
        <ToolbarButton
          aria-label="Center view"
          title="Center and fit view"
          onClick={() => fitView({ duration: 350, padding: 0.18 })}
        >
          <Crosshair size={13} />
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="grid h-7 w-7 place-items-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />;
}