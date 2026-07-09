import { Play, Hand, Network, MessageSquare, Sparkles, ChevronUp } from "lucide-react";

export function BottomBar() {
  return (
    <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-ink-200 bg-white px-1.5 py-1 shadow-card">
        <button
          aria-label="Run"
          className="grid h-9 w-9 place-items-center rounded-full bg-accent-600 text-white shadow-sm transition hover:bg-accent-700"
        >
          <Play size={14} fill="currentColor" />
        </button>
        <div className="mx-1 h-5 w-px bg-ink-200" />
        <button
          aria-label="Pan"
          className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-ink-100/60"
        >
          <Hand size={14} />
        </button>
        <button
          aria-label="Layout"
          className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-ink-100/60"
        >
          <Network size={14} />
        </button>
        <button
          aria-label="Comment"
          className="grid h-8 w-8 place-items-center rounded-full text-ink-500 hover:bg-ink-100/60"
        >
          <MessageSquare size={14} />
        </button>
        <div className="mx-1 h-5 w-px bg-ink-200" />
        <button className="flex h-9 items-center gap-1.5 rounded-full bg-gradient-to-r from-accent-600 to-accent-500 px-3.5 text-[12.5px] font-medium text-white shadow-sm transition hover:from-accent-700 hover:to-accent-600">
          <Sparkles size={13} />
          AI Assistant
          <ChevronUp size={12} className="opacity-80" />
        </button>
      </div>
    </div>
  );
}
