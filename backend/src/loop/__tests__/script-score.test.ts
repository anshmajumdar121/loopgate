// Tests for the script-loop score mechanism (Part: autonomous /10 score
// threshold in the orchestrator + the matching helper in ProgressNode).
//
// The math is intentionally dead-simple — it's the same single line in
// both backend (orchestrator.ts) and UI (ProgressNode.tsx), so a drift
// between the two surfaces is the main thing to catch. We also pin the
// threshold default to 7/10 so a future env-var default change is a
// visible commit, not a silent regression.

import { describe, it, expect } from "vitest";
import {
  scaleScoreOutOf10,
  applyNodeTagFallback,
  groupCriteriaByNode,
  SCRIPT_LOOP_MIN_SCORE_OUT_OF_10,
} from "../orchestrator.js";
import { parseStateDiff } from "../parser.js";
import type { CriteriaWalkItem } from "../../types.js";

describe("scaleScoreOutOf10", () => {
  it("rounds (passed * 10) / total to the nearest integer", () => {
    // 5/7 = 7.142… → 7
    expect(scaleScoreOutOf10(5, 7)).toBe(7);
    // 4/7 = 5.714… → 6
    expect(scaleScoreOutOf10(4, 7)).toBe(6);
    // 3/7 = 4.285… → 4
    expect(scaleScoreOutOf10(3, 7)).toBe(4);
  });

  it("clamps to [0, 10]", () => {
    expect(scaleScoreOutOf10(0, 7)).toBe(0);
    expect(scaleScoreOutOf10(7, 7)).toBe(10);
    // Defence-in-depth: even if a buggy parser returns passed > total,
    // the UI never sees a number > 10.
    expect(scaleScoreOutOf10(99, 7)).toBe(10);
    // Negative inputs shouldn't reach here, but a clamp is cheap.
    expect(scaleScoreOutOf10(-3, 7)).toBe(0);
  });

  it("returns 0 for empty / unparseable walks", () => {
    expect(scaleScoreOutOf10(0, 0)).toBe(0);
    expect(scaleScoreOutOf10(3, 0)).toBe(0);
    expect(scaleScoreOutOf10(0, -1)).toBe(0);
  });

  it("matches the UI's scoreOutOf10 (drift guard)", () => {
    // Mirror of ProgressNode.tsx scoreOutOf10 — if you change one of
    // these, change the other, and this assertion is what reminds you.
    const uiMirror = (passed: number, total: number): number => {
      if (total <= 0) return 0;
      return Math.max(0, Math.min(10, Math.round((passed * 10) / total)));
    };
    for (let p = 0; p <= 10; p++) {
      for (let t = 1; t <= 10; t++) {
        expect(scaleScoreOutOf10(p, t)).toBe(uiMirror(p, t));
      }
    }
  });
});

describe("SCRIPT_LOOP_MIN_SCORE_OUT_OF_10 (threshold default)", () => {
  it("defaults to 7/10 (≈ B grade, F1+F2+F3 plus one more)", () => {
    // Env may override in CI; just assert the override landed in range.
    expect(SCRIPT_LOOP_MIN_SCORE_OUT_OF_10).toBeGreaterThanOrEqual(0);
    expect(SCRIPT_LOOP_MIN_SCORE_OUT_OF_10).toBeLessThanOrEqual(10);
    // Pin the default behaviour unless explicitly overridden.
    if (!process.env.LOOP_SCRIPT_MIN_SCORE) {
      expect(SCRIPT_LOOP_MIN_SCORE_OUT_OF_10).toBe(7);
    }
  });

  it("the threshold decision matches the autonomous branch in orchestrator", () => {
    // Score-driven branch (orchestrator.ts ~line 1795):
    //   if (scaledScore >= SCRIPT_LOOP_MIN_SCORE_OUT_OF_10) emit('done')
    //   else                                             auto-iterate
    // This pins the exact boundary that the live progress UI shows.
    const cases: Array<[number, number, "done" | "iterate"]> = [
      [0, 7, "iterate"],
      [3, 7, "iterate"],
      [4, 7, "iterate"], // 4/7 → 6/10, below 7
      [5, 7, "done"], // 5/7 → 7/10, exactly at threshold
      [6, 7, "done"],
      [7, 7, "done"],
    ];
    for (const [passed, total, expected] of cases) {
      const scaled = scaleScoreOutOf10(passed, total);
      const action = scaled >= SCRIPT_LOOP_MIN_SCORE_OUT_OF_10 ? "done" : "iterate";
      expect(action).toBe(expected);
    }
  });
});

