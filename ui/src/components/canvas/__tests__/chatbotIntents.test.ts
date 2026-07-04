import { describe, it, expect } from "vitest";
import { matchIntent, intents } from "../chatbotIntents.js";
import type { Task } from "@/types/loop";

const emptyState = {
  currentTaskId: null,
  taskMirror: null,
  plan: null,
  diff: null,
  verdict: null,
  logs: [],
};

describe("matchIntent", () => {
  it.each([
    ["what's the plan?", "plan"],
    ["show me the files", "files"],
    ["approved?", "verdict"],
    ["where is the project", "workdir"],
    ["logs", "logs"],
    ["asdfgh", "help"],
    ["HELP", "help"],
    ["is it done?", "status"],
    ["? what can you do", "help"],
    ["show diff", "diff"],
    ["changes", "diff"],
  ])("routes %j → %s", (msg, expected) => {
    expect(matchIntent(msg, emptyState as any).id).toBe(expected);
  });

  it("returns help as the fallback for unmatched input", () => {
    const intent = matchIntent("xyz123", emptyState as any);
    expect(intent.id).toBe("help");
  });

  it("intents array has 8 entries in the documented order", () => {
    expect(intents.map(i => i.id)).toEqual([
      "help", "status", "plan", "files",
      "diff", "verdict", "workdir", "logs",
    ]);
  });
});