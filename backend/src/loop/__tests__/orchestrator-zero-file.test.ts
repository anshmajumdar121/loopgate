import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tasks from "../../store/tasks.js";
import { spawnAgent, type AgentName } from "../agent-spawner.js";
import { runBuildStep } from "../build-runner.js";
import { runLoopLegacy } from "../orchestrator.js";
import { runRuntimeCheck } from "../runtime-check.js";
import { watchFiles, type WatchedFile } from "../state-sync.js";
import type { VerdictSchema } from "../v2/schemas.js";

// Keep task/default-attempt handling, parsing, validation, snapshots, checks,
// and the approval gate real. Only external agents, browsers, and persistence
// are replaced; every workspace read/write is in a disposable directory.
const eventLog = vi.hoisted(() => ({
  appendEvent: vi.fn<(event: { type: string; payload: unknown }) => void>(),
}));

vi.mock("../../store/persistence.js", () => ({
  TASK_DATA_DIR: "unused-mocked-task-data",
  saveTask: vi.fn(async () => {}),
  deleteTaskFile: vi.fn(async () => {}),
  isActiveStatus: vi.fn(),
}));
vi.mock("../../store/connections.js", () => ({
  connectionsForRole: vi.fn(() => []),
  defaultModelIdForConnection: vi.fn(),
  resolveConnectionModel: vi.fn(() => null),
}));
vi.mock("../../ws/broadcaster.js", () => ({
  broadcaster: { broadcast: vi.fn(), broadcastLog: vi.fn() },
}));
vi.mock("../../demo/publicDemo.js", () => ({
  DEMO_MODEL: "mock-model",
  isPublicDemo: () => false,
  isWithinDir: vi.fn(),
}));
vi.mock("../agent-spawner.js", () => ({ spawnAgent: vi.fn(), killAgent: vi.fn() }));
vi.mock("../state-sync.js", () => ({ watchFiles: vi.fn() }));
vi.mock("../build-runner.js", () => ({ runBuildStep: vi.fn() }));
vi.mock("../runtime-check.js", () => ({ runRuntimeCheck: vi.fn() }));
vi.mock("../preview-server.js", () => ({
  registerPreview: vi.fn(async () => "http://preview.invalid/"),
  getPreviewServerBindCount: () => 0,
}));
vi.mock("../connection-health.js", () => ({ ensureFreshHealth: vi.fn() }));
vi.mock("../v2/engine.js", () => ({
  isV2EngineEnabled: () => true,
  getV2EventLog: () => eventLog,
  closeV2EventLogs: vi.fn(),
  runLoopV2: vi.fn(),
}));

let workdir: string;
let artifact: string;
let reportedFiles: string[];
let blockedWrites: string;
let writeMakerFiles: () => Promise<void>;
let verifierOutcome: VerdictSchema["outcome"];

function goal(): string {
  return [
    "# Goal",
    "## Completion Criteria",
    "- [ ] The requested artifact is complete",
    "## Implementation Plan",
    "1. Produce the requested artifact",
    "## Files to touch",
    `- ${artifact}`,
  ].join("\n");
}

function createTask(overrides: Partial<Parameters<typeof tasks.createTask>[0]> = {}) {
  return tasks.createTask({
    prompt: "Build a page",
    workdir,
    maxAttempts: 1,
    autoApprovePlan: true,
    autoIterate: true,
    ...overrides,
  });
}