describe("applyNodeTagFallback (per-node score split)", () => {
  it("applies F1–F2 → planner, F3–F7 → maker when no explicit tag is present", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "F1 — Hook leads with outcome", passed: true, evidence: "ok" },
      { criterion: "F2 — Save-worthy takeaway", passed: true, evidence: "ok" },
      { criterion: "F3 — Tool reveal delayed", passed: true, evidence: "ok" },
      { criterion: "F4 — Concrete specificity", passed: false, evidence: "no" },
      { criterion: "F5 — No throat-clearing", passed: true, evidence: "ok" },
      { criterion: "F6 — Pace/length fit", passed: true, evidence: "ok" },
      { criterion: "F7 — Save cue present", passed: true, evidence: "ok" },
    ];
    const out = applyNodeTagFallback(walk);
    expect(out.filter((c) => c.nodeId === "planner").length).toBe(2);
    expect(out.filter((c) => c.nodeId === "maker").length).toBe(5);
  });

  it("trusts explicit [planner] / [maker] / [verifier] tags verbatim", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "F1 — Hook", passed: true, evidence: "x", nodeId: "maker" }, // override
      { criterion: "F2 — Takeaway", passed: true, evidence: "x" },
      { criterion: "[verifier] Format matches", passed: true, evidence: "x", nodeId: "verifier" },
    ];
    const out = applyNodeTagFallback(walk);
    expect(out[0].nodeId).toBe("maker"); // explicit tag wins
    // No fallback for the rest when ANY is tagged — caller is expected to
    // have parsed tag from the criterion text. The fallback only kicks in
    // when nothing is tagged.
    expect(out[1].nodeId).toBeUndefined();
    expect(out[2].nodeId).toBe("verifier");
  });

  it("falls back to 'verifier' for criteria with no F-prefix and no explicit tag", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "lint passes", passed: true, evidence: "ok" },
      { criterion: "tests pass", passed: true, evidence: "ok" },
    ];
    const out = applyNodeTagFallback(walk);
    expect(out[0].nodeId).toBe("verifier");
    expect(out[1].nodeId).toBe("verifier");
  });

  it("is pure (does not mutate the input array)", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "F1 — Hook", passed: true, evidence: "x" },
    ];
    const out = applyNodeTagFallback(walk);
    expect(walk[0].nodeId).toBeUndefined();
    expect(out[0].nodeId).toBe("planner");
  });
});

describe("groupCriteriaByNode", () => {
  it("returns passed/total counts per nodeId, omitting nodes with zero criteria", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "F1", passed: true, evidence: "x", nodeId: "planner" },
      { criterion: "F2", passed: true, evidence: "x", nodeId: "planner" },
      { criterion: "F3", passed: true, evidence: "x", nodeId: "maker" },
      { criterion: "F4", passed: false, evidence: "x", nodeId: "maker" },
    ];
    const groups = groupCriteriaByNode(walk);
    expect(groups.planner).toEqual({ passed: 2, total: 2 });
    expect(groups.maker).toEqual({ passed: 1, total: 2 });
    expect(groups.verifier).toBeUndefined();
  });

  it("routes untagged criteria to 'verifier'", () => {
    const walk: CriteriaWalkItem[] = [
      { criterion: "lint", passed: true, evidence: "x" },
    ];
    const groups = groupCriteriaByNode(walk);
    expect(groups.verifier).toEqual({ passed: 1, total: 1 });
  });
});

describe("per-node score split (end-to-end through the parser)", () => {
  it("reads [node: planner] tags out of STATE.md", () => {
    const md = [
      "## Verifier Verdict — Attempt 1",
      "",
      "**Verdict:** APPROVE",
      "",
      "**Criteria walk:**",
      "- [x] [node: planner] F1 — Hook leads with outcome — opens with payoff",
      "- [x] [node: planner] F2 — Save-worthy takeaway — has a reusable list",
      "- [ ] [node: maker] F3 — Tool reveal delayed — too early",
      "- [x] [node: maker] F4 — Concrete specificity — names a tool",
    ].join("\n");
    const { verdict } = parseStateDiff(md);
    expect(verdict).not.toBeNull();
    const walk = applyNodeTagFallback(verdict!.criteriaWalk);
    const groups = groupCriteriaByNode(walk);
    expect(groups.planner).toEqual({ passed: 2, total: 2 });
    expect(groups.maker).toEqual({ passed: 1, total: 2 });
    // Each per-node score:
    expect(scaleScoreOutOf10(groups.planner.passed, groups.planner.total)).toBe(10);
    expect(scaleScoreOutOf10(groups.maker.passed, groups.maker.total)).toBe(5);
  });

  it("falls back to F1–F2 / F3–F7 when no tags are present", () => {
    const md = [
      "## Verifier Verdict — Attempt 1",
      "",
      "**Verdict:** APPROVE",
      "",
      "**Criteria walk:**",
      "- [x] F1 — Hook",
      "- [x] F2 — Takeaway",
      "- [x] F3 — Tool",
      "- [x] F4 — Specifics",
      "- [x] F5 — No throat-clearing",
      "- [x] F6 — Pace",
      "- [x] F7 — Save cue",
    ].join("\n");
    const { verdict } = parseStateDiff(md);
    const walk = applyNodeTagFallback(verdict!.criteriaWalk);
    const groups = groupCriteriaByNode(walk);
    expect(groups.planner).toEqual({ passed: 2, total: 2 });
    expect(groups.maker).toEqual({ passed: 5, total: 5 });
  });
});
