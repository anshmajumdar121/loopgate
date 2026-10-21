import { describe, expect, it } from "vitest";
import {
  PlanSchema,
  VerdictSchema,
  isAllowedCheckCommand,
  parseStructuredVerdict,
} from "../schemas.js";

describe("v2 structured schemas", () => {
  it("accepts the supported deterministic check commands", () => {
    for (const command of [
      ["npm", "test"],
      ["npm", "run", "build"],
      ["pnpm", "run", "lint", "--", "quiet"],
      ["npx", "tsc", "--noEmit"],
      ["npx", "vitest", "run"],
      ["yarn", "run", "typecheck"],
    ]) {
      expect(isAllowedCheckCommand(command)).toBe(true);
    }
  });

  it("rejects install, shell, and arbitrary commands at plan time", () => {
    for (const command of [
      ["npm", "install"],
      ["sh", "-c", "npm test"],
      ["npm", "run", "start"],
      ["node", "-e", "process.exit(0)"],
      ["npx"],
    ]) {
      expect(isAllowedCheckCommand(command)).toBe(false);
      expect(
        PlanSchema.safeParse({
          criteria: [],
          filesToTouch: [],
          checks: [{ id: "bad", cmd: command, timeoutMs: 1000 }],
        }).success,
      ).toBe(false);
    }
  });

  it("validates a complete plan and rejects unsafe timeout values", () => {
    const plan = {
      criteria: [{ id: "c1", text: "the page exists" }],
      filesToTouch: ["index.html"],
      checks: [{ id: "build", cmd: ["npm", "run", "build"], timeoutMs: 5000 }],
    };
    expect(PlanSchema.parse(plan)).toEqual(plan);
    expect(PlanSchema.safeParse({ ...plan, checks: [{ ...plan.checks[0], timeoutMs: 0 }] }).success).toBe(false);
  });

  it("accepts a valid fenced JSON verdict", () => {
    const parsed = parseStructuredVerdict(
      "```json\n" +
        JSON.stringify({
          attempt: 2,
          outcome: "APPROVE",
          criteria: [
            { id: "c1", passed: true, evidence: { kind: "file", ref: "index.html" } },
          ],
          requiredFixes: [],
        }) +
        "\n```",
    );
    expect(parsed.malformed).toBe(false);
    expect(parsed.verdict?.outcome).toBe("APPROVE");
  });

  it("fails closed when a fenced verdict is malformed", () => {
    const invalidJson = parseStructuredVerdict("```json\n{ nope\n```");
    expect(invalidJson.verdict).toBeNull();
    expect(invalidJson.malformed).toBe(true);

    const invalidShape = parseStructuredVerdict(
      "```json\n" + JSON.stringify({ attempt: 1, outcome: "APPROVE" }) + "\n```",
    );
    expect(invalidShape.verdict).toBeNull();
    expect(invalidShape.malformed).toBe(true);
  });

  it("uses markdown fallback only when no JSON verdict block exists", () => {
    const parsed = parseStructuredVerdict("## Verifier Verdict\n**Verdict:** APPROVE");
    expect(parsed).toEqual({ verdict: null, malformed: false });
    expect(VerdictSchema.safeParse({
      attempt: 1,
      outcome: "REJECT",
      criteria: [],
      requiredFixes: ["tests failed"],
    }).success).toBe(true);
  });
});
