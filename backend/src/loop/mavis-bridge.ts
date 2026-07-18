// Bridge that runs an agent role through the user's local MiniMax Code /
// Mavis daemon (the `minimax` CLI) instead of an HTTP API connection. Lets
// the loop run against a MiniMax Pro subscription instead of a pay-per-token
// API key. See docs/superpowers/specs/2026-07-18-mavis-cli-bridge-design.md.
//
// Contract: same as the rest of agent-spawner.ts — write the LLM's final
// reply to `outFile`, emit a `__LOOP_USAGE__:{json}__END__` line on stderr,
// and only update `lastActivityAt` when the Mavis session genuinely
// produces new output. That last part matters: the orchestrator's stall
// watchdog polls `lastActivityAt` generically (see `raceStall` in
// orchestrator.ts) — because this module only bumps it on real progress,
// the existing stall/retry/escalate logic works unmodified. No bespoke
// stall handling lives here.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AgentHandle, AgentName, LineCallback, ExitCallback } from "./agent-spawner.js";

// Read fresh on every call, not cached at module load — tests override
// these via env vars in `beforeEach`, which runs after this module is
// first imported. Caching them in a module-level const meant a stale
// default (the real Mavis binary) was used for the whole test run instead
// of the fixture shim. Function-scoped reads keep each call honest.
function mavisBin(): string {
  return process.env.LOOP_MAVIS_BIN ?? `${process.env.HOME}/.mavis/bin/minimax`;
}

function pollIntervalMs(): number {
  return Number(process.env.LOOP_MAVIS_POLL_INTERVAL_MS || 3000);
}

/**
 * The real `minimax` CLI prints a human-readable line before the JSON
 * payload on some commands (e.g. `session new` → "Root session created:
 * mvs_... [model=...]", with ANSI color codes), unlike our test fixture
 * which only ever emitted bare JSON. Extract from the first `{` onward so
 * both shapes parse correctly — found live against the real daemon during
 * the manual smoke test (Task 8), after the fixture-only tests passed.
 */
function extractJson(stdout: string): string {
  const idx = stdout.indexOf("{");
  return idx === -1 ? stdout : stdout.slice(idx);
}

interface MavisMessage {
  role?: string;
  msg_content?: string;
  finish_reason?: string;
  usage?: { total_tokens?: number };
}

interface MavisRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runMavis(args: string[]): MavisRunResult {
  const result = spawnSync(mavisBin(), args, { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/**
 * Ensure the role's persistent Mavis agent exists. Idempotent by
 * construction: we don't check `agent new`'s exit code, so a concurrent
 * "already exists" race from another role's startup is a no-op, not a
 * failure (see design spec §4, "Agent creation race").
 */
function ensureAgent(agentName: string, systemPrompt: string): void {
  const list = runMavis(["agent", "list"]);
  if (list.status === 0 && list.stdout.includes(agentName)) return;
  runMavis([
    "agent",
    "new",
    agentName,
    "--engine",
    "opencode",
    "--system-prompt",
    systemPrompt,
    "--display-name",
    agentName,
  ]);
}

function makeImmediateFailureHandle(
  exited: Promise<number | null>,
  activityTarget: { lastActivityAt: number },
  finish: (code: number | null) => void
): AgentHandle {
  queueMicrotask(() => finish(1));
  return {
    pid: -1,
    isMock: false,
    exited,
    get lastActivityAt() {
      return activityTarget.lastActivityAt;
    },
    kill() {
      /* already finishing */
    },
  };
}

export function spawnMavisBridge(
  agent: AgentName,
  _taskId: string,
  _workdir: string,
  runPrompt: string,
  outFile: string,
  systemPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback
): AgentHandle {
  const agentName = `loop-${agent}`;
  const activityTarget = { lastActivityAt: Date.now() };
  let killed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSeenMessageCount = 0;
  let lastPartialContent = "";

  let resolveExited: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExited = resolve;
  });

  const finish = (code: number | null) => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      onExit(code);
    } catch {
      /* caller bug — don't propagate */
    }
    resolveExited(code);
  };

  onStdout(`[mavis-bridge] starting session for ${agentName}`);
  ensureAgent(agentName, systemPrompt);

  const created = runMavis([
    "session",
    "new",
    agentName,
    "--from",
    "root",
    "--prompt",
    runPrompt,
    "--model",
    "minimax/MiniMax-M2.7",
  ]);
  if (created.status !== 0) {
    onStderr(
      `[mavis-bridge] session new failed (exit ${created.status}): ${created.stderr.trim()}`
    );
    return makeImmediateFailureHandle(exited, activityTarget, finish);
  }

  let sessionId: string;
  try {
    const parsed = JSON.parse(extractJson(created.stdout)) as { sessionId?: string };
    if (!parsed.sessionId) throw new Error("no sessionId in response");
    sessionId = parsed.sessionId;
  } catch (err) {
    onStderr(
      `[mavis-bridge] could not parse session id: ${
        err instanceof Error ? err.message : String(err)
      } — raw: ${created.stdout}`
    );
    return makeImmediateFailureHandle(exited, activityTarget, finish);
  }

  onStdout(`[mavis-bridge] session ${sessionId} started`);

  const poll = () => {
    if (killed) return;
    const result = runMavis(["session", "messages", sessionId]);
    if (result.status !== 0) {
      onStderr(`[mavis-bridge] poll failed (exit ${result.status}): ${result.stderr.trim()}`);
      return; // transient — try again next tick; the orchestrator's stall
              // watchdog decides if this has gone on too long.
    }
    let messages: MavisMessage[];
    try {
      messages = (JSON.parse(extractJson(result.stdout)) as { messages?: MavisMessage[] }).messages ?? [];
    } catch {
      return; // malformed JSON on this poll — try again next tick.
    }

    if (messages.length > lastSeenMessageCount) {
      lastSeenMessageCount = messages.length;
      activityTarget.lastActivityAt = Date.now();
    }

    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (last?.msg_content) lastPartialContent = last.msg_content;
    if (!last || !last.finish_reason) return; // still working — poll again

    if (timer) clearInterval(timer);
    timer = null;
    try {
      writeFileSync(outFile, last.msg_content ?? "", "utf8");
      onStdout(`[mavis-bridge] wrote ${(last.msg_content ?? "").length} chars to ${outFile}`);
    } catch (err) {
      onStderr(
        `[mavis-bridge] failed to write ${outFile}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      finish(1);
      return;
    }
    const totalTokens = last.usage?.total_tokens ?? 0;
    if (totalTokens > 0) {
      // Mavis reports only a combined total, not a prompt/completion split.
      // Recording the whole amount as completionTokens keeps the total
      // accurate in the token-usage panel; splitting it would be a guess
      // either way.
      onStderr(
        `__LOOP_USAGE__:${JSON.stringify({
          modelId: "mavis-cli",
          upstreamModel: "minimax/MiniMax-M2.7",
          connectionId: null,
          connectionName: agentName,
          baseUrl: null,
          promptTokens: 0,
          completionTokens: totalTokens,
        })}__END__`
      );
    }
    finish(0);
  };

  timer = setInterval(poll, pollIntervalMs());
  poll(); // fire once immediately rather than waiting a full interval

  return {
    pid: -1,
    isMock: false,
    exited,
    get lastActivityAt() {
      return activityTarget.lastActivityAt;
    },
    getAccumulatedOutput() {
      return lastPartialContent;
    },
    kill() {
      killed = true;
      if (timer) clearInterval(timer);
      timer = null;
      finish(null);
    },
  };
}
