// Phase 3 of recursive-improve: generate a self-contained GOAL.md
// recipe the user pastes into a new task. The existing loop handles
// plan → implement → verify, the file allowlist in GOAL.md constrains
// the maker to .opencode/agents/**, the verifier's scope check
// catches any out-of-allowlist edits, and the denylist in
// loop-constraints.md keeps auth/payments/etc untouched. No new
// agent, no new orchestrator code path — same loop, different
// target.
//
// ponytail: this is the entire Phase 3 deliverable. The "meta-agent"
// was never a new agent — it was always the existing loop pointed at
// its own prompts. The only missing piece was a way to author the
// GOAL.md without hand-writing it every time. That's this file.

import type { Finding } from "./trace-analysis.js";

/**
 * Build a GOAL.md that targets the top-N findings (default 3). The
 * generated markdown is intentionally tight: a task description, a
 * denylist, a file allowlist, and checkable completion criteria. The
 * planner's job is to turn "fix the top 3 patterns" into a per-file
 * edit plan; the maker's job is to apply it.
 *
 * Cap the N at 5 even if more findings exist — past that the planner
 * can't keep the patches targeted and the prompt files get bloated.
 */
export function buildImproveRecipe(
  findings: Finding[],
  options: { topN?: number; now?: Date } = {}
): string {
  const top = findings.slice(0, options.topN ?? 3).slice(0, 5);
  const now = (options.now ?? new Date()).toISOString().slice(0, 10);

  if (top.length === 0) {
    return `# Recursive Improve — Nothing To Fix (${now})

No repeated rejection patterns detected across the current task set.
Nothing to improve. Wait for more tasks to land and re-run the
analyzer, or look at the insights endpoint for a current snapshot.
`;
  }

  const findingsBlock = top
    .map(
      (f, i) =>
        `### Finding ${i + 1} — "${f.pattern}" (${f.count} tasks)\n` +
        `- Role: ${f.role}\n` +
        `- Suggested fix category: ${f.suggestedFix}\n` +
        `- Example tasks: ${f.examples
          .map((e) => `${e.taskId} (attempt ${e.attempt})`)
          .join(", ")}\n` +
        `- Read the full \`verdict.oneLineReason\` on each example task to see the actual wording — do not invent a problem statement from the bucket key alone.`
    )
    .join("\n\n");

  return `# Recursive Improve — Agent Prompt Patches (${now})

## Task

The Loop Agent has been producing repeated rejection patterns. Analyze
the top ${top.length} finding(s) below and produce a **minimal patch**
to one or more of the agent system prompts in this workdir's
\`<workdir>/.opencode/agents/\` directory:

- \`loop-planner.md\` — system prompt for the planning agent
- \`loop-maker.md\` — system prompt for the implementation agent
- \`loop-verifier.md\` — system prompt for the verification agent

For each finding, decide which role is the actual cause (the
\`role: "${top[0].role}"\` tag is a hint, not a verdict — read the
example task verdicts to confirm). Then propose a **single sentence or
short paragraph** addition to the matching prompt that would have
prevented the rejection. Do not rewrite the whole prompt.

${findingsBlock}

## Completion Criteria

- [ ] Each finding maps to exactly one prompt edit (no edits that don't
      address a finding; no findings left unaddressed)
- [ ] Every changed file is under \`<workdir>/.opencode/agents/\`
- [ ] No single file changes by more than 30% of its current length
- [ ] Each edit is self-contained — no removed instructions, only
      additions or targeted clarifications
- [ ] The patched prompts still parse as valid markdown with the same
      section headings they had before
- [ ] No new dependencies, no new tools, no new agents

## Implementation Plan

1. Read each of the 3 agent prompt files in \`<workdir>/.opencode/agents/\`
2. For each finding, identify the matching role (planner / maker /
   verifier) and locate the closest section in the prompt where a
   clarifying sentence or paragraph would naturally fit
3. Draft the smallest possible edit for each finding — one
   sentence preferred, one short paragraph max
4. Write the edits back to the same files
5. Diff the result: \`git diff <workdir>/.opencode/agents/\` should
   show only the targeted additions

## Files to touch

- \`./.opencode/agents/loop-planner.md\`
- \`./.opencode/agents/loop-maker.md\`
- \`./.opencode/agents/loop-verifier.md\`

## Files NOT to touch (denylist)

Everything outside \`<workdir>/.opencode/agents/\`. In particular:
- \`backend/\`, \`ui/\`, \`loop-rt/\` (orchestrator code)
- \`**/secrets/**\`, \`**/*_key*\`, \`**/*_secret*\`
- \`auth/**\`, \`payments/**\`, \`billing/**\`, \`**/migrations/**\`
- \`package.json\`, \`package-lock.json\`, \`pyproject.toml\`,
  \`go.mod\`, \`Cargo.toml\` (no new dependencies)
- \`.env\`, \`.env.*\`

## Notes for the maker

- One sentence per finding beats a paragraph. If you find yourself
  writing 5+ lines, you're solving the wrong layer — most repeated
  rejections are fixed by 1 clarifying sentence in the right prompt.
- Do NOT touch the planner/maker/verifier code in \`backend/src/loop/\`
  even if the rejection looks like a code bug. Report code bugs in
  the diff summary instead — humans triage those separately.
- The "files changed" report must include the full new content of each
  patched file so the verifier can read what the maker actually wrote
  without re-reading the workdir.
- This task is itself an \`improve-agents\` style task. After approval,
  the patched prompts take effect on the next loop run that spawns
  each role. The user is responsible for restarting the backend if
  the opencode CLI caches prompts across runs.
`;
}
