export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type CleanupHandler = () => void | Promise<void>;

export interface ShutdownSignalSource {
  once?(signal: ShutdownSignal, listener: () => void): unknown;
  on?(signal: ShutdownSignal, listener: () => void): unknown;
  off?(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener?(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface InstallShutdownHandlersOptions {
  processLike?: ShutdownSignalSource;
  exit?: (code: number) => void;
  onError?: (error: unknown) => void;
  exitCode?: number | ((signal: ShutdownSignal) => number);
  errorExitCode?: number;
}

function removeSignalListener(
  source: ShutdownSignalSource,
  signal: ShutdownSignal,
  listener: () => void
): void {
  if (source.off !== undefined) {
    source.off(signal, listener);
  } else {
    source.removeListener?.(signal, listener);
  }
}

/**
 * Coordinates shared cancellation and asynchronous resource cleanup.
 *
 * `shutdown()` is deliberately memoized: concurrent signals and repeated
 * callers observe the same promise and handlers run at most once.
 */
export class ShutdownCoordinator {
  private readonly controller: AbortController;
  private readonly handlers = new Set<CleanupHandler>();
  private shutdownPromise: Promise<void> | undefined;
  private shutdownFinished = false;

  constructor(controller: AbortController = new AbortController()) {
    this.controller = controller;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  get isShuttingDown(): boolean {
    return this.shutdownPromise !== undefined;
  }

  get isShutdownComplete(): boolean {
    return this.shutdownFinished;
  }

  /** Register a cleanup and receive an idempotent unregister callback. */
  register(handler: CleanupHandler): () => void {
    if (this.shutdownPromise !== undefined) {
      // The coordinator has already taken its cleanup snapshot. A late
      // registration is still honored after the existing shutdown settles.
      let active = true;
      void this.shutdownPromise.then(
        async () => {
          if (active) await handler();
        },
        async () => {
          if (active) await handler();
        }
      ).catch(() => {
        // Late registrations have no caller-facing shutdown promise to
        // reject. The original shutdown result remains authoritative.
      });
      return () => {
        active = false;
      };
    }

    this.handlers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.handlers.delete(handler);
    };
  }

  registerCleanup(handler: CleanupHandler): () => void {
    return this.register(handler);
  }

  /** Abort all consumers of the shared signal without running cleanup. */
  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  shutdown(reason?: unknown): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;

    const pending = [...this.handlers].reverse();
    this.handlers.clear();
    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });

    this.abort(reason);
    void (async () => {
      const errors: unknown[] = [];
      for (const handler of pending) {
        try {
          await handler();
        } catch (error) {
          // One broken cleanup must not strand the rest of the resources.
          errors.push(error);
        }
      }

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Shutdown cleanup failed");
      }
    })().then(
      () => {
        this.shutdownFinished = true;
        resolveShutdown();
      },
      (error: unknown) => {
        this.shutdownFinished = true;
        rejectShutdown(error);
      }
    );
    return this.shutdownPromise;
  }

  close(reason?: unknown): Promise<void> {
    return this.shutdown(reason);
  }

  whenShutdownComplete(): Promise<void> {
    return this.shutdownPromise ?? Promise.resolve();
  }
}

/**
 * Install SIGINT/SIGTERM listeners explicitly. Nothing is installed when
 * this module is imported; callers choose when to opt into process handling.
 */
export function installShutdownHandlers(
  coordinator: ShutdownCoordinator,
  options: InstallShutdownHandlersOptions = {}
): () => void {
  const processLike = options.processLike ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const errorExitCode = options.errorExitCode ?? 1;
  let exitCalled = false;

  const handleSignal = (signal: ShutdownSignal): void => {
    void coordinator.shutdown(signal).then(
      () => {
        if (exitCalled) return;
        exitCalled = true;
        const configured = options.exitCode;
        exit(typeof configured === "function" ? configured(signal) : configured ?? 0);
      },
      (error: unknown) => {
        onError(error);
        if (exitCalled) return;
        exitCalled = true;
        exit(errorExitCode);
      }
    );
  };

  const onSigint = (): void => handleSignal("SIGINT");
  const onSigterm = (): void => handleSignal("SIGTERM");
  const addListener = processLike.once ?? processLike.on;
  if (addListener === undefined) {
    throw new TypeError("processLike must expose once() or on()");
  }
  addListener.call(processLike, "SIGINT", onSigint);
  addListener.call(processLike, "SIGTERM", onSigterm);

  return () => {
    removeSignalListener(processLike, "SIGINT", onSigint);
    removeSignalListener(processLike, "SIGTERM", onSigterm);
  };
}

/** Short alias for callers that use the module name as the function name. */
export const installShutdown = installShutdownHandlers;
export const installSignalHandlers = installShutdownHandlers;
