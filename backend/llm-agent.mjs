#!/usr/bin/env node
// Loop-rt / Loop-Agent compatible agent runner.
// Args (most are also overridable via env; env wins for long strings to
// dodge the macOS ~256KB argv limit):
//   --model <id>           e.g. "z-ai/glm-5.2"
//   --base-url <url>
//   --api-key <key>       (alt: --api-key-env <ENV var name>)
//   --workdir <path>      project workdir; used to load <workdir>/.opencode/agents/loop-<role>.md
//   --role <name>         "planner" | "maker" | "verifier"
//   --output <path>       where to write the assistant's reply
//   --max-tokens <n>      default 4096 (maker gets 8192)
//   --temperature <n>     default 0.7
//
// Env overrides (set by the orchestrator's spawner):
//   LOOP_SYSTEM_PROMPT — full system prompt (overrides file-loaded .md)
//   LOOP_USER_PROMPT   — full user prompt (replaces --prompt)
//   LOOP_ROLE          — planner|maker|verifier
//   LOOP_TASK_ID       — task id (cosmetic logging)
//
// Exit 0 on success, 1 on error. Errors go to stderr.

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { readFile, writeFile, appendFile, rename } from "node:fs/promises";

// Write via temp file + rename so the destination is never observable in a
// truncated/partial state. The orchestrator's chokidar watcher reads the
// output file the moment a change event fires; a plain writeFile (truncate,
// then write) opens a window where the watcher can read 0 bytes and cache
// that as the phase output ("Planner returned 0 steps, 0 files").
async function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--model":
        out.model = argv[++i];
        break;
      case "--base-url":
        out.baseUrl = argv[++i];
        break;
      case "--api-key":
        out.apiKey = argv[++i];
        break;
      case "--api-key-env":
        out.apiKey = argv[++i];
        break;
      case "--workdir":
        out.workdir = argv[++i];
        break;
      case "--role":
        out.role = argv[++i];
        break;
      case "--output":
        out.output = argv[++i];
        break;
      case "--max-tokens":
        out.maxTokens = Number(argv[++i]);
        break;
      case "--temperature":
        out.temperature = Number(argv[++i]);
        break;
      case "--prompt":
        out.prompt = argv[++i];
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error("Unknown flag:", a);
          process.exit(2);
        }
        if (!out.prompt) out.prompt = a;
    }
  }
  // Env overrides (long string fallback — argv has ~256KB limit on macOS).
  if (!out.prompt && process.env.LOOP_USER_PROMPT) {
    out.prompt = process.env.LOOP_USER_PROMPT;
  }
  if (process.env.LOOP_ROLE) out.role = process.env.LOOP_ROLE;
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "Usage: llm-agent.mjs --model <id> --base-url <url> --workdir <path> --role <p|m|v> --output <path> [--api-key <k>|--api-key-env <env>] [--temperature 0.7] [--max-tokens 4096] [--prompt <userMsg>]"
  );
  process.exit(0);
}

const required = ["model", "baseUrl", "output", "role", "workdir"];
for (const k of required) {
  if (!args[k]) {
    console.error(`Missing required --${k}`);
    process.exit(2);
  }
}
const apiKey = args.apiKey || process.env.LOOP_LLM_API_KEY;
if (!apiKey) {
  console.error("Missing api key");
  process.exit(2);
}

// Resolve system prompt.
// Priority: LOOP_SYSTEM_PROMPT env → <workdir>/.opencode/agents/loop-<role>.md
//   → empty
async function resolveSystemPrompt(args) {
  if (process.env.LOOP_SYSTEM_PROMPT) {
    return process.env.LOOP_SYSTEM_PROMPT;
  }
  if (args.workdir && args.role) {
    try {
      const path = `${args.workdir}/.opencode/agents/loop-${args.role}.md`;
      return await readFile(path, "utf8");
    } catch {
      /* fall through */
    }
  }
  return "";
}

