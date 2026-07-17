import { describe, it, expect } from "vitest";
import { parseStateDiff } from "../parser.js";

const V = (extra: string) => `## Verifier Verdict — Attempt 1
**Verdict:** APPROVE
**Criteria walk:**
- [x] a — ok
- [x] b — ok
- [ ] c — nope
${extra}`;

describe("verdict score", () => {
  it("parses explicit Score line", () => {
    const { verdict } = parseStateDiff(V("**Score:** 85/100"));
    expect(verdict?.score).toBe(85);
  });
  it("falls back to criteria ratio", () => {
    const { verdict } = parseStateDiff(V(""));
    expect(verdict?.score).toBe(67); // 2/3 → 67
  });
});
