// Parser hardening tests (2026-07-17). The centrepiece fixture is the real
// STATE.md from the failed score-test-small run: the verifier wrote its
// fields as `###` subheadings (`### Criteria walk:`, `### Verdict:` with the
// value on the next line) instead of `**Field:**` lines, and the old
// findSection treated every heading as a section terminator — the whole
// verdict body was dropped and the UI showed "0/0 criteria pass" + a fake
// "build fail".
import { describe, expect, it } from "vitest";
import {
  parseStateDiff,
  parseVerdictOutcome,
} from "../parser.js";

/** Verbatim (trimmed) copy of the score-test-small STATE.md that produced
 *  the "0/0 criteria pass" false verdict. */
const HEADING_STYLE_STATE = `# Loop State
Task: score-test-small
Started: 2026-07-17T15:56:48.786Z

## Diff Summary — Attempt 1
- Created new file score-test.txt in the workdir with the text "ok".
## Diff Summary — Attempt 1

**Files changed** (2):
- score-test.txt — implemented per plan
- STATE.md — implemented per plan

**Build:** n/a — static files, no build step
**Tests:** automated runtime check runs after this phase
**Lint:** n/a

**New files**: score-test.txt, STATE.md

**Notes for verifier:**
- Static HTML/CSS/JS prototype; entry point index.html
- Implements the acceptance criteria listed in GOAL.md
## Verifier Verdict — Attempt 1
### Criteria walk:
- [x] The file score-test.txt exists in the workdir. — File exists in diff.
- [x] The file score-test.txt contains exactly one line of text. — Diff shows a single line "ok".
- [x] The text in score-test.txt is "ok". — Diff shows exact match.
- [ ] The file score-test.txt is not empty. — FAILED: could not confirm.

### Required fixes:
- FAILED: Runtime errors observed in prototype (console error "Failed to load resource: 404").

### Verdict:
REJECT
`;

const CANONICAL_STATE = `## Attempt: 2 / 3

## Diff Summary — Attempt 2
**Files changed** (1):
- index.html — added retry button

**Build:** exit 0
**Tests:** 14 passed, 0 failed
**Lint:** exit 0

**Notes for verifier:**
- note one

## Verifier Verdict — Attempt 2
**Verdict:** APPROVE
**Build:** 0 — clean
**Tests:** 0 — 14 passed, 0 failed
**Scope:** PASS — only allowed files
**Criteria walk:**
- [x] button renders — seen in screenshot
- [x] retry works — clicked in runtime check
**Required fixes:**
`;

describe("parseStateDiff — heading-style verifier output (real fixture)", () => {
  const { attempt, diff, verdict } = parseStateDiff(HEADING_STYLE_STATE);

  it("finds the verdict section despite ### subheadings", () => {
    expect(verdict).not.toBeNull();
    expect(attempt).toBe(1);
  });

  it("parses the criteria walk under a ### heading", () => {
    expect(verdict!.criteriaWalk).toHaveLength(4);
    expect(verdict!.criteriaWalk.filter((c) => c.passed)).toHaveLength(3);
    expect(verdict!.criteriaWalk[0].criterion).toContain("score-test.txt exists");
  });

  it("reads the verdict value from the line after ### Verdict:", () => {
    expect(verdict!.outcome).toBe("REJECT");
  });

  it("collects required fixes under a ### heading", () => {
    expect(verdict!.requiredFixes).toHaveLength(1);
    expect(verdict!.oneLineReason).toContain("Runtime errors observed");
  });

  it("keeps n/a build as null (not a fake failure)", () => {
    expect(diff!.buildExit).toBeNull();
    expect(verdict!.buildExit).toBeNull();
  });

  it("parseVerdictOutcome also handles heading-style fields", () => {
    expect(parseVerdictOutcome(HEADING_STYLE_STATE)).toBe("REJECT");
  });
});

describe("parseStateDiff — canonical format regression", () => {
  const { attempt, diff, verdict } = parseStateDiff(CANONICAL_STATE);

  it("still parses the bold-field format", () => {
    expect(attempt).toBe(2);
    expect(diff!.filesChanged).toHaveLength(1);
    expect(diff!.buildExit).toBe(0);
    expect(diff!.testsPassed).toBe(14);
    expect(verdict!.outcome).toBe("APPROVE");
    expect(verdict!.criteriaWalk).toHaveLength(2);
    expect(verdict!.oneLineReason).toBe("2/2 criteria pass");
  });
});

describe("verdict outcome variants", () => {
  const stateWith = (verdictLine: string) => `## Verifier Verdict — Attempt 1
**Verdict:** ${verdictLine}
**Criteria walk:**
- [x] a — b
`;

  it("accepts decorated and tense variants", () => {
    expect(parseStateDiff(stateWith("**APPROVED**")).verdict!.outcome).toBe("APPROVE");
    expect(parseStateDiff(stateWith("Rejected — tests failing")).verdict!.outcome).toBe("REJECT");
    expect(parseStateDiff(stateWith("ESCALATE HUMAN")).verdict!.outcome).toBe("ESCALATE_HUMAN");
  });

  it("never reads an escalation as approval", () => {
    expect(
      parseStateDiff(stateWith("escalate_human — do not approve")).verdict!.outcome
    ).toBe("ESCALATE_HUMAN");
  });

  it("defaults unknown text to REJECT", () => {
    expect(parseStateDiff(stateWith("UNCLEAR")).verdict!.outcome).toBe("REJECT");
  });
});

describe("criteria walk tick/cross bullets", () => {
  it("parses ✓/✗ bullets as pass/fail", () => {
    const state = `## Verifier Verdict — Attempt 1
**Verdict:** REJECT
**Criteria walk:**
- ✓ header renders — visible in screenshot
- ✗ retry works — FAILED: button throws
`;
    const { verdict } = parseStateDiff(state);
    expect(verdict!.criteriaWalk).toHaveLength(2);
    expect(verdict!.criteriaWalk[0].passed).toBe(true);
    expect(verdict!.criteriaWalk[1].passed).toBe(false);
    expect(verdict!.criteriaWalk[1].criterion).toBe("retry works");
  });
});

describe("empty criteria walk reason", () => {
  it("does not report the misleading 0/0 criteria pass", () => {
    const state = `## Verifier Verdict — Attempt 1
**Verdict:** APPROVE
`;
    const { verdict } = parseStateDiff(state);
    expect(verdict!.oneLineReason).not.toContain("0/0");
    expect(verdict!.oneLineReason).toContain("criteria walk missing");
  });
});
