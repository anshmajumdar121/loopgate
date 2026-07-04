import { useState } from "react";
import { matchIntent, type ChatbotState } from "../components/canvas/chatbotIntents.js";
import { ChatThread, type ChatMessage } from "../components/canvas/ChatThread.js";
import { ChatInput } from "../components/canvas/ChatInput.js";
import { PersistentTaskCard } from "../components/canvas/PersistentTaskCard.js";
import type { TaskStatus } from "../types/loop.js";

/**
 * Dev-only route at /chatbot-lab. Mounts the chatbot components against a
 * synthetic ChatbotState driven by URL params so the 8 intents can be
 * exercised without spinning up the planner/maker/verifier.
 *
 * URL params:
 *   ?status=planning|implementing|verifying|done|...
 *   ?prompt=...
 *   ?workdir=...
 *
 * Gated by `import.meta.env.DEV` so Vite tree-shakes the page from prod.
 */
export function ChatbotLab() {
  const sp = new URLSearchParams(window.location.search);
  const prompt = sp.get("prompt") ?? "Refactor the auth flow";
  const workdir = sp.get("workdir") ?? "/Users/anshmajumdar/Desktop/Loop Agent";
  const status = (sp.get("status") ?? "implementing") as TaskStatus;
  const createdAt = new Date(Date.now() - 12_000).toISOString();

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const state: ChatbotState = {
    currentTaskId: "lab-task",
    taskMirror: {
      id: "lab-task",
      title: prompt,
      prompt,
      workdir,
      status,
      attempt: 1,
      maxAttempts: 3,
      createdAt,
      updatedAt: createdAt,
      history: [],
      logs: [
        { ts: new Date().toISOString(), agent: "planner", stream: "info", text: "Plan emitted." },
        { ts: new Date().toISOString(), agent: "maker", stream: "info", text: "Implementation done." },
      ],
    },
    plan: {
      steps: 3,
      filesToTouch: ["src/api/auth.ts", "src/middleware/session.ts"],
      criteria: ["login works", "session persists"],
      risks: ["breaking existing sessions"],
      notes: "Refactor auth flow",
      rawGoal: "Refactor auth flow",
    },
    diff: {
      attempt: 1,
      filesChanged: [
        { path: "src/api/auth.ts", reason: "extracted session validator" },
      ],
      buildExit: 0,
      testsPassed: 12,
      testsFailed: 0,
      testsLintExit: 0,
      notes: "Refactored session validation",
    },
    verdict: {
      attempt: 1,
      outcome: "REJECT",
      buildExit: 0,
      testsPassed: 12,
      testsFailed: 0,
      scopePass: true,
      intentPass: true,
      noCheatingPass: true,
      risk: "MEDIUM",
      criteriaWalk: [],
      requiredFixes: ["Add CSRF token check"],
      oneLineReason: "Missing CSRF protection",
    },
    logs: [
      { ts: new Date().toISOString(), agent: "planner", stream: "info", text: "Plan emitted." },
      { ts: new Date().toISOString(), agent: "maker", stream: "info", text: "Implementation done." },
    ],
  };

  const noop = async () => {
    /* lab-only — no real API calls */
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <h1 className="text-lg font-semibold mb-2">Chatbot Lab (dev only)</h1>
      <p className="text-xs text-zinc-500 mb-4">
        Drive initial state via URL params:{" "}
        <code className="text-zinc-300">?status=planning</code>,{" "}
        <code className="text-zinc-300">?prompt=...</code>,{" "}
        <code className="text-zinc-300">?workdir=...</code>
      </p>
      <div className="max-w-md mx-auto bg-zinc-900 rounded-2xl border border-white/10 overflow-hidden">
        <PersistentTaskCard state={state} onRewrite={noop} onDelete={noop} />
        <ChatThread messages={messages} />
        <ChatInput
          placeholder="Try: plan, files, workdir, help, logs, verdict, diff, status"
          onSubmit={(message) => {
            const intent = matchIntent(message, state);
            setMessages((prev) => [
              ...prev,
              { role: "user", content: message, timestamp: Date.now() },
              { role: "bot", content: intent.render(state), timestamp: Date.now() },
            ]);
          }}
        />
      </div>
    </div>
  );
}