// Markdown parsers for GOAL.md and STATE.md.
//
// The agent prompts produce deterministic markdown structures, so we parse
// them with simple heading-aware line scans rather than a full AST parser.
//
// GOAL.md shape (filled by loop-planner):
//
//   # Current Goal
//   ...
//   ## Task            <— free text
//   ## Completion Criteria    - [ ] ...   (checkboxes)
//   ## Implementation Plan    1. ... 2. ...  (numbered list)
//   ## Files to touch         - path
//   ## Files NOT to touch (denylist)
//   ## Notes for the maker    free text
//   ## Risks                  - risk (optional)
//
// STATE.md shape (filled incrementally by orchestrator + maker + verifier):
//
//   ## Attempt: N / M
//   ## Diff Summary — Attempt N
//      **Files changed** (N):
//      - path — reason
//      **Build:** ... → exit 0
//      **Tests:** ... → 14 passed, 0 failed
//      **Lint:** ... → exit 0
//      **Notes for verifier:**
//      - note
//   ## Verifier Verdict — Attempt N
//      **Verdict:** APPROVE | REJECT | ESCALATE_HUMAN
//      **Build:** 0 — <summary>
//      **Tests:** 0 — 14 passed, 0 failed
//      **Scope:** PASS | FAIL — <details>
//      ...
//      **Criteria walk:**
//      - [x] criterion — evidence
//      - [ ] criterion — FAILED: reason
//      **Required fixes** (if REJECT):
//      - fix

import type {
  PlanSummary,
  DiffSummary,
  DiffFileChange,
  Verdict,
  VerdictOutcome,
  CriteriaWalkItem,
} from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Section splitting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a markdown document by `## ` (or `#` / `###`) headings and return a map
 * keyed by the trimmed heading text. The content under each heading is the
 * trimmed list of lines up to (but not including) the next heading.
 *
 * Heading detection is line-anchored: a heading must start at column 0 with
 * one or more `#` characters followed by a space. Headings nested under a
 * parent (e.g. `### Sub`) are kept as their own top-level keys.
 */
function splitByHeadings(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = markdown.split(/\r?\n/);
  let current: string | null = null;

  for (const raw of lines) {
    const headingMatch = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      current = headingMatch[2].trim();
      if (!result.has(current)) {
        result.set(current, []);
      }
      continue;
    }
    if (current !== null) {
      result.get(current)!.push(raw);
    }
  }
  return result;
}

/**
 * Find the LAST occurrence of a section whose heading matches `regex`. Returns
 * the inner lines and the captured group (e.g. attempt number).
 *
 * Why "last": STATE.md accumulates sections across attempts (`## Diff Summary
 * — Attempt 1`, `## Verifier Verdict — Attempt 1`, then `— Attempt 2`, etc.).
 * The orchestrator always wants the most recent one.
 */
function findSection(
  markdown: string,
  regex: RegExp
): { heading: string; attempt: number | null; lines: string[] } | null {
  const lines = markdown.split(/\r?\n/);
  let last: { heading: string; attempt: number | null; lines: string[] } | null = null;
  let current: { heading: string; attempt: number | null; lines: string[] } | null = null;

  for (const raw of lines) {
    const headingMatch = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      // Close out the previous section
      if (current) last = current;
      const heading = headingMatch[2].trim();
      const m = heading.match(regex);
      if (m) {
        const attemptStr = m[1];
        current = {
          heading,
          attempt: attemptStr ? Number(attemptStr) : null,
          lines: [],
        };
      } else {
        current = null;
      }
      continue;
    }
    if (current) current.lines.push(raw);
  }
  if (current) last = current;
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bullet / checkbox / numbered extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract bullet items from lines. Recognises both `- item` and `* item`. Empty
 * items are skipped. Leading whitespace is trimmed.
 */
