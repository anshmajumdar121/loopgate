import { useEffect, useState } from "react";
import { ExternalLink, FlaskConical, RotateCcw, X } from "lucide-react";

export interface PublicDemoInfo {
  publicDemo: boolean;
  /** GitHub Pages build: a recorded run replayed in the browser. */
  staticPreview?: boolean;
  repoUrl?: string;
  batch?: { items?: string[] };
  limits?: { maxItems?: number };
  hint?: string;
}

/**
 * Notice shown only when GET /api/demo answers: the hosted public demo
 * (LOOP_PUBLIC_DEMO=1) or the static GitHub Pages preview. Tells visitors
 * what is real and what is stubbed so disabled features don't look broken.
 * Renders nothing against a normal backend (404).
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

  if (!info) return null;

  if (info.staticPreview) {
    const items = info.batch?.items ?? [];
    return (
      <div
        role="status"
        aria-label="Demo preview notice"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b-2 border-amber-400 bg-amber-100 px-4 py-2 text-[12.5px] text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
      >
        <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <strong>Demo preview only — this is not the full project.</strong> This page replays a recorded Loopgate run
          in your browser so you can look around: there is no server and no LLM, and nothing you type is executed.
          {items.length > 0 && (
            <>
              {" "}
              The recorded batch builds landing pages for {items.join(", ")}; the verifier rejects FAIL-ME Corp, which
              retries and then escalates.
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => void fetch("/api/__static/replay", { method: "POST" })}
          className="inline-flex items-center gap-1 rounded-md border border-amber-500 bg-white/70 px-2 py-1 font-semibold hover:bg-white dark:border-amber-700 dark:bg-amber-900/60 dark:hover:bg-amber-900"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Replay run
        </button>
        {info.repoUrl && (
          <a
            href={info.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-amber-900 px-2 py-1 font-semibold text-amber-50 hover:bg-amber-800 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
          >
            Get the full project
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </div>
    );
  }

  if (dismissed) return null;
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
