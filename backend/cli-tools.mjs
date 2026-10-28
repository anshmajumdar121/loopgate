// Per-tool invocation contract for llm-agent.mjs `--cli` mode (no API key:
// the run goes through a CLI the user is already logged in to).
//
//   claude — `claude -p <prompt> --output-format text` (original behaviour).
//   gemini — Gemini CLI, "Login with Google". Prompt goes in on stdin, which
//            also dodges the Windows ~32K command-line limit.
//   kimi   — Kimi Code CLI (`kimi login`). `kimi -p` only takes the prompt as
//            an argument and runs tools WITHOUT asking in that mode, so the
//            prompt is written to a temp TASK.md and kimi is started with an
//            agent file whose only tool is `Read`: it can read the task (and
//            the project) but cannot write files or run commands, so writes
//            still go through Loopgate's own policy gate.
//
// buildCliInvocation is pure so it can be unit-tested without the real CLIs.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_TOOLS = ["claude", "gemini", "kimi"];

// Model ids are user-typed and end up on a command line (through cmd.exe on
// Windows), so only plain id characters are let through.
const SAFE_MODEL = /^[A-Za-z0-9._:/-]+$/;

const GEMINI_PROMPT_SUFFIX = "Follow the instructions above. Reply with only the final answer.";
const KIMI_PROMPT =
  "Read TASK.md in the current directory and follow it. Reply with only the final answer.";
const KIMI_AGENT_FILE = "loopgate-text.md";

export const KIMI_AGENT_MD = `---
name: loopgate-text
description: Text-only worker for Loopgate. Reads its task file and replies in text.
tools: [Read]
subagents: []
---
You are a worker inside Loopgate. Your task is in TASK.md in the current directory.
Read it with the Read tool, then reply with ONLY the final answer text it asks for.
Do not ask questions. You cannot write files or run commands.
`;

export function normaliseCliModel(model) {
  const m = (model ?? "").trim();
  if (!m || m === "default" || !SAFE_MODEL.test(m)) return null;
  return m;
}

/**
 * Describe how to run one prompt through `tool`.
 * @returns {{ bin: string, args: string[], input?: string, cwd: string,
 *             files?: Record<string, string> }}
 *   `files` (kimi only) must be written into `cwd` before spawning.
 */
export function buildCliInvocation({ tool, bin, model, prompt, workdir, taskDir }) {
  const m = normaliseCliModel(model);
  switch (tool ?? "claude") {
    case "claude":
      return {
        bin: bin || "claude",
        args: ["-p", prompt, "--output-format", "text"],
        cwd: workdir,
      };
    case "gemini":
      return {
        bin: bin || "gemini",
        args: ["-p", GEMINI_PROMPT_SUFFIX, "-o", "text", ...(m ? ["-m", m] : [])],
        input: prompt,
        cwd: workdir,
      };
    case "kimi":
      return {
        bin: bin || "kimi",
        args: [
          "-p",
          KIMI_PROMPT,
          // Text mode prefixes replies with "• " bullets; stream-json gives
          // the raw assistant content (see parseCliOutput).
          "--output-format",
          "stream-json",
          "--agent-file",
          KIMI_AGENT_FILE,
          ...(m ? ["-m", m] : []),
        ],
        cwd: taskDir,
        files: {
          "TASK.md": `Project directory (read-only for you): ${workdir}\n\n---\n\n${prompt}`,
          [KIMI_AGENT_FILE]: KIMI_AGENT_MD,
        },
      };
    default:
      throw new Error(`unknown CLI tool "${tool}" (expected one of ${CLI_TOOLS.join(", ")})`);
  }
}

/** Quote one argument for cmd.exe. Only ever sees our fixed strings, safe
 *  model ids and the bin path, none of which contain quotes. */
export function quoteWinArg(a) {
  return /^[A-Za-z0-9._:/\\-]+$/.test(a) ? a : `"${a}"`;
}

/** The reply text from a CLI's stdout. kimi's stream-json is one JSON
 *  message per line; the answer is the last assistant message with text
 *  (earlier ones are tool calls such as reading TASK.md). */
export function parseCliOutput(tool, stdout) {
  const raw = stdout ?? "";
  if (tool !== "kimi") return raw.trim();
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      last = msg.content;
    }
  }
  return (last ?? "").trim();
}

/** Run the prompt through the CLI; returns spawnSync's result. */
export function runCliTool({ tool, bin, model, prompt, workdir, timeoutMs = 25 * 60_000 }) {
  const needsTaskDir = tool === "kimi";
  const taskDir = needsTaskDir ? mkdtempSync(join(tmpdir(), "loopgate-kimi-")) : undefined;
  try {
    const inv = buildCliInvocation({ tool, bin, model, prompt, workdir, taskDir });
    for (const [name, body] of Object.entries(inv.files ?? {})) {
      writeFileSync(join(inv.cwd, name), body, "utf8");
    }
    // npm installs gemini/kimi as .cmd shims on Windows, which Node can only
    // start through a shell. The claude path keeps its original direct spawn
    // (its prompt is in argv and must not pass through cmd.exe).
    // Through the shell the line is pre-quoted and passed as one string
    // (Node warns, DEP0190, when an args array is combined with shell).
    const viaShell = process.platform === "win32" && tool !== "claude" && tool != null;
    const opts = {
      cwd: inv.cwd,
      input: inv.input,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    };
    return viaShell
      ? spawnSync([inv.bin, ...inv.args].map(quoteWinArg).join(" "), { ...opts, shell: true })
      : spawnSync(inv.bin, inv.args, opts);
  } finally {
    if (taskDir) rmSync(taskDir, { recursive: true, force: true });
  }
}
