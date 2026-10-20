export interface ProbeTimeoutOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  label?: string;
}

export class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label: string;
  readonly code = "ERR_CONNECTION_PROBE_TIMEOUT";

  constructor(timeoutMs: number, label = "connection probe") {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
    this.timeoutMs = timeoutMs;
    this.label = label;
  }
}

export { ProbeTimeoutError as ConnectionProbeTimeoutError };
export { ProbeTimeoutError as TimeoutError };

type ProbeOperation<T> = (signal: AbortSignal) => T | PromiseLike<T>;
type ProbeInput<T> = ProbeOperation<T> | PromiseLike<T>;

function normalizeOptions(
  optionsOrTimeout: number | ProbeTimeoutOptions,
  parentSignal?: AbortSignal
): ProbeTimeoutOptions {
  const options =
    typeof optionsOrTimeout === "number"
      ? { timeoutMs: optionsOrTimeout, signal: parentSignal }
      : optionsOrTimeout;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  return {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label?.trim() || "connection probe",
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

/**
 * Run a connection preflight/health probe with a signal that is aborted at a
 * fixed deadline. Timeout errors are normalized to ProbeTimeoutError even if
 * the underlying fetch rejects with a generic AbortError.
 */
export async function withProbeTimeout<T>(
  operation: ProbeInput<T>,
  optionsOrTimeout: number | ProbeTimeoutOptions,
  parentSignal?: AbortSignal
): Promise<T> {
  const options = normalizeOptions(optionsOrTimeout, parentSignal);
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  const timeoutError = new ProbeTimeoutError(options.timeoutMs, options.label);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (error: ProbeTimeoutError) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      rejectTimeout(timeoutError);
    }, options.timeoutMs);
    timer.unref?.();
  });

  let rejectCaller!: (reason: unknown) => void;
  const callerCancellation = new Promise<never>((_, reject) => {
    rejectCaller = reject;
  });
  const onCallerAbort = (): void => {
    const reason = abortReason(callerSignal!);
    controller.abort(reason);
    rejectCaller(reason);
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let operationPromise: PromiseLike<T>;
  try {
    operationPromise =
      typeof operation === "function"
        ? Promise.resolve(operation(controller.signal))
        : Promise.resolve(operation);
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    throw error;
  }

  try {
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      ...(callerSignal === undefined ? [] : [callerCancellation]),
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Alias with a connection-specific name for future health wiring. */
export const withConnectionProbeTimeout = withProbeTimeout;

/** Generic alias useful for probe callers that do not need the long name. */
export const withTimeout = withProbeTimeout;
