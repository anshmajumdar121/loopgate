import type { ReactNode } from "react";
import type {
  Task,
  PlanSummary,
  DiffSummary,
  Verdict,
  LogEntry,
} from "@/types/loop";

/**
 * State shape the chatbot intents consume. Mirrors the relevant fields of the
 * Zustand store (lib/store.ts). Keep this decoupled from the full store type
 * so intents can be tested with a slim synthetic state.
 */
export interface ChatbotState {
  currentTaskId: string | null;
  taskMirror: Task | null;
  plan: PlanSummary | null;
  diff: DiffSummary | null;
  verdict: Verdict | null;
  logs: LogEntry[];
}

export interface ChatbotIntent {
  id: string;
  keywords: (string | RegExp)[];
  render: (state: ChatbotState) => ReactNode;
  description: string;
}

const noTask = (msg: string): ReactNode => (
  <span className="text-zinc-400">{msg}</span>
);

// ─────────────────────────────────────────────────────────────────────────────
// Individual intent renderers
// ─────────────────────────────────────────────────────────────────────────────

const helpIntent: ChatbotIntent = {
  id: "help",
  keywords: ["help", "commands", "what can you do"],
  render: () => (
    <ul className="space-y-1 text-sm">
      {intents.map((i) => (
        <li key={i.id}>
          <span className="font-mono text-sky-400">{i.id}</span>
          <span className="text-zinc-400"> — {i.description}</span>
        </li>
      ))}
    </ul>
  ),
  description: "list available commands",
};

const statusIntent: ChatbotIntent = {
  id: "status",
  keywords: ["status", "phase", "progress", "what's happening", "is it done", "where are we"],
  render: (s) => {
    const t = s.taskMirror;
    if (!t) return noTask("No active task — assign one above to get started.");
    return (
      <span>
        Phase: <strong>{t.status}</strong> · Attempt {t.attempt} of {t.maxAttempts}
      </span>
    );
  },
  description: "current phase, attempt count",
};

const planIntent: ChatbotIntent = {
  id: "plan",
  keywords: ["plan", "what's the plan", "show plan", "roadmap", "approach"],
  render: (s) => {
    const t = s.taskMirror;
    if (!t) return noTask("No active task.");
    if (!s.plan) return <span className="text-amber-400">No plan yet — still planning.</span>;
    return (
      <div className="space-y-2 text-sm">
        <div className="font-medium">{s.plan.summary}</div>
        {s.plan.filesToTouch?.length ? (
          <ul className="list-disc pl-5 space-y-1">
            {s.plan.filesToTouch.map((f) => (
              <li key={f}>
                <a
                  href={`file://${t.workdir}/${f}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-sky-400 hover:text-sky-300"
                >
                  {f}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
  description: "the planner's plan: summary + files to touch",
};

const filesIntent: ChatbotIntent = {
  id: "files",
  keywords: ["files", "list files", "what files", "which files"],
  render: (s) => {
    const t = s.taskMirror;
    if (!t) return noTask("No active task.");
    const files = s.plan?.filesToTouch ?? [];
    if (!files.length) return <span className="text-zinc-400">No files listed.</span>;
    return (
      <ul className="list-disc pl-5 space-y-1 text-sm">
        {files.map((f) => (
          <li key={f}>
            <a
              href={`file://${t.workdir}/${f}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-sky-400 hover:text-sky-300"
            >
              {f}
            </a>
          </li>
        ))}
      </ul>
    );
  },
  description: "files this task will touch",
};

const diffIntent: ChatbotIntent = {
  id: "diff",
  keywords: ["diff", "what changed", "show diff", "changes"],
  render: (s) => {
    const t = s.taskMirror;
    if (!t) return noTask("No active task.");
    if (!s.diff) return <span className="text-zinc-400">No diff yet.</span>;
    return (
      <div className="space-y-2 text-sm">
        <div>{s.diff.summary}</div>
        {s.diff.filesChanged?.length ? (
          <ul className="list-disc pl-5 space-y-1">
            {s.diff.filesChanged.map((f) => (
              <li key={f}>
                <a
                  href={`file://${t.workdir}/${f}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-sky-400 hover:text-sky-300"
                >
                  {f}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
  description: "the maker's diff: files changed + summary",
};

const verdictIntent: ChatbotIntent = {
  id: "verdict",
  keywords: ["verdict", "approved", "rejected", "passed?", "failed?"],
  render: (s) => {
    if (!s.taskMirror) return noTask("No active task.");
    if (!s.verdict) return <span className="text-zinc-400">No verdict yet.</span>;
    const approved = s.verdict.outcome === "APPROVE";
    const tone = approved ? "text-emerald-400" : "text-rose-400";
    return (
      <div className="space-y-2 text-sm">
        <div>
          <span className={`font-semibold ${tone}`}>
            {approved ? "APPROVED" : "REJECTED"}
          </span>
        </div>
        {s.verdict.blockers?.length ? (
          <div>
            <div className="text-zinc-400">Blockers:</div>
            <ul className="list-disc pl-5">
              {s.verdict.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    );
  },
  description: "verifier verdict + blockers",
};

const workdirIntent: ChatbotIntent = {
  id: "workdir",
  keywords: ["workdir", "folder", "where", "project folder"],
  render: (s) => {
    if (!s.taskMirror?.workdir) return noTask("No active task — assign one to see its workdir.");
    return (
      <a
        href={`file://${s.taskMirror.workdir}`}
        target="_blank"
        rel="noopener noreferrer"
        className="underline text-sky-400 hover:text-sky-300 break-all"
      >
        {s.taskMirror.workdir}
      </a>
    );
  },
  description: "the workdir of the active task",
};

const logsIntent: ChatbotIntent = {
  id: "logs",
  keywords: ["logs", "show logs", "what just happened", "activity"],
  render: (s) => {
    if (!s.taskMirror) return noTask("No active task.");
    const last = (s.logs ?? []).slice(-20);
    if (!last.length) return <span className="text-zinc-400">No logs yet.</span>;
    return (
      <pre className="text-xs font-mono bg-zinc-900/60 p-2 rounded max-h-60 overflow-auto whitespace-pre-wrap">
        {last.map((l) => `[${l.ts}] ${l.agent}/${l.stream}: ${l.text}`).join("\n")}
      </pre>
    );
  },
  description: "last 20 log lines from the active task",
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export const intents: ChatbotIntent[] = [
  helpIntent,
  statusIntent,
  planIntent,
  filesIntent,
  diffIntent,
  verdictIntent,
  workdirIntent,
  logsIntent,
];

export function matchIntent(message: string, state: ChatbotState): ChatbotIntent {
  const lower = message.toLowerCase().trim();
  return (
    intents.find((intent) =>
      intent.keywords.some((kw) =>
        typeof kw === "string" ? lower.includes(kw) : kw.test(lower)
      )
    ) ?? helpIntent
  );
}