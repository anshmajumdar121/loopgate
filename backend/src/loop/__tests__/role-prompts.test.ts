import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSystemPromptForRole, CANONICAL_ROLE_PROMPTS } from "../role-prompts.js";

describe("role prompts", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "role-prompts-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("canonical prompts carry the parser's output-format contracts", () => {
    // These strings are what parser.ts anchors on. If a canonical prompt
    // loses its format contract, the model improvises a layout the parser
    // reads as 0 files / 0 tests / 0 criteria (live escalation, task
    // VAYJbNr8djTj).
    expect(CANONICAL_ROLE_PROMPTS.maker).toContain("## Diff Summary — Attempt N");
    expect(CANONICAL_ROLE_PROMPTS.maker).toContain("**Files changed**");
    expect(CANONICAL_ROLE_PROMPTS.maker).toContain("passed");
    expect(CANONICAL_ROLE_PROMPTS.planner).toContain("Completion Criteria");
    expect(CANONICAL_ROLE_PROMPTS.planner).toContain("Files to touch");
    expect(CANONICAL_ROLE_PROMPTS.verifier).toContain("## Verifier Verdict — Attempt N");
    expect(CANONICAL_ROLE_PROMPTS.verifier).toContain("**Verdict:**");
  });

  it("falls back to the canonical prompt when the workdir has no agent file", () => {
    expect(loadSystemPromptForRole("maker", workdir)).toBe(CANONICAL_ROLE_PROMPTS.maker);
    expect(loadSystemPromptForRole("planner", workdir)).toBe(CANONICAL_ROLE_PROMPTS.planner);
    expect(loadSystemPromptForRole("verifier", workdir)).toBe(CANONICAL_ROLE_PROMPTS.verifier);
  });

  it("prefers a workdir-local agent definition when present", () => {
    const agentsDir = join(workdir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "loop-maker.md"), "custom maker prompt", "utf8");
    expect(loadSystemPromptForRole("maker", workdir)).toBe("custom maker prompt");
    // Other roles still fall back.
    expect(loadSystemPromptForRole("planner", workdir)).toBe(CANONICAL_ROLE_PROMPTS.planner);
  });
});
