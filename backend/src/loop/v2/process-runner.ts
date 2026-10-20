import { execa } from "execa";

/** A callback supplied by the caller to enforce worktree/cwd containment. */
export type CwdContainmentHook =
  | ((cwd: string) => void | Promise<void>)
  | undefined;

export interface ProcessRunOptions {
  /** Executable name or absolute path. It is passed to Execa unchanged. */
  executable: string;
  /** Structured arguments. Shell command strings are intentionally unsupported. */
  args?: readonly string[];
  /** Required working directory for the child process. */
  cwd: string;
  /** Optional environment overlay. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to Execa's normal environment extension behavior. */
  extendEnv?: boolean;
  /** Called before spawning; throw to reject a cwd outside the allowed root. */
  validateCwd?: CwdContainmentHook;
  /** Alias for validateCwd. */
  cwdValidator?: CwdContainmentHook;
  /** Alias for callers that name the policy a guard. */
  cwdGuard?: CwdContainmentHook;
  /** Alias for callers that name the policy a containment callback. */
  cwdContainment?: CwdContainmentHook;
  /** Cancellation propagated to Execa's cancelSignal option. */
  signal?: AbortSignal;
  /** Execa terminology alias for signal. */
  cancelSignal?: AbortSignal;
  /** Wall-clock timeout in milliseconds. Omit or use 0 for no timeout. */
  timeoutMs?: number;
  /** Execa terminology alias for timeoutMs. */
  timeout?: number;
  /** Maximum UTF-8 byte count retained from stdout. */
  stdoutTailBytes?: number;
  /** Maximum UTF-8 byte count retained from stderr. */
  stderrTailBytes?: number;
  /** Aliases for integrations that use max* terminology. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Delay before a second, forceful process-tree kill. `false` disables it. */
  forceKillAfterDelayMs?: number | false;
}

export interface ProcessRunResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | undefined;
  signal: string | undefined;
  /** Bounded tail of stdout. */
  stdout: string;
  /** Bounded tail of stderr. */
  stderr: string;
  /** Explicit aliases that make the bounded nature clear to callers. */
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  failed: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Execa-compatible spelling for callers that need it. */
  isCanceled: boolean;
  isForcefullyTerminated?: boolean;
  errorMessage?: string;
  errorCode?: string;
}

export const DEFAULT_STDOUT_TAIL_BYTES = 64 * 1024;
export const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;
export const DEFAULT_FORCE_KILL_AFTER_DELAY_MS = 1_000;

