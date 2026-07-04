import type { ReactNode } from "react";
import { IntentReply } from "./IntentReply.js";

export interface ChatMessage {
  role: "user" | "bot";
  content: ReactNode;
  timestamp: number;
}

interface Props {
  messages: ChatMessage[];
}

export function ChatThread({ messages }: Props) {
  if (!messages.length) {
    return (
      <div className="px-3 py-6 text-center text-xs text-zinc-500">
        Try asking: <span className="font-mono text-zinc-400">plan</span>,{" "}
        <span className="font-mono text-zinc-400">files</span>,{" "}
        <span className="font-mono text-zinc-400">workdir</span>,{" "}
        <span className="font-mono text-zinc-400">help</span>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 space-y-2 max-h-72 overflow-y-auto">
      {messages.map((m, i) => (
        <div
          key={i}
          className={`text-sm ${m.role === "user" ? "text-right" : "text-left"}`}
        >
          {m.role === "user" ? (
            <span className="inline-block bg-sky-500/15 text-sky-100 px-3 py-1.5 rounded-2xl">
              {m.content as string}
            </span>
          ) : (
            <IntentReply>{m.content}</IntentReply>
          )}
        </div>
      ))}
    </div>
  );
}