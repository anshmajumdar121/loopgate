// Task E (no-API-mode local CLI runner) — proves the `--cli` flag in
// llm-agent.mjs actually shells out to the configured CLI binary and
// preserves the same per-role output-file contract the API path uses,
// WITHOUT hitting the real `claude` binary (which requires an
// authenticated login and would make this test flaky/non-hermetic in CI
// or a fresh sandbox). We point LOOP_CLI_BIN at a fixture shell script
// (fixtures/claude-shim.sh) that ignores its input and echoes a fixed,
// parseable reply — exactly what the real `claude -p <prompt>
// --output-format text` prints to stdout on success.
//
// Mirrors the child_process spawn conventions used elsewhere in this test
// suite (see build-runner.test.ts): a real OS temp directory per test,
// cleaned up in afterEach, no shared/fixed paths.

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Anchor on process.cwd() (the `backend/` package root when vitest runs),
// not on this file's own location via import.meta.url. This test file gets
// compiled to dist/loop/__tests__/llm-agent-cli.test.js by `tsc` and BOTH
// the src/ original and the dist/ compiled copy get picked up by vitest's
// default test glob — but only the .ts source files live next to
// fixtures/claude-shim.sh; tsc doesn't copy non-TS assets into dist. A
// __dirname-relative path would 404 when the dist copy runs. cwd-relative
// paths resolve identically for both, since vitest's cwd is always the
// package root. (Mirrors agent-spawner.ts's LLM_AGENT_SCRIPT resolution,
// which anchors on process.cwd() for the same reason.)
const LLM_AGENT_SCRIPT = resolve(process.cwd(), "llm-agent.mjs");
const CLAUDE_SHIM = resolve(
  process.cwd(),
  "src/loop/__tests__/fixtures/claude-shim.sh"
);
const CLAUDE_SHIM_MAKER = resolve(
  process.cwd(),
  "src/loop/__tests__/fixtures/claude-shim-maker.sh"
);
const CLAUDE_SHIM_FAIL = resolve(
  process.cwd(),
  "src/loop/__tests__/fixtures/claude-shim-fail.sh"
);
const CLAUDE_SHIM_EMPTY = resolve(
  process.cwd(),
  "src/loop/__tests__/fixtures/claude-shim-empty.sh"
);

let workdir: string | null = null;

afterEach(async () => {
  if (workdir) {
    await rm(workdir, { recursive: true, force: true });
    workdir = null;
  }
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn llm-agent.mjs the same way agent-spawner.ts's spawnBridgeRunner
 *  does (node <script> <args>, long strings via env not argv), and wait
 *  for it to exit. */
function runLlmAgent(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [LLM_AGENT_SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("llm-agent.mjs --cli mode", () => {
  it("shells out to LOOP_CLI_BIN and writes the reply verbatim to GOAL.md (planner)", async () => {
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-planner-"));
    const outFile = join(workdir, "GOAL.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "planner",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM,
        LOOP_USER_PROMPT: "test",
      }
    );

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const content = await readFile(outFile, "utf8");
    expect(content).toContain("Implementation Plan");
    expect(content).toContain("Completion Criteria");
  });

  it("does not require an API key when --cli is set", async () => {
    // Sanity check for E1's `!apiKey && !args.cli` requirement change:
    // omitting --api-key entirely (and LOOP_LLM_API_KEY) must NOT trigger
    // the "Missing api key" exit(2) path when --cli is set.
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-nokey-"));
    const outFile = join(workdir, "GOAL.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "planner",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM,
        LOOP_USER_PROMPT: "test",
        LOOP_LLM_API_KEY: "",
      }
    );

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("Missing api key");
  });

  it("appends the CLI reply to STATE.md for the verifier role (single-shot, not streamed)", async () => {
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-verifier-"));
    const outFile = join(workdir, "STATE.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "verifier",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM,
        LOOP_USER_PROMPT: "test",
      }
    );

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const content = await readFile(outFile, "utf8");
    // Scaffold header (written once, since the file doesn't exist yet)
    // plus the shim's reply appended after it.
    expect(content).toContain("# Loop State");
    expect(content).toContain("Implementation Plan");
  });

  it("extracts ```file: blocks and writes them under workdir for the maker role (single-shot, plus STATE.md Diff Summary)", async () => {
    // Maker is the most complex per-role dispatch path (regex extraction,
    // multi-file writing loop, path-safety checks) and, unlike
    // planner/verifier, does NOT write to --output directly: it writes
    // each extracted file under args.workdir at its extracted relative
    // path, then appends a "## Diff Summary" section to
    // <workdir>/STATE.md. --output is still a required CLI flag but is
    // unused by the maker branch itself.
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-maker-"));
    const outFile = join(workdir, "STATE.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "maker",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM_MAKER,
        LOOP_USER_PROMPT: "test",
      }
    );

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const written = await readFile(join(workdir, "index.html"), "utf8");
    expect(written).toBe(
      "<!doctype html><html><body>hi</body></html>"
    );

    const state = await readFile(join(workdir, "STATE.md"), "utf8");
    expect(state).toContain("## Diff Summary");
    expect(state).toContain("index.html");
  });

  it("exits nonzero and reports the CLI's exit status when the local CLI binary runs but exits nonzero", async () => {
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-failexit-"));
    const outFile = join(workdir, "GOAL.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "planner",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM_FAIL,
        LOOP_USER_PROMPT: "test",
      }
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("llm-agent: FAIL: local CLI exit 1:");
  });

  it("exits nonzero cleanly (no hang/crash) when LOOP_CLI_BIN points at a binary that doesn't exist (ENOENT)", async () => {
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-enoent-"));
    const outFile = join(workdir, "GOAL.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "planner",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: "/nonexistent/path/to/nowhere-claude-binary",
        LOOP_USER_PROMPT: "test",
      }
    );

    // Confirmed (via a standalone spawnSync probe) that Node sets r.error
    // (ENOENT) and r.status === null for a missing binary, which the code's
    // `if (r.error)` branch at llm-agent.mjs ~line 281 catches and turns
    // into a clean `process.exit(1)`. We assert on that outcome (nonzero
    // exit, our own "spawn error" prefix) without pinning the exact wording
    // of Node's own ENOENT error message, which isn't this codebase's
    // contract.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("llm-agent: FAIL: local CLI spawn error:");
  });

  it("exits 1 with the empty-content guard message when the CLI exits 0 but produces no stdout", async () => {
    workdir = await mkdtemp(join(tmpdir(), "loop-cli-empty-"));
    const outFile = join(workdir, "GOAL.md");

    const result = await runLlmAgent(
      [
        "--cli",
        "--role",
        "planner",
        "--model",
        "x",
        "--base-url",
        "x",
        "--workdir",
        workdir,
        "--output",
        outFile,
      ],
      {
        LOOP_CLI_BIN: CLAUDE_SHIM_EMPTY,
        LOOP_USER_PROMPT: "test",
      }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("model returned empty content");
  });
});
