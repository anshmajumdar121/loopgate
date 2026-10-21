import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDeterministicChecks } from "../checks.js";
import type { PlanSchema } from "../schemas.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loop-checks-"));
  dirs.push(dir);
  return dir;
}

function plan(overrides: Partial<PlanSchema> = {}): PlanSchema {
  return {
    criteria: [],
    filesToTouch: [],
    checks: [],
    ...overrides,
  };
}

describe("v2 deterministic checks", () => {
  it("passes existing declared files and a changed-file subset", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "index.html"), "ok", "utf8");
    const events: unknown[] = [];
    const results = await runDeterministicChecks(
      plan({ filesToTouch: ["index.html"] }),
      {
        workdir,
        changedFiles: ["index.html"],
        runId: "run-1",
        eventLog: { appendEvent: (event) => events.push(event) },
      },
    );
    expect(results.every((result) => result.passed)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("fails closed for missing files and changed files outside the plan", async () => {
    const workdir = await makeWorkdir();
    const results = await runDeterministicChecks(
      plan({ filesToTouch: ["missing.ts"] }),
      { workdir, changedFiles: ["missing.ts", "secret.env"] },
    );
    expect(results.find((result) => result.kind === "file")?.passed).toBe(false);
    expect(results.find((result) => result.id === "scope")?.passed).toBe(false);
  });

  it("runs an allowed command and records its real exit code", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "vitest"), "process.exit(0);", "utf8");
    const results = await runDeterministicChecks(
      plan({ checks: [{ id: "vitest", cmd: ["node", "vitest"], timeoutMs: 10_000 }] }),
      { workdir },
    );
    const check = results.find((result) => result.id === "vitest");
    expect(check?.passed).toBe(true);
    expect(check?.exitCode).toBe(0);
    expect(check?.durationMs).toBeGreaterThanOrEqual(0);
    expect(check?.timeoutMs).toBe(10_000);
  });

  it("treats a non-zero command as a failure", async () => {
    const workdir = await makeWorkdir();
    const results = await runDeterministicChecks(
      plan({ checks: [{ id: "bad", cmd: ["npx", "tsc", "--definitely-invalid"], timeoutMs: 10_000 }] }),
      { workdir },
    );
    const check = results.find((result) => result.id === "bad");
    expect(check?.passed).toBe(false);
    expect(check?.exitCode).not.toBe(0);
  });

  it("kills a hanging declared check at its timeout", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "vitest"), "setInterval(() => {}, 60000);", "utf8");
    const started = Date.now();
    const results = await runDeterministicChecks(
      plan({ checks: [{ id: "hang", cmd: ["node", "vitest"], timeoutMs: 100 }] }),
      { workdir },
    );
    const check = results.find((result) => result.id === "hang");
    expect(check?.passed).toBe(false);
    expect(check?.timedOut).toBe(true);
    expect(check?.durationMs).toBeLessThanOrEqual((check?.timeoutMs ?? 100) + 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
