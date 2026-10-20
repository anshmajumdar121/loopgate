import { useEffect, useState } from "react";
import { FlaskConical, X } from "lucide-react";

export interface PublicDemoInfo {
  publicDemo: boolean;
  limits?: { maxItems?: number };
  hint?: string;
}

/**
 * Slim notice shown only when the backend runs with LOOP_PUBLIC_DEMO=1
 * (GET /api/demo answers). Tells visitors what is real (the loop, the
 * guarantees) and what is stubbed (the LLM), so disabled features don't
 * look broken. Renders nothing against a normal backend (404).
 */
export function PublicDemoBanner() {
  const [info, setInfo] = useState<PublicDemoInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/demo")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PublicDemoInfo | null) => {
        if (alive && d?.publicDemo) setInfo(d);
      })
      .catch(() => {
        /* not a demo backend */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!info || dismissed) return null;
  const maxItems = info.limits?.maxItems;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <strong>Public demo</strong> — every run uses an offline, deterministic fake LLM. Connections, folders and real
        models are disabled and data resets on restart. Open <strong>Batch</strong>
        {maxItems ? ` (up to ${maxItems} items)` : ""} to watch plan → make → verify.
        {info.hint ? ` ${info.hint}` : ""}
      </span>
      <button
        type="button"
        aria-label="Dismiss demo notice"
        onClick={() => setDismissed(true)}
        className="rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