function events(type: string): unknown[] {
  return eventLog.appendEvent.mock.calls
    .filter(([event]) => event.type === type)
    .map(([event]) => event.payload);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("LOOP_ALLOW_MOCK", "0");
  vi.stubEnv("LOOP_TEST_DISABLE_DEFENCE", "");
  // Successful phases leave cancellation polling behind. Keep those timers
  // local to the test instead of leaking them into subsequent fixtures.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  workdir = await mkdtemp(join(tmpdir(), "loop-zero-file-"));
  artifact = "index.html";
  reportedFiles = [];
  blockedWrites = "";
  writeMakerFiles = async () => {};
  verifierOutcome = "APPROVE";
  // Resolve any unexpected feedback wait so the regression fails an assertion
  // rather than hanging; the final attempt must never request this event.
  vi.spyOn(tasks, "waitForEvent").mockResolvedValue(undefined);
  vi.mocked(runBuildStep).mockResolvedValue(undefined);
  vi.mocked(runRuntimeCheck).mockResolvedValue({
    ok: true,
    url: "http://preview.invalid/",
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    interactionLog: [],
    screenshotPath: null,
    evidenceMarkdown: "Mocked runtime: no errors",
  });

  let role: AgentName = "planner";
  let attempt = 1;
  vi.mocked(spawnAgent).mockImplementation((nextRole, _id, _dir, _prompt, _out, _err, _exit, options) => {
    role = nextRole;
    attempt = options?.attempt ?? 1;
    return { pid: 1, isMock: true, exited: new Promise(() => {}), kill: vi.fn(), lastActivityAt: Date.now() };
  });
  const latest = new Map<WatchedFile, string>();
  const generations = new Map<WatchedFile, number>();
  vi.mocked(watchFiles).mockReturnValue({
    ready: async () => {},
    stop: vi.fn(),
    onChange: () => () => {},
    getLatestContent: (file) => latest.get(file) ?? null,
    getGeneration: (file) => generations.get(file) ?? 0,
    awaitChange: async (file) => {
      let content: string;
      if (role === "planner") {
        content = goal();
      } else {
        const before = await readFile(join(workdir, "STATE.md"), "utf8");
        if (role === "maker") {
          await writeMakerFiles();
          content = before + [
            `\n## Diff Summary — Attempt ${attempt}`,
            "**Files changed:**",
            ...reportedFiles.map((path) => `- ${path} — updated artifact`),
            "**Build:** 0",
            "**Tests:** 0 — 1 passed, 0 failed",
            blockedWrites,
            "",
          ].join("\n");
        } else {
          const verdict: VerdictSchema = {
            attempt,
            outcome: verifierOutcome,
            criteria: [{
              id: "criterion-1",
              passed: true,
              evidence: { kind: "file", ref: artifact },
            }],
            requiredFixes: [],
          };
          content = `${before}\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`;
        }
      }
      await writeFile(join(workdir, file), content);
      latest.set(file, content);
      generations.set(file, (generations.get(file) ?? 0) + 1);
      return content;
    },
  });
});

