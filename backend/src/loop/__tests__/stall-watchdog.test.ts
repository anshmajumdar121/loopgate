import { describe, it, expect } from "vitest";
import { withStallWatchdog, StallError } from "../orchestrator.js";
import type { AgentHandle } from "../agent-spawner.js";

// ponytail: tests pin the watchdog's contract — silent → StallError,
// active → result, late activity after success never fires the watchdog.
// The `pollMs` parameter exists so the test can drive a fast poll
// without waiting 30s of real time per assertion.

function silentAgent(lastSeenMs: number): AgentHandle {
  return {
    pid: 1,
    isMock: true,
    exited: new Promise(() => {}),
    lastActivityAt: lastSeenMs,
    kill: () => {},
  };
}

describe("withStallWatchdog", () => {
  it("rejects with StallError when agent has been quiet past the timeout", async () => {
    const agent = silentAgent(Date.now() - 200); // last activity 200ms ago
    const start = Date.now();
    await expect(
      withStallWatchdog(
        new Promise(() => {}), // never resolves
        agent,
        "verifier",
        100, // 100ms stall window
        20   // 20ms poll
      )
    ).rejects.toBeInstanceOf(StallError);
    // Watchdog fires on the next poll tick after the timeout — should
    // be well under 200ms.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("returns the inner result and never fires the watchdog while the agent streams", async () => {
    const agent = silentAgent(Date.now());
    // Update lastActivityAt every 30ms — faster than the 50ms stall
    // window. The watchdog should never see "stale" activity.
    const ticker = setInterval(() => {
      agent.lastActivityAt = Date.now();
    }, 30);
    try {
      const result = await withStallWatchdog(
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("verifier-output"), 120)
        ),
        agent,
        "verifier",
        50,  // 50ms stall window
        20   // 20ms poll
      );
      expect(result).toBe("verifier-output");
    } finally {
      clearInterval(ticker);
    }
  });

  it("does not fire StallError after the inner promise has resolved", async () => {
    const agent = silentAgent(Date.now());
    const result = await withStallWatchdog(
      Promise.resolve("immediate"),
      agent,
      "verifier",
      50,  // 50ms stall window
      20   // 20ms poll
    );
    expect(result).toBe("immediate");
    // Wait long enough for the watchdog to have polled several times
    // past the stall window. It must NOT throw a late StallError.
    await new Promise((r) => setTimeout(r, 100));
  });

  it("kills the agent when declaring a stall", async () => {
    let killed = false;
    const agent: AgentHandle = {
      pid: 1,
      isMock: true,
      exited: new Promise(() => {}),
      lastActivityAt: Date.now() - 500,
      kill: () => {
        killed = true;
      },
    };
    await expect(
      withStallWatchdog(
        new Promise(() => {}),
        agent,
        "planner",
        50,
        20
      )
    ).rejects.toBeInstanceOf(StallError);
    expect(killed).toBe(true);
  });

  it("StallError carries the phase name", () => {
    const err = new StallError("verifier");
    expect(err.phase).toBe("verifier");
    expect(err.message).toContain("verifier");
  });
});