// Maker role needs an override — the original .md assumes shell/edit/write
// tools. We don't have those. Tell the LLM to produce the file as a single
// ```html code block and the bridge will extract it.
const MAKER_NO_TOOLS_OVERRIDE = `

---

## ⚠️ Tool mode override

You are running inside the Loop Agent bridge runner. You DO NOT have access
to read_file / write_file / bash / edit_file tools in this environment.

To deliver your output, emit one fenced code block PER FILE, each opened
with the file's relative path:

\`\`\`file:index.html
<!doctype html>...
\`\`\`

\`\`\`file:js/board.js
export function ...
\`\`\`

Rules:
1. Paths are relative to the project root. No absolute paths, no "..".
2. index.html MUST be one of the files (it is the entry point the preview
   server loads).
3. Every file must be COMPLETE — no elisions, no "rest unchanged".
4. No commentary outside the blocks.
5. Prefer a single self-contained index.html when the prototype fits in
   one file; split only when it genuinely helps (workers, large modules).

Backwards-compatible fallback: a single \`\`\`html block (no file: prefix)
is treated as index.html.

The bridge saves every file, then appends a ## Diff Summary section to
STATE.md so the orchestrator advances.
`;

// Planner role needs a similar tool-strip override. Without it, the LLM has
// no way to ls/cat the codebase and just echoes the orchestrator's "Read
// GOAL.md, explore the codebase..." instruction back as its reply — leaving
// GOAL.md with no parseable plan. Tell it to plan from the task description
// alone and surface assumptions in Notes.
const PLANNER_NO_TOOLS_OVERRIDE = `

---

## ⚠️ Tool mode override

You are running inside the Loop Agent bridge runner. You DO NOT have access
to read_file / ls / cat / bash tools in this environment. You CANNOT explore
the codebase.

To deliver your output:
1. Plan based ONLY on the task description in your user prompt and the
   GOAL.md template headings your system prompt specifies.
2. Write the FULL \`GOAL.md\` content (template headings + filled sections)
   as your reply. The bridge extracts your reply verbatim and writes it to
   \`GOAL.md\` on disk.
3. If the task references files you cannot inspect (because you have no
   tools), list each unknown as an explicit assumption in
   \`## Notes for the maker\` so the orchestrator/user can decide.
4. Do NOT echo the user's instructions back as your output ("I'll start by
   reading GOAL.md..." is NOT a plan). Return a structured plan or return
   \`ESCALATE: <reason>\` at the top of your reply.

The bridge will write your reply to GOAL.md. If the orchestrator's parser
cannot extract steps/files/criteria from the result, it will retry — so a
partial plan is better than no plan.
`;

// Verifier needs a similar tool-strip override.
const VERIFIER_NO_TOOLS_OVERRIDE = `

---

## ⚠️ Tool mode override

You are running inside the Loop Agent bridge runner. You DO NOT have
read_file / bash / build tools in this environment. The orchestrator has
loaded the full task context (GOAL.md, loop-constraints.md, the diff
files' contents, and the maker's diff summary) into your user prompt —
read it carefully. Walk the completion criteria, check scope + intent +
no-cheating against the loaded context, then write your verdict.

Output ONLY a single \`## Verifier Verdict — Attempt N\` markdown section,
no other prose. The bridge will append it directly to STATE.md.
`;

let userPrompt = args.prompt || "";
let systemPrompt = await resolveSystemPrompt(args);

if (args.role === "planner" && !userPrompt.includes("Tool mode override")) {
  systemPrompt = (systemPrompt || "") + PLANNER_NO_TOOLS_OVERRIDE;
}
if (args.role === "maker" && !userPrompt.includes("Tool mode override")) {
  systemPrompt = (systemPrompt || "") + MAKER_NO_TOOLS_OVERRIDE;
}
if (args.role === "verifier" && !userPrompt.includes("Tool mode override")) {
  systemPrompt = (systemPrompt || "") + VERIFIER_NO_TOOLS_OVERRIDE;
}

if (!userPrompt) {
  console.error("Missing user prompt (set LOOP_USER_PROMPT or pass --prompt)");
  process.exit(2);
}

const openai = createOpenAI({ baseURL: args.baseUrl, apiKey });

const messages = [];
if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
messages.push({ role: "user", content: userPrompt });

try {
  const t0 = Date.now();
  const result = await generateText({
    model: openai(args.model),
    messages,
    temperature: args.temperature ?? 0.7,
    maxTokens:
      args.maxTokens ?? (args.role === "maker" ? 8192 : 4096),
  });
  const { usage, finishReason } = result;
  const reasoning =
    typeof result.reasoning === "string" ? result.reasoning : "";
  let text = result.text ?? "";
  process.stderr.write(
    `[${args.role}] LLM OK in ${Date.now() - t0}ms, ${text.length} chars ` +
      `(finish=${finishReason ?? "?"}, reasoning=${reasoning.length} chars)\n`
  );

  // Thinking models (GLM et al.) can return an EMPTY content field: either
  // the token budget was exhausted mid-reasoning (finish=length) or the
  // whole answer landed in reasoning_content, which the SDK surfaces as
  // `reasoning`, not `text`. Writing "" downstream produces an unparseable
  // output file (observed: verifier appended 1 char → "no Verdict section"
  // escalation). Salvage the expected section from reasoning if it's there;
  // otherwise fail loudly so the orchestrator reports a real cause instead
  // of a silent empty write.
  if (!text.trim() && reasoning) {
    const salvage = reasoning.match(/##\s*Verifier Verdict[\s\S]*/);
    if (args.role === "verifier" && salvage) {
      text = salvage[0];
      process.stderr.write(
        `[verifier] content empty — salvaged ${text.length} chars of verdict from reasoning\n`
      );
    }
  }
  if (!text.trim()) {
    process.stderr.write(
      `llm-agent: FAIL: model returned empty content (finish=${finishReason ?? "?"}, ` +
        `reasoning=${reasoning.length} chars, maxTokens=${args.maxTokens ?? "default"}) — ` +
        `likely reasoning consumed the whole token budget; not writing ${args.output}\n`
    );
    // Still dump the raw reasoning — it's the only signal left when the
    // assistant text is empty. Failure to dump is non-fatal.
    try {
      const { mkdir: mkdirA } = await import("node:fs/promises");
      const loopDir = `${args.workdir}/.loop`;
      await mkdirA(loopDir, { recursive: true });
      const attemptN = process.env.LOOP_ATTEMPT ?? "1";
      await writeFile(
        `${loopDir}/${args.role}-attempt-${attemptN}-raw.md`,
        [
          `<!-- role=${args.role} attempt=${attemptN} model=${args.model} EMPTY -->`,
          `<!-- finish=${finishReason ?? "?"} textChars=${text.length} reasoningChars=${reasoning.length} -->`,
          "",
          "## reasoning (text was empty):",
          "",
          reasoning,
        ].join("\n"),
        "utf8"
      );
    } catch { /* artifact write is best-effort */ }
    process.exit(1);
  }
  // Artifact dump: raw response + metadata per attempt. First place to look
  // when a phase produces an unparseable file — you see exactly what the
  // model said before any extraction logic touched it.
  try {
    const { mkdir: mkdirA } = await import("node:fs/promises");
    const loopDir = `${args.workdir}/.loop`;
    await mkdirA(loopDir, { recursive: true });
    const attemptN = process.env.LOOP_ATTEMPT ?? "1";
    await writeFile(
      `${loopDir}/${args.role}-attempt-${attemptN}-raw.md`,
      [
        `<!-- role=${args.role} attempt=${attemptN} model=${args.model} -->`,
        `<!-- finish=${finishReason ?? "?"} textChars=${text.length} reasoningChars=${reasoning.length} -->`,
        "",
        text,
      ].join("\n"),
      "utf8"
    );
  } catch { /* artifact write is best-effort */ }
  // Emit a structured usage line for the spawner to parse + aggregate.
  // The line starts with the magic prefix `__LOOP_USAGE__:` and ends with
  // `__END__` so a parser can locate it in the stream even when the
  // model also writes stderr noise. The payload is a JSON object with
  // the bare minimum the spawner needs to credit the call to the right
  // model + connection.
  if (usage) {
    const usagePayload = {
      modelId: process.env.LOOP_MODEL_ID ?? args.model,
      upstreamModel: args.model,
      connectionId: process.env.LOOP_CONNECTION_ID ?? null,
      connectionName: process.env.LOOP_CONNECTION_NAME ?? null,
      baseUrl: args.baseUrl,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
    };
    process.stderr.write(
      `__LOOP_USAGE__:${JSON.stringify(usagePayload)}__END__\n`
    );
  }

  // Per-role output file dispatch.
  if (args.role === "maker") {
    // Multi-file extraction: ```file:relative/path ... ``` blocks.
    // Fallback: one ```html block → index.html (legacy single-file mode).
    const { dirname, resolve: rp, sep } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const workroot = rp(args.workdir);
    const files = [];
    const re = /```file:([^\n`]+)\n([\s\S]*?)\n```/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      files.push({ path: match[1].trim(), content: match[2] });
    }
    if (files.length === 0) {
      const m = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
      files.push({ path: "index.html", content: m ? m[1] : text });
    }
    const written = [];
    for (const f of files) {
      const abs = rp(workroot, f.path);
      if (!abs.startsWith(workroot + sep) || f.path.startsWith("/") || f.path.includes("..")) {
        process.stderr.write(`[maker] SKIPPED unsafe path: ${f.path}\n`);
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, f.content);
      written.push(f.path);
      process.stderr.write(`[maker] wrote ${f.content.length} chars to ${abs}\n`);
    }
    if (written.length === 0) {
      process.stderr.write("llm-agent: FAIL: maker produced no writable files\n");
      process.exit(1);
    }
    // Append a Diff Summary to STATE.md so the orchestrator's watcher
    // sees the phase advance.
    const statePath = rp(workroot, "STATE.md");
    const attempt = process.env.LOOP_ATTEMPT ?? "1";
    const summary = [
      "",
      `## Diff Summary — Attempt ${attempt}`,
      "",
      `**Files changed** (${written.length}):`,
      ...written.map((p) => `- ${p} — implemented per plan`),
      "",
      "**Build:** n/a — static files, no build step",
      "**Tests:** automated runtime check runs after this phase",
      "**Lint:** n/a",
      "",
      `**New files**: ${written.join(", ")}`,
      "",
      "**Notes for verifier:**",
      "- Static HTML/CSS/JS prototype; entry point index.html",
      "- Implements the acceptance criteria listed in GOAL.md",
    ].join("\n");
    await appendFile(statePath, summary, "utf8");
    process.stderr.write(`[maker] appended diff summary to ${statePath}\n`);
  } else if (args.role === "verifier") {
    // Verifier APPENDS to STATE.md (does not overwrite) so the maker's
    // `## Diff Summary` section stays intact. The orchestrator parses the
    // latest `## Verifier Verdict — Attempt N` section from STATE.md, and
    // the human reader wants both the diff and the verdict on the same
    // page for traceability.
    //
    // If STATE.md doesn't exist yet, scaffold a minimal header so the
    // append lands under a recognisable preamble instead of a raw heading.
    const statePath = args.output;
    const attempt = process.env.LOOP_ATTEMPT ?? "1";
    const reply = text ?? "";
    let payload = reply;
    try {
      const { stat } = await import("node:fs/promises");
      await stat(statePath);
    } catch {
      // File does not exist — write a minimal scaffold first so the append
      // doesn't strand a heading at the top of an empty file.
      const scaffold =
        `# Loop State\n\n## Attempt: ${attempt} / ${process.env.LOOP_MAX_ATTEMPTS ?? "3"}\n\n`;
      await writeFile(statePath, scaffold, "utf8");
    }
    // Ensure the verdict starts on its own line (the LLM sometimes returns
    // a leading blank or no newline; we want clean heading boundaries).
    if (!payload.startsWith("\n")) payload = "\n" + payload;
    await appendFile(statePath, payload, "utf8");
    process.stderr.write(
      `[verifier] appended ${payload.length} chars to ${statePath}\n`
    );
  } else {
    // planner — write the LLM's reply verbatim to GOAL.md (replaces the
    // template). Verifier handled above; maker handled above.
    await writeFileAtomic(args.output, text ?? "");
    process.stderr.write(
      `[${args.role}] wrote ${text?.length ?? 0} chars to ${args.output}\n`
    );
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `llm-agent: FAIL: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
}
