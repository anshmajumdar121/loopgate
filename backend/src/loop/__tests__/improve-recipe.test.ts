import { describe, it, expect } from "vitest";
import { buildImproveRecipe } from "../improve-recipe.js";
import type { Finding } from "../trace-analysis.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    kind: "repeated-reject",
    pattern: "criteria missing",
    count: 5,
    examples: [
      { taskId: "t1", attempt: 1 },
      { taskId: "t2", attempt: 1 },
    ],
    role: "verifier",
    suggestedFix: "prompt",
    ...overrides,
  };
}

const FIXED_DATE = new Date("2026-07-16T12:00:00Z");

describe("buildImproveRecipe", () => {
  it("returns a 'nothing to fix' message when findings are empty", () => {
    const md = buildImproveRecipe([], { now: FIXED_DATE });
    expect(md).toContain("Nothing To Fix");
    expect(md).toContain("2026-07-16");
  });

  it("renders one Finding block per included finding with role + count + examples", () => {
    const md = buildImproveRecipe(
      [
        finding({ pattern: "criteria missing", count: 7 }),
        finding({ pattern: "build step failed", count: 4 }),
      ],
      { now: FIXED_DATE }
    );
    expect(md).toContain("Finding 1 — \"criteria missing\" (7 tasks)");
    expect(md).toContain("Finding 2 — \"build step failed\" (4 tasks)");
    expect(md).toContain("- Role: verifier");
    expect(md).toContain("t1 (attempt 1)");
  });

  it("caps at topN (default 3, hard max 5)", () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      finding({ pattern: `pattern ${i}`, count: 10 - i })
    );
    const md = buildImproveRecipe(six, { now: FIXED_DATE });
    // 3 findings by default
    expect(md.match(/### Finding/g)).toHaveLength(3);
    // 5 even when asked for 99
    const md2 = buildImproveRecipe(six, { now: FIXED_DATE, topN: 99 });
    expect(md2.match(/### Finding/g)).toHaveLength(5);
  });

  it("includes the file allowlist restricted to .opencode/agents/", () => {
    const md = buildImproveRecipe([finding({})], { now: FIXED_DATE });
    // Allowlist section (## Files to touch) must list only the 3 agent prompts.
    const allowMatch = md.match(/## Files to touch\n([\s\S]*?)\n## /);
    expect(allowMatch).not.toBeNull();
    const allowList = allowMatch![1];
    expect(allowList).toContain(".opencode/agents/loop-planner.md");
    expect(allowList).toContain(".opencode/agents/loop-maker.md");
    expect(allowList).toContain(".opencode/agents/loop-verifier.md");
    // No non-agents paths in the allowlist.
    expect(allowList).not.toMatch(/^-\s+\.\/backend/m);
    expect(allowList).not.toMatch(/^-\s+\.\/ui/m);
  });

  it("includes the loop-constraints denylist (auth/payments/secrets)", () => {
    const md = buildImproveRecipe([finding({})], { now: FIXED_DATE });
    expect(md).toContain("auth/**");
    expect(md).toContain("payments/**");
    expect(md).toContain("**/secrets/**");
  });

  it("includes checkable completion criteria (>= 5 bullets)", () => {
    const md = buildImproveRecipe([finding({})], { now: FIXED_DATE });
    const criteria = md.match(/^- \[ \] /gm) ?? [];
    expect(criteria.length).toBeGreaterThanOrEqual(5);
  });

  it("embeds the current date in the header", () => {
    const md = buildImproveRecipe([finding({})], { now: FIXED_DATE });
    expect(md).toContain("(2026-07-16)");
  });
});
