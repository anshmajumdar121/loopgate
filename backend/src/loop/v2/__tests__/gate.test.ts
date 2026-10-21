import { describe, expect, it } from "vitest";
import type { AntiCheatResult } from "../anti-cheat.js";
import type { DeterministicCheckResult } from "../checks.js";
import { canUseScriptThreshold, evaluateApprovalGate } from "../gate.js";
import type { PlanSchema, VerdictSchema } from "../schemas.js";

const cleanAntiCheat: AntiCheatResult = { clean: true, reasons: [], changes: [] };
const fileCheck: DeterministicCheckResult = {
  id: "file:index.html",
  kind: "file",
  ref: "file:index.html",
  passed: true,
};
const scopeCheck: DeterministicCheckResult = {
  id: "scope",
  kind: "check",
  ref: "check:scope",
  passed: true,
};
const plan: PlanSchema = {
  criteria: [{ id: "c1", text: "page exists" }],
  filesToTouch: ["index.html"],
  checks: [],
};
const approve: VerdictSchema = {
  attempt: 1,
  outcome: "APPROVE",
  criteria: [{ id: "c1", passed: true, evidence: { kind: "file", ref: "index.html" } }],
  requiredFixes: [],
};

function input(overrides: Partial<Parameters<typeof evaluateApprovalGate>[0]> = {}) {
  return {
    plan,
    verifier: approve,
    checks: [fileCheck, scopeCheck],
    antiCheat: cleanAntiCheat,
    writePolicy: { clean: true },
    existingFiles: ["index.html"],
    ...overrides,
  };
}

describe("v2 code-level approval gate", () => {
  it("approves only when verifier, checks, evidence, anti-cheat, and policy are clean", () => {
    const decision = evaluateApprovalGate(input());
    expect(decision).toEqual({ approved: true, outcome: "APPROVE", requiredFixes: [], reasons: [] });
  });

  it("rejects verifier approval when a deterministic check failed", () => {
    const failed = { ...scopeCheck, passed: false, reason: "changed files outside plan" };
    const decision = evaluateApprovalGate(input({ checks: [fileCheck, failed] }));
    expect(decision.outcome).toBe("REJECT");
    expect(decision.requiredFixes.join("\n")).toContain("gate:check-failed:scope");
  });

  it("rejects anti-cheat and write-policy violations", () => {
    const decision = evaluateApprovalGate(
      input({
        antiCheat: { clean: false, reasons: ["test file deleted"], changes: [] },
        writePolicy: { clean: false, reasons: ["package.json blocked"] },
      }),
    );
    expect(decision.approved).toBe(false);
    expect(decision.requiredFixes).toEqual(expect.arrayContaining(["test file deleted", "package.json blocked"]));
  });

  it("rejects an unavailable runtime check instead of treating it as a pass", () => {
    const decision = evaluateApprovalGate(
      input({ runtime: { required: true, available: false, passed: false } }),
    );
    expect(decision.outcome).toBe("REJECT");
    expect(decision.requiredFixes.some((reason) => reason.startsWith("gate:runtime-unavailable"))).toBe(true);
  });

  it("rejects missing or non-passing evidence references", () => {
    const missing = evaluateApprovalGate(
      input({ verifier: { ...approve, criteria: [] } }),
    );
    expect(missing.reasons.some((reason) => reason.startsWith("gate:evidence-missing:c1"))).toBe(true);

    const badCheck = evaluateApprovalGate(
      input({
        plan: { ...plan, criteria: [{ id: "c1", text: "page exists" }] },
        verifier: {
          ...approve,
          criteria: [{ id: "c1", passed: true, evidence: { kind: "check", ref: "check:missing" } }],
        },
      }),
    );
    expect(badCheck.reasons.some((reason) => reason.startsWith("gate:evidence-missing:check:missing"))).toBe(true);
  });

  it("maps REJECT and ESCALATE verifier outcomes to a fail-closed REJECT", () => {
    for (const outcome of ["REJECT", "ESCALATE"] as const) {
      const decision = evaluateApprovalGate(input({ verifier: { ...approve, outcome } }));
      expect(decision.outcome).toBe("REJECT");
    }
  });

  it("does not allow the script score bypass for a code-change goal", () => {
    const scriptPlan: PlanSchema = { ...plan, filesToTouch: ["script.md"] };
    expect(canUseScriptThreshold(scriptPlan, "make code changes to the parser")).toBe(false);
    expect(canUseScriptThreshold(scriptPlan, "rewrite this social script for clarity")).toBe(true);
    const decision = evaluateApprovalGate(
      input({ plan: scriptPlan, goalText: "make code changes to the parser", scriptThresholdUsed: true }),
    );
    expect(decision.reasons.join("\n")).toContain("code-change goal");

    const guardedScript = evaluateApprovalGate(
      input({ plan: scriptPlan, goalText: "rewrite this social script for clarity", scriptThresholdUsed: true, scriptThresholdSatisfied: true }),
    );
    expect(guardedScript.approved).toBe(true);
  });

  it("records the final decision through the event sink", () => {
    const events: unknown[] = [];
    evaluateApprovalGate(input({ runId: "run-1", eventLog: { appendEvent: (event) => events.push(event) } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "gate.decision", runId: "run-1" });
  });
});
