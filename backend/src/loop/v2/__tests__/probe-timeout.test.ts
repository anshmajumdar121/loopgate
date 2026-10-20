import { describe, expect, it } from "vitest";
import {
  ProbeTimeoutError,
  withProbeTimeout,
} from "../probe-timeout.js";

describe("withProbeTimeout", () => {
  it("passes an AbortSignal to the probe and returns its value", async () => {
    let receivedSignal: AbortSignal | undefined;
    const value = await withProbeTimeout(
      async (signal) => {
        receivedSignal = signal;
        return "healthy";
      },
      { timeoutMs: 100 }
    );

    expect(value).toBe("healthy");
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it("aborts the probe and rejects with a deterministic timeout error", async () => {
    let receivedSignal: AbortSignal | undefined;
    const promise = withProbeTimeout(
      (signal) => {
        receivedSignal = signal;
        return new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true }
          );
        });
      },
      { timeoutMs: 25, label: "connection preflight" }
    );

    await expect(promise).rejects.toMatchObject({
      name: "ProbeTimeoutError",
      message: "connection preflight timed out after 25ms",
      timeoutMs: 25,
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation instead of converting it to a timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped the probe");
    const promise = withProbeTimeout(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { timeoutMs: 500, signal: controller.signal }
    );

    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  it("also bounds a promise that cannot consume an AbortSignal", async () => {
    await expect(
      withProbeTimeout(new Promise(() => {}), { timeoutMs: 15 })
    ).rejects.toBeInstanceOf(ProbeTimeoutError);
  });

  it("rejects invalid timeout values before running the probe", async () => {
    let ran = false;
    await expect(
      withProbeTimeout(
        async () => {
          ran = true;
          return "never";
        },
        { timeoutMs: 0 }
      )
    ).rejects.toThrow("timeoutMs must be a positive finite number");
    expect(ran).toBe(false);
  });
});