function extractBullets(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (m) {
      const text = m[1].trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Extract checkbox items: `- [ ] criterion` or `- [x] criterion`. Strips the
 * `- [ ] ` / `- [x] ` prefix and returns just the criterion text.
 */
function extractCheckboxes(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/);
    if (m) {
      const text = m[1].trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Count numbered items in a "Implementation Plan" section: `1. ...`, `2. ...`,
 * `10. ...`. Multi-digit numbers are supported. Sub-bullets (indented) are
 * skipped — we only count top-level numbered steps.
 */
function countNumberedItems(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (/^\s*\d+\.\s+/.test(line)) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Field-line parsing (for STATE.md **Field:** value)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the first occurrence of `**Label:** value` and return the value (after
 * the colon, trimmed). Case-insensitive on the label. Returns `null` if not
 * found. Only matches a single line — multi-line values fall through to the
 * section's body.
 *
 * Convention: the label's closing `**` may or may not be preceded by a colon.
 * We allow `**Label:**` (colon inside, what the verifier prompts produce) and
 * `**Label**:` (colon outside, alternative style). The value can also start
 * with extra colon + whitespace.
 */
function readField(lines: string[], label: string): string | null {
  const re = new RegExp(
    `^\\s*\\*\\*${escapeRegex(label)}:?\\*\\*:?\\s*(.+?)\\s*$`,
    "i"
  );
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Collect bullet items under a `**Label:**` header (skips the header line). */
function readFieldBullets(lines: string[], label: string): string[] {
  const headerRe = new RegExp(
    `^\\s*\\*\\*${escapeRegex(label)}:?\\*\\*:?\\s*(.*)$`,
    "i"
  );
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!inSection) {
      if (headerRe.test(line)) {
        inSection = true;
      }
      continue;
    }
    // Stop on next `**...:**` (or `**...**:`) header or a new heading
    if (/^\s*\*\*[^*]+:?\*\*:?/.test(line)) break;
    if (/^\s*#{1,6}\s+/.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the first integer from a string. Returns NaN if none found. */
function firstInt(s: string): number {
  const m = s.match(/-?\d+/);
  return m ? Number(m[0]) : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: parsePlanGoal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the planner's GOAL.md into a typed PlanSummary. The structure is
 * driven by `.opencode/agents/loop-planner.md`, which mandates these headings:
 *
 *   ## Completion Criteria    - [ ] criterion
 *   ## Implementation Plan    1. step, 2. step, ...
 *   ## Files to touch         - path
 *   ## Notes for the maker    free text
 *
 * `## Risks` is optional — planner adds it only if there are real risks.
 */
export function parsePlanGoal(markdown: string): PlanSummary {
  const sections = splitByHeadings(markdown);

  const criteria = extractCheckboxes(sections.get("Completion Criteria") ?? []);
  const steps = countNumberedItems(sections.get("Implementation Plan") ?? []);
  const filesToTouch = extractBullets(sections.get("Files to touch") ?? []);
  const risks = extractBullets(sections.get("Risks") ?? []);
  const notesLines = sections.get("Notes for the maker") ?? [];
  // Trim leading/trailing blank lines from the notes body
  const notes = notesLines.join("\n").replace(/^\s+|\s+$/g, "");

  return {
    steps,
    filesToTouch,
    criteria,
    risks,
    notes,
    rawGoal: markdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API: parseStateDiff
// ─────────────────────────────────────────────────────────────────────────────

const DIFF_HEADING_RE = /Diff Summary\s*[—-]\s*Attempt\s+(\d+)/i;
const VERDICT_HEADING_RE = /Verifier Verdict\s*[—-]\s*Attempt\s+(\d+)/i;
const ATTEMPT_HEADER_RE = /Attempt\s*:\s*(\d+)\s*\/\s*\d+/i;

/**
 * Parse STATE.md into the latest diff + verdict blocks. Either may be null if
 * the section is missing (e.g. before the maker has run, the diff section is
 * absent; before the verifier has run, the verdict section is absent).
 *
 * The `attempt` field reflects the latest attempt number found across both
 * sections (or from `## Attempt: N / M` if both sections are missing).
 */
export function parseStateDiff(markdown: string): {
  attempt: number;
  diff: DiffSummary | null;
  verdict: Verdict | null;
} {
  let attempt = 0;
  const headerMatch = markdown.match(ATTEMPT_HEADER_RE);
  if (headerMatch) attempt = Number(headerMatch[1]);

  const diffSection = findSection(markdown, DIFF_HEADING_RE);
  const verdictSection = findSection(markdown, VERDICT_HEADING_RE);

  const diff = diffSection ? parseDiffSection(diffSection.lines, diffSection.attempt ?? attempt) : null;
  const verdict = verdictSection
    ? parseVerdictSection(verdictSection.lines, verdictSection.attempt ?? attempt)
    : null;

  // Promote attempt from whichever section is present, taking the max so we
  // don't downgrade when sections disagree (e.g. diff attempt 2, verdict attempt 1).
  if (diff) attempt = Math.max(attempt, diff.attempt);
  if (verdict) attempt = Math.max(attempt, verdict.attempt);

  return { attempt, diff, verdict };
}

/**
 * Read just the `## Attempt: N / M` header. Returns 0 if not found.
 */
export function parseAttemptNumber(markdown: string): number {
  const m = markdown.match(ATTEMPT_HEADER_RE);
  return m ? Number(m[1]) : 0;
}

/**
 * Read just the latest verdict outcome from STATE.md. Returns null if no
 * verdict section exists or the outcome field is missing.
 */
export function parseVerdictOutcome(markdown: string): VerdictOutcome | null {
  const section = findSection(markdown, VERDICT_HEADING_RE);
  if (!section) return null;
  const raw = readField(section.lines, "Verdict");
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper === "APPROVE" || upper === "REJECT" || upper === "ESCALATE_HUMAN") {
    return upper as VerdictOutcome;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: diff + verdict section parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `## Diff Summary — Attempt N` block. Maker writes this format per
 * `.opencode/agents/loop-maker.md`.
 */
function parseDiffSection(lines: string[], attempt: number): DiffSummary {
  // Files changed — capture path + reason. Format: `- path — reason`.
  const filesChanged: DiffFileChange[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(\S+)\s*[—-]\s*(.+?)\s*$/);
    if (m) {
      filesChanged.push({ path: m[1].trim(), reason: m[2].trim() });
    }
  }

  // Build / Tests / Lint — first integer in the value is the exit code.
  const buildLine = readField(lines, "Build") ?? "";
  const testsLine = readField(lines, "Tests") ?? "";
  const lintLine = readField(lines, "Lint") ?? "";
  const testsPassed = firstInt(testsLine.replace(/.*?(\d+)\s*passed.*/i, "$1"));
  const testsFailed = firstInt(testsLine.replace(/.*?(\d+)\s*failed.*/i, "$1"));

  // Notes for verifier — bullet list under **Notes for verifier:**
  const notesBullets = readFieldBullets(lines, "Notes for verifier");

  return {
    attempt,
    filesChanged,
    buildExit: firstInt(buildLine),
    testsPassed: Number.isFinite(testsPassed) ? testsPassed : 0,
    testsFailed: Number.isFinite(testsFailed) ? testsFailed : 0,
    testsLintExit: firstInt(lintLine),
    notes: notesBullets.join("\n"),
  };
}

/**
 * Parse a `## Verifier Verdict — Attempt N` block. Verifier writes this format
 * per `.opencode/agents/loop-verifier.md`.
 */
function parseVerdictSection(lines: string[], attempt: number): Verdict {
  const verdictRaw = readField(lines, "Verdict") ?? "";
  const outcome = normaliseOutcome(verdictRaw);

  const buildLine = readField(lines, "Build") ?? "";
  const testsLine = readField(lines, "Tests") ?? "";

  const testsPassed = firstInt(testsLine.replace(/.*?(\d+)\s*passed.*/i, "$1"));
  const testsFailed = firstInt(testsLine.replace(/.*?(\d+)\s*failed.*/i, "$1"));

  const scopeLine = readField(lines, "Scope") ?? "";
  const intentLine = readField(lines, "Intent") ?? "";
  const noCheatingLine = readField(lines, "No cheating") ?? "";
  const riskLine = readField(lines, "Risk") ?? "";

  const criteriaWalk = parseCriteriaWalk(lines);
  const requiredFixes = readFieldBullets(lines, "Required fixes");

  return {
    attempt,
    outcome,
    buildExit: firstInt(buildLine),
    testsPassed: Number.isFinite(testsPassed) ? testsPassed : 0,
    testsFailed: Number.isFinite(testsFailed) ? testsFailed : 0,
    scopePass: scopeLine.toUpperCase().startsWith("PASS"),
    intentPass: intentLine.toUpperCase().startsWith("PASS"),
    noCheatingPass: noCheatingLine.toUpperCase().startsWith("PASS"),
    risk: normaliseRisk(riskLine),
    criteriaWalk,
    requiredFixes,
    // One-line reason: REJECT → first required fix; otherwise summarise from
    // the criteria walk (count of passed vs failed).
    oneLineReason:
      outcome === "REJECT" && requiredFixes.length > 0
        ? requiredFixes[0]
        : `${criteriaWalk.filter((c) => c.passed).length}/${criteriaWalk.length} criteria pass`,
  };
}

/** Parse the criteria walk bullet list under `**Criteria walk:**`. */
function parseCriteriaWalk(lines: string[]): CriteriaWalkItem[] {
  const headerRe = /^\s*\*\*Criteria walk:\*\*\s*(.*)$/i;
  let inSection = false;
  const out: CriteriaWalkItem[] = [];
  for (const line of lines) {
    if (!inSection) {
      if (headerRe.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (/^\s*\*\*[^*]+:\*\*/.test(line)) break;
    if (/^\s*#{1,6}\s+/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (m) {
      const passed = m[1].toLowerCase() === "x";
      const rest = m[2].trim();
      // Strip leading "FAILED: " prefix on failed items
      const cleaned = rest.replace(/^FAILED:\s*/i, "");
      // Split criterion — evidence at the first " — " or " - "
      const split = cleaned.match(/^(.+?)\s+[—-]\s+(.+)$/);
      if (split) {
        out.push({
          criterion: split[1].trim(),
          passed,
          evidence: split[2].trim(),
        });
      } else {
        out.push({ criterion: cleaned, passed, evidence: "" });
      }
    }
  }
  return out;
}

function normaliseOutcome(raw: string): VerdictOutcome {
  const upper = raw.trim().toUpperCase();
  if (upper === "APPROVE" || upper === "REJECT" || upper === "ESCALATE_HUMAN") {
    return upper as VerdictOutcome;
  }
  // Default to REJECT — verifier default is "reject until proven otherwise".
  return "REJECT";
}

function normaliseRisk(raw: string): "LOW" | "MEDIUM" | "HIGH" {
  // The risk field often has trailing prose ("LOW — minimal scope"). Pull
  // out just the first uppercase token so the type stays normalised.
  const firstToken = raw.trim().toUpperCase().split(/\s+/)[0] ?? "";
  if (firstToken === "LOW" || firstToken === "MEDIUM" || firstToken === "HIGH") {
    return firstToken;
  }
  return "MEDIUM";
}