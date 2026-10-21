import type { AntiCheatResult } from "./anti-cheat.js";
import type { DeterministicCheckResult, CheckEventSink } from "./checks.js";
import type { PlanSchema, VerdictSchema } from "./schemas.js";

export interface GateRuntimeEvidence {
  required: boolean;
  available: boolean;
  passed: boolean;
  reason?: string;
}

export interface GatePolicyStatus {
  clean: boolean;
  reasons?: readonly string[];
}

export interface ApprovalGateInput {
  plan: PlanSchema;
  verifier: Pick<VerdictSchema, "outcome" | "criteria" | "requiredFixes">;
  checks: readonly DeterministicCheckResult[];
  antiCheat: AntiCheatResult;
  writePolicy: GatePolicyStatus;
  runtime?: GateRuntimeEvidence;
  goalText?: string;
  scriptThresholdUsed?: boolean;
  scriptThresholdSatisfied?: boolean;
  existingFiles?: readonly string[];
  malformedVerdict?: boolean;
  eventLog?: CheckEventSink;
  runId?: string;
  itemId?: string;
  attemptId?: string;
}

export interface ApprovalGateDecision {
  approved: boolean;
  outcome: "APPROVE" | "REJECT";
  requiredFixes: string[];
  reasons: string[];
}

/**
 * The only function allowed to turn a verifier response into approval. Every
 * other outcome is fail-closed and carries all observed blockers forward.
 */
export function evaluateApprovalGate(input: ApprovalGateInput): ApprovalGateDecision {
  const reasons: string[] = [];
  const requiredFixes = [...input.verifier.requiredFixes];

  const guardedScriptApproval =
    input.scriptThresholdUsed &&
    input.scriptThresholdSatisfied &&
    canUseScriptThreshold(input.plan, input.goalText ?? "");
  if (input.verifier.outcome !== "APPROVE" && !guardedScriptApproval) {
    reasons.push(`verifier outcome ${input.verifier.outcome}`);
  }
  if (input.malformedVerdict) reasons.push("malformed verdict");

  const failedChecks = input.checks.filter((check) => !check.passed);
  for (const check of failedChecks) {
    reasons.push(check.reason ? `${check.id}: ${check.reason}` : `${check.id} failed`);
  }

  if (!input.antiCheat.clean) reasons.push(...input.antiCheat.reasons);
  if (!input.writePolicy.clean) reasons.push(...(input.writePolicy.reasons ?? ["write policy violation"]));

  if (input.runtime?.required) {
    if (!input.runtime.available) reasons.push(input.runtime.reason ?? "runtime check unavailable");
    else if (!input.runtime.passed) reasons.push(input.runtime.reason ?? "runtime check failed");
  }

  if (input.scriptThresholdUsed && !canUseScriptThreshold(input.plan, input.goalText ?? "")) {
    reasons.push("script score-threshold bypass is not allowed for a code-change goal");
  }

  const checksByRef = new Map<string, DeterministicCheckResult>();
  for (const check of input.checks) {
    checksByRef.set(check.id, check);
    checksByRef.set(check.ref, check);
    if (check.ref.startsWith("check:")) checksByRef.set(check.ref.slice("check:".length), check);
    if (check.ref.startsWith("file:")) checksByRef.set(check.ref.slice("file:".length), check);
  }
  const existingFiles = new Set(input.existingFiles ?? []);
  for (const criterion of input.plan.criteria) {
    const cited = input.verifier.criteria.find((item) => item.id === criterion.id);
    if (!cited) {
      reasons.push(`criterion ${criterion.id} has no verifier evidence`);
      continue;
    }
    if (!cited.passed) reasons.push(`criterion ${criterion.id} failed`);
    const evidenceRef = cited.evidence.ref;
    const evidence = checksByRef.get(evidenceRef);
    const evidenceFile = cited.evidence.kind === "file"
      ? checksByRef.get(evidenceRef) ?? checksByRef.get(`file:${evidenceRef}`)
      : undefined;
    if (cited.evidence.kind === "check") {
      if (!evidence || evidence.kind !== "check" || !evidence.passed) {
        reasons.push(`criterion ${criterion.id} cites a check that did not pass: ${evidenceRef}`);
      }
    } else if (
      (!evidenceFile || evidenceFile.kind !== "file" || !evidenceFile.passed) &&
      !existingFiles.has(evidenceRef) &&
      !existingFiles.has(evidenceRef.replace(/^file:/, ""))
    ) {
      reasons.push(`criterion ${criterion.id} cites a file that does not exist: ${evidenceRef}`);
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) requiredFixes.unshift(...uniqueReasons);
  const decision: ApprovalGateDecision = {
    approved: uniqueReasons.length === 0,
    outcome: uniqueReasons.length === 0 ? "APPROVE" : "REJECT",
    requiredFixes: [...new Set(requiredFixes)],
    reasons: uniqueReasons,
  };
  recordGateEvent(input, decision);
  return decision;
}

export const applyApprovalGate = evaluateApprovalGate;

export function canUseScriptThreshold(plan: PlanSchema, goalText: string): boolean {
  if (plan.filesToTouch.length !== 1 || plan.filesToTouch[0] !== "script.md") return false;
  return !goalAsksForCodeChanges(goalText);
}

export function goalAsksForCodeChanges(goalText: string): boolean {
  return /\b(?:code|source|implementation|implement|typescript|javascript|component|function|bug fix|refactor|tests?)\s+(?:changes?|work|task|implementation|fix|code)?\b/i.test(goalText) ||
    /\b(?:change|edit|modify|update|fix|refactor)\b[\s\S]{0,40}\b(?:code|source|test|config|package\.json)\b/i.test(goalText);
}

function recordGateEvent(input: ApprovalGateInput, decision: ApprovalGateDecision): void {
  if (!input.eventLog || !input.runId) return;
  try {
    input.eventLog.appendEvent({
      runId: input.runId,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      type: "gate.decision",
      payload: decision,
    });
  } catch {
    // The decision itself remains authoritative even if telemetry is down.
  }
}