class ByteTail {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  append(chunk: string | Buffer | Uint8Array): void {
    if (this.limit === 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return;

    const kept = bytes.length > this.limit ? bytes.subarray(-this.limit) : bytes;
    this.chunks.push(Buffer.from(kept));
    this.size += kept.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

function validateNonNegativeFiniteInteger(
  value: number | false | undefined,
  name: string
): void {
  if (
    value !== undefined &&
    value !== false &&
    (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
  ) {
    throw new TypeError(`${name} must be a non-negative finite integer`);
  }
}

function normalizeTailBytes(value: number | undefined, name: string, fallback: number): number {
  const normalized = value ?? fallback;
  validateNonNegativeFiniteInteger(normalized, name);
  return normalized;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Execa owns the direct-child cancellation. A detached POSIX child gets
    // its own process group, so the negative pid reaches grandchildren too.
    process.kill(-pid, signal);
  } catch {
    // The process may have exited between the timeout/cancel and this call.
  }
}

function killWindowsProcessTree(pid: number): void {
  // taskkill is available on supported Windows versions and is invoked with
  // an argument array, never through a shell or a user-provided command.
  void execa(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    {
      reject: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }
  );
}

function terminateProcessTree(pid: number, forceKillAfterDelay: number | false): ReturnType<typeof setTimeout> | undefined {
  if (process.platform === "win32") {
    killWindowsProcessTree(pid);
    return undefined;
  }

  killProcessGroup(pid, "SIGTERM");
  if (forceKillAfterDelay === false) return undefined;

  const timer = setTimeout(() => killProcessGroup(pid, "SIGKILL"), forceKillAfterDelay);
  timer.unref?.();
  return timer;
}

/**
 * Run one structured child process.
 *
 * This module deliberately calls `execa(file, args, options)` rather than a
 * shell-command helper. Timeout and cancellation are handed to Execa using
 * `timeout` and `cancelSignal`; the small process-tree hook supplements that
 * behavior for detached POSIX groups and Windows taskkill.
 */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (options.executable.trim().length === 0) {
    throw new TypeError("executable must not be empty");
  }
  if (options.cwd.trim().length === 0) {
    throw new TypeError("cwd must not be empty");
  }
  const timeoutMs = options.timeoutMs ?? options.timeout;
  validateNonNegativeFiniteInteger(timeoutMs, "timeoutMs");

  const stdoutLimit = normalizeTailBytes(
    options.stdoutTailBytes ?? options.maxStdoutBytes,
    "stdoutTailBytes",
    DEFAULT_STDOUT_TAIL_BYTES
  );
  const stderrLimit = normalizeTailBytes(
    options.stderrTailBytes ?? options.maxStderrBytes,
    "stderrTailBytes",
    DEFAULT_STDERR_TAIL_BYTES
  );
  validateNonNegativeFiniteInteger(
    options.forceKillAfterDelayMs,
    "forceKillAfterDelayMs"
  );

  const validateCwd =
    options.validateCwd ??
    options.cwdValidator ??
    options.cwdGuard ??
    options.cwdContainment;
  await validateCwd?.(options.cwd);

  const args = [...(options.args ?? [])];
  const stdoutTail = new ByteTail(stdoutLimit);
  const stderrTail = new ByteTail(stderrLimit);
  const startedAt = Date.now();
  const forceKillAfterDelay =
    options.forceKillAfterDelayMs === undefined
      ? DEFAULT_FORCE_KILL_AFTER_DELAY_MS
      : options.forceKillAfterDelayMs;

  let timedOutByRunner = false;
  let cancelledByRunner = false;
  let exited = false;
  let treeTerminationRequested = false;
  let treeKillTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const subprocess = execa(options.executable, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    timeout: timeoutMs ?? 0,
    cancelSignal: options.signal ?? options.cancelSignal,
    forceKillAfterDelay,
    detached: process.platform !== "win32",
    windowsHide: true,
    stripFinalNewline: false,
    buffer: false,
  });

  subprocess.stdout?.on("data", (chunk: Buffer | string) => stdoutTail.append(chunk));
  subprocess.stderr?.on("data", (chunk: Buffer | string) => stderrTail.append(chunk));
  subprocess.once("exit", () => {
    exited = true;
  });

  const terminateTree = (): void => {
    if (exited || subprocess.pid === undefined || treeTerminationRequested) return;
    treeTerminationRequested = true;
    treeKillTimer = terminateProcessTree(subprocess.pid, forceKillAfterDelay);
  };

  const onAbort = (): void => {
    cancelledByRunner = true;
    terminateTree();
  };
  const cancelSignal = options.signal ?? options.cancelSignal;
  cancelSignal?.addEventListener("abort", onAbort, { once: true });

  if (timeoutMs !== undefined && timeoutMs > 0) {
    // Execa owns the timeout result/error classification. This companion
    // timer only ensures the detached process group receives the same stop.
    timeoutTimer = setTimeout(() => {
      timedOutByRunner = true;
      terminateTree();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  try {
    const result = await subprocess;
    const stdout = stdoutTail.toString();
    const stderr = stderrTail.toString();
    return {
      executable: options.executable,
      args,
      cwd: options.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout,
      stderr,
      stdoutTail: stdout,
      stderrTail: stderr,
      durationMs: Date.now() - startedAt,
      failed: result.failed,
      timedOut: result.timedOut || timedOutByRunner,
      cancelled: result.isCanceled || cancelledByRunner,
      isCanceled: result.isCanceled || cancelledByRunner,
      isForcefullyTerminated: result.isForcefullyTerminated,
      ...(result.message === undefined ? {} : { errorMessage: result.message }),
      ...(result.code === undefined ? {} : { errorCode: result.code }),
    };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (treeKillTimer !== undefined && !treeTerminationRequested) {
      clearTimeout(treeKillTimer);
    }
    cancelSignal?.removeEventListener("abort", onAbort);
  }
}

/** Descriptive alias for integrations that prefer the longer name. */
export const runStructuredProcess = runProcess;
export const executeProcess = runProcess;

/** Small object-oriented facade for callers that register a shared cwd hook. */
export class ProcessRunner {
  constructor(private readonly defaults: Partial<ProcessRunOptions> = {}) {}

  run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    return runProcess({ ...this.defaults, ...options });
  }
}
