/**
 * Last-resort process guards. A stray rejected promise or thrown callback
 * must not take the whole backend (and every running loop) down. We log
 * LOUDLY so the bug is still visible, and keep serving.
 */

type Logger = (...args: unknown[]) => void;

const BANNER = "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!";

export function makeUnhandledRejectionHandler(log: Logger = console.error) {
  return (reason: unknown): void => {
    try {
      log(BANNER);
      log("[loop-agent-backend] UNHANDLED PROMISE REJECTION (process kept alive):", reason);
      log(BANNER);
    } catch {
      /* never throw from a process guard */
    }
  };
}

export function makeUncaughtExceptionHandler(log: Logger = console.error) {
  return (err: unknown, origin?: string): void => {
    try {
      log(BANNER);
      log(
        `[loop-agent-backend] UNCAUGHT EXCEPTION${origin ? ` (${origin})` : ""} (process kept alive):`,
        err
      );
      log(BANNER);
    } catch {
      /* never throw from a process guard */
    }
  };
}

let installed = false;

/** Install once per process. Returns true if this call installed them. */
export function installProcessGuards(log: Logger = console.error): boolean {
  if (installed) return false;
  installed = true;
  process.on("unhandledRejection", makeUnhandledRejectionHandler(log));
  process.on("uncaughtException", makeUncaughtExceptionHandler(log));
  return true;
}
