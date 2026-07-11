// Real build + test execution for project-shaped prototypes (Task 3 of
// 2026-07-11-loop-resilience-and-real-build).
//
// Detection: a workdir is "project-shaped" iff it contains package.json.
// Static workdirs (no package.json) return `undefined` from runBuildStep
// and the caller's pipeline behaves byte-identically to before this
// module existed — that is the locked default path.
//
// For project-shaped workdirs, three stages run in order, each with its
// own timeout, capturing exit code + output tail:
//   1. install — `npm install` only when node_modules is missing OR
//      package.json changed since the last run for this workdir (hash).
//   2. build   — the package.json "build" script, if present.
//   3. test    — the package.json "test" script, if present.
//
// SAFETY: children get a scrubbed env (allowlist only — no API keys or
// secrets from the orchestrator's environment), cwd pinned to the task
// workdir, and only install/build/test ever run — never "start"/"dev"
// (serving stays the preview server's job).

import { readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface BuildRunResult {
  installMs?: number;
  buildMs?: number;
  testMs?: number;
  buildExit?: number;
  testExit?: number;
  /** Which stage failed, when one did. Absent on full success. */
  failedStage?: "install" | "build" | "test";
  /** Last ~100 lines of the failed (or last) stage's combined output. */
  outputTail?: string;
  /** Absolute path of the built output dir (dist/build/out with an
   *  index.html), when the build produced one. The caller serves this
   *  instead of the raw workdir — project-shaped tasks only. */
  outputDir?: string;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const TAIL_LINES = 100;

/** Env vars children are allowed to inherit. Everything else — including
 *  any API keys / connection secrets in the orchestrator's env — is
 *  scrubbed. */
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"];

/** package.json hash per workdir, so re-attempts skip redundant installs. */
const lastPkgHash = new Map<string, string>();

/** Test hook: reset the install-skip cache between test cases. */
export function resetBuildRunnerCache(): void {
  lastPkgHash.clear();
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Run install/build/test for a project-shaped workdir. Returns undefined
 * for static workdirs (no package.json) — the caller must treat that as
 * "this step never happened".
 */
export async function runBuildStep(
  workdir: string,
  log?: (line: string) => void
): Promise<BuildRunResult | undefined> {
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(join(workdir, "package.json"), "utf8");
  } catch {
    return undefined; // static workdir — locked default path
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    // A package.json the maker wrote but that isn't valid JSON is a
    // build failure in itself — surface it as the install stage failing
    // so the maker gets the feedback.
    return {
      failedStage: "install",
      outputTail: "package.json is not valid JSON — npm cannot run",
    };
  }

  const result: BuildRunResult = {};
  const pkgHash = createHash("sha256").update(pkgRaw).digest("hex");

  // Stage 1: install (conditional).
  const nodeModulesExists = await access(join(workdir, "node_modules"))
    .then(() => true)
    .catch(() => false);
  const hashChanged = lastPkgHash.get(workdir) !== undefined && lastPkgHash.get(workdir) !== pkgHash;
  if (!nodeModulesExists || hashChanged) {
    log?.("build-runner: npm install (node_modules missing or package.json changed)");
    const install = await runStage(
      workdir,
      ["install", "--no-audit", "--no-fund"],
      INSTALL_TIMEOUT_MS
    );
    result.installMs = install.durationMs;
    if (install.exit !== 0) {
      result.failedStage = "install";
      result.outputTail = install.tail;
      return result;
    }
  } else {
    log?.("build-runner: install skipped (node_modules present, package.json unchanged)");
  }
  lastPkgHash.set(workdir, pkgHash);

  // Stage 2: build.
  if (pkg.scripts?.build) {
    log?.("build-runner: npm run build");
    const build = await runStage(workdir, ["run", "build"], SCRIPT_TIMEOUT_MS);
    result.buildMs = build.durationMs;
    result.buildExit = build.exit;
    if (build.exit !== 0) {
      result.failedStage = "build";
      result.outputTail = build.tail;
      return result;
    }
  }

  // Stage 3: test.
  if (pkg.scripts?.test) {
    log?.("build-runner: npm run test");
    const test = await runStage(workdir, ["run", "test"], SCRIPT_TIMEOUT_MS);
    result.testMs = test.durationMs;
    result.testExit = test.exit;
    if (test.exit !== 0) {
      result.failedStage = "test";
      result.outputTail = test.tail;
      return result;
    }
  }

  // Success — locate built output worth serving (index.html inside a
  // conventional output dir). Only meaningful when a build script ran.
  if (pkg.scripts?.build && result.buildExit === 0) {
    for (const dir of ["dist", "build", "out"]) {
      const candidate = join(workdir, dir);
      const hasIndex = await stat(join(candidate, "index.html"))
        .then((s) => s.isFile())
        .catch(() => false);
      if (hasIndex) {
        result.outputDir = candidate;
        break;
      }
    }
  }

  return result;
}

interface StageResult {
  exit: number;
  durationMs: number;
  tail: string;
}

function runStage(
  workdir: string,
  npmArgs: string[],
  timeoutMs: number
): Promise<StageResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const proc = spawn("npm", npmArgs, {
      cwd: workdir,
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const capture = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        lines.push(line);
        if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES);
      }
    };
    proc.stdout.on("data", capture);
    proc.stderr.on("data", capture);
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      lines.push(`(stage timed out after ${timeoutMs / 1000}s and was killed)`);
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit: 127,
        durationMs: Date.now() - start,
        tail: `failed to spawn npm: ${err.message}`,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit: code ?? 1,
        durationMs: Date.now() - start,
        tail: lines.slice(-TAIL_LINES).join("\n").trim(),
      });
    });
  });
}
