import { describe, expect, it, vi } from "vitest";
import {
  ShutdownCoordinator,
  installShutdownHandlers,
} from "../shutdown-coordinator.js";

describe("ShutdownCoordinator", () => {
  it("aborts its shared signal and runs cleanup handlers once", async () => {
    const coordinator = new ShutdownCoordinator();
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    coordinator.register(first);
    coordinator.register(second);

    const [firstResult, secondResult] = await Promise.all([
      coordinator.shutdown("SIGTERM"),
      coordinator.shutdown("SIGINT"),
    ]);

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(coordinator.signal.aborted).toBe(true);
    expect(coordinator.signal.reason).toBe("SIGTERM");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("continues cleanup after one handler fails and preserves the shared promise", async () => {
    const coordinator = new ShutdownCoordinator();
    const failing = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const succeeding = vi.fn(async () => {});
    coordinator.register(failing);
    coordinator.register(succeeding);

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    await expect(first).rejects.toThrow("cleanup failed");
    await expect(second).rejects.toThrow("cleanup failed");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("supports unregistering a cleanup handler", async () => {
    const coordinator = new ShutdownCoordinator();
    const cleanup = vi.fn(async () => {});
    const unregister = coordinator.register(cleanup);

    unregister();
    await coordinator.shutdown();

    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe("installShutdownHandlers", () => {
  it("installs removable SIGINT/SIGTERM listeners without module side effects", async () => {
    const coordinator = new ShutdownCoordinator();
    const exit = vi.fn();
    const onError = vi.fn();
    const signalSource = new (class extends EventTarget {
      once(event: "SIGINT" | "SIGTERM", listener: () => void): void {
        this.addEventListener(event, listener, { once: true });
      }

      off(event: "SIGINT" | "SIGTERM", listener: () => void): void {
        this.removeEventListener(event, listener);
      }

      emit(event: "SIGINT" | "SIGTERM"): void {
        this.dispatchEvent(new Event(event));
      }
    })();
    const cleanup = vi.fn(async () => {});
    coordinator.register(cleanup);

    const uninstall = installShutdownHandlers(coordinator, {
      processLike: signalSource,
      exit,
      onError,
    });

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    await coordinator.whenShutdownComplete();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(onError).not.toHaveBeenCalled();

    uninstall();
    expect(coordinator.signal.aborted).toBe(true);
  });

  it("reports cleanup failures and exits non-zero", async () => {
    const coordinator = new ShutdownCoordinator();
    const exit = vi.fn();
    const onError = vi.fn();
    const signalSource = new (class extends EventTarget {
      once(event: "SIGINT" | "SIGTERM", listener: () => void): void {
        this.addEventListener(event, listener, { once: true });
      }

      off(event: "SIGINT" | "SIGTERM", listener: () => void): void {
        this.removeEventListener(event, listener);
      }
    })();
    coordinator.register(async () => {
      throw new Error("cannot close");
    });

    installShutdownHandlers(coordinator, {
      processLike: signalSource,
      exit,
      onError,
    });
    signalSource.dispatchEvent(new Event("SIGINT"));
    await coordinator.whenShutdownComplete().catch(() => {});

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
