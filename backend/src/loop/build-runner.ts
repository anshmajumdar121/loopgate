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
import { createHash } from "node:crypto";
import { runProcess } from "./v2/process-runner.js";
import { isPublicDemo } from "../demo/publicDemo.js";

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

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60_000;
let INSTALL_TIMEOUT_MS = DEFAULT_INSTALL_TIMEOUT_MS;
let SCRIPT_TIMEOUT_MS = DEFAULT_SCRIPT_TIMEOUT_MS;

/** Test hook: shrink stage timeouts (pass null to restore defaults). */
export function __setStageTimeoutsForTests(
  t: { installMs?: number; scriptMs?: number } | null
): void {
  INSTALL_TIMEOUT_MS = t?.installMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  SCRIPT_TIMEOUT_MS = t?.scriptMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
}
const TAIL_LINES = 100;

/** Env vars children are allowed to inherit. Everything else — including
 *  any API keys / connection secrets in the orchestrator's env — is
 *  scrubbed. */
const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"];
/** Extra vars Windows needs for npm/node/cmd.exe to function at all
 *  (SystemRoot for DLL loading, ComSpec for shell:true, PATHEXT for .cmd
 *  shim resolution, APPDATA for npm's global prefix/cache, ...). None of
 *  these carry secrets. */
const WIN32_ENV_ALLOWLIST = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

const IS_WIN32 = process.platform === "win32";

/** package.json hash per workdir, so re-attempts skip redundant installs. */
const lastPkgHash = new Map<string, string>();

/** Test hook: reset the install-skip cache between test cases. */
export function resetBuildRunnerCache(): void {
  lastPkgHash.clear();
}

/** Exported for tests. Windows env keys are case-insensitive (`Path` vs
 *  `PATH`), so match case-insensitively there and keep the source casing. */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allow = platform === "win32" ? [...ENV_ALLOWLIST, ...WIN32_ENV_ALLOWLIST] : ENV_ALLOWLIST;
  if (platform === "win32") {
    const wanted = new Set(allow.map((k) => k.toLowerCase()));
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && wanted.has(key.toLowerCase())) env[key] = value;
    }
  } else {
    for (const key of allow) {
      if (source[key] !== undefined) env[key] = source[key];
    }
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
  // Public demo: never npm install/build/test anything a run produced.
  if (isPublicDemo()) return undefined;
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
  const executable = IS_WIN32 ? "npm.cmd" : "npm";
  return runProcess({
    executable,
    args: npmArgs,
    cwd: workdir,
    env: scrubbedEnv(),
    extendEnv: false,
    timeoutMs,
    stdoutTailBytes: 256 * 1024,
    stderrTailBytes: 256 * 1024,
  }).then((result) => {
    const output = [result.stdoutTail, result.stderrTail]
      .filter((part) => part.length > 0)
      .join("\n")
      .split("\n");
    if (result.timedOut) {
      output.push(`(stage timed out after ${timeoutMs / 1000}s and was killed)`);
    }
    return {
      exit: result.exitCode ?? 1,
      durationMs: result.durationMs,
      tail: output.slice(-TAIL_LINES).join("\n").trim(),
    };
  });
}