afterEach(async () => {
  for (const task of tasks.listTasks()) tasks.removeTask(task.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(workdir, { recursive: true, force: true });
});

describe("zero-file attempts reach the real approval gate", () => {
  it.each([true, false])("retains missing-file evidence at maxAttempts=1 (autoIterate=%s)", async (autoIterate) => {
    const task = createTask({ autoIterate });
    await runLoopLegacy(task.id);

    const final = tasks.getTask(task.id)!;
    expect(final).toMatchObject({ status: "escalated", maxAttempts: 1, attempt: 1 });
    expect(vi.mocked(spawnAgent).mock.calls.map(([role]) => role)).toEqual(["planner", "maker", "verifier"]);
    expect(tasks.waitForEvent).not.toHaveBeenCalled();
    expect(events("check.result")).toContainEqual(expect.objectContaining({
      id: "file:index.html", kind: "file", passed: false, reason: "file does not exist: index.html",
    }));
    expect(events("gate.decision")).toEqual([expect.objectContaining({ approved: false })]);
    expect(final.verdict?.outcome).toBe("REJECT");
    expect(final.verdict?.requiredFixes).toContainEqual(expect.stringMatching(/^gate:file-missing:index\.html/));
    expect(final.escalationReason).toContain("gate:file-missing:index.html");
    expect(final.escalationReason).toContain("Exceeded max 1 attempts");
    expect(final.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, verifierVerdict: "REJECT" })]);
  });

  it("keeps the default budget of three and never starts a fourth empty attempt", async () => {
    const task = createTask({ maxAttempts: undefined });
    expect(task.maxAttempts).toBe(3);
    await runLoopLegacy(task.id);

    const final = tasks.getTask(task.id)!;
    expect(final).toMatchObject({ status: "escalated", maxAttempts: 3, attempt: 3 });
    expect(vi.mocked(spawnAgent).mock.calls.filter(([role]) => role === "maker")).toHaveLength(3);
    expect(events("gate.decision")).toHaveLength(3);
    expect(final.attempts?.map((attempt) => attempt.verifierVerdict)).toEqual(["REJECT", "REJECT", "REJECT"]);
  });

  it("carries anti-cheat and blocked-write reasons alongside missing-file evidence", async () => {
    await writeFile(join(workdir, "artifact.test.js"), 'it("artifact", () => expect(render()).toBe("ready"));\n');
    writeMakerFiles = async () => {
      await writeFile(join(workdir, "artifact.test.js"), 'it.skip("artifact", () => expect(render()).toBe("ready"));\n');
    };
    blockedWrites = "**Blocked writes**: ../outside.js (outside workdir)";
    const task = createTask();
    await runLoopLegacy(task.id);

    const final = tasks.getTask(task.id)!;
    expect(final.verdict?.requiredFixes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^gate:file-missing:index\.html/),
      expect.stringMatching(/^anti-cheat:skip-added:/),
      "policy:path-escape:../outside.js",
      "blocked write: ../outside.js",
    ]));
    for (const reason of final.verdict!.requiredFixes) expect(final.escalationReason).toContain(reason);
    expect(runBuildStep).not.toHaveBeenCalled();
    expect(runRuntimeCheck).not.toHaveBeenCalled();
    expect(events("gate.decision")).toHaveLength(1);
  });

  it.each(["0", "1"])("keeps the missing-file mutation opt-in (LOOP_ALLOW_MOCK=%s)", async (allowMock) => {
    vi.stubEnv("LOOP_ALLOW_MOCK", allowMock);
    vi.stubEnv("LOOP_TEST_DISABLE_DEFENCE", "missing-file");
    const task = createTask();
    await runLoopLegacy(task.id);

    const final = tasks.getTask(task.id)!;
    expect(final.status).toBe(allowMock === "1" ? "done" : "escalated");
    expect(events("gate.decision")).toEqual([expect.objectContaining({ approved: allowMock === "1" })]);
  });

  it.each([
    ["index.html", "<main>unfinished", /validation: HTML error/],
    ["app.js", "const = ;", /validation: syntax error/],
  ] as const)("still short-circuits invalid nonempty %s diffs", async (path, content, reason) => {
    artifact = path;
    reportedFiles = [path];
    writeMakerFiles = async () => { await writeFile(join(workdir, path), content); };
    const task = createTask();
    await runLoopLegacy(task.id);

    const final = tasks.getTask(task.id)!;
    expect(final.status).toBe("escalated");
    expect(final.attempts?.[0].validation).toMatchObject({ passed: false, errors: [expect.stringMatching(reason)] });
    expect(vi.mocked(spawnAgent).mock.calls.map(([role]) => role)).toEqual(["planner", "maker"]);
    expect(runBuildStep).not.toHaveBeenCalled();
    expect(runRuntimeCheck).not.toHaveBeenCalled();
    expect(events("gate.decision")).toEqual([]);
  });

  it("does not allow the script score threshold to approve a code-change goal", async () => {
    artifact = "script.md";
    verifierOutcome = "REJECT";
    await writeFile(join(workdir, artifact), "A readable script.\n");
    const task = createTask({ prompt: "Make code changes to the parser" });
    await runLoopLegacy(task.id);

    expect(tasks.getTask(task.id)?.status).toBe("escalated");
    expect(runBuildStep).not.toHaveBeenCalled();
    expect(runRuntimeCheck).not.toHaveBeenCalled();
    expect(events("gate.decision")).toEqual([
      expect.objectContaining({ approved: false }),
      expect.objectContaining({
        approved: false,
        requiredFixes: expect.arrayContaining(["script score-threshold bypass is not allowed for a code-change goal"]),
      }),
    ]);
  });
});
