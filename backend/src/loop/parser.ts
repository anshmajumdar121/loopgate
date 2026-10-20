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
  type Section = {
    heading: string;
    attempt: number | null;
    lines: string[];
    level: number;
  };
  const lines = markdown.split(/\r?\n/);
  let last: Section | null = null;
  let current: Section | null = null;

  for (const raw of lines) {
    const headingMatch = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // Deeper subheadings are CONTENT of the current section, not
      // terminators — real verifier output sometimes writes fields as
      // `### Criteria walk:` / `### Verdict:` headings instead of
      // `**Field:**` lines, and closing the section there dropped the
      // entire verdict body ("0/0 criteria pass").
      if (current && level > current.level) {
        current.lines.push(raw);
        continue;
      }
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
          level,
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

/**
 * Normalise heading-style field lines (`### Criteria walk:`, `#### Verdict`)
 * inside a section body to the canonical `**Label:**` form, so every reader
 * below (readField / readFieldBullets / parseCriteriaWalk) sees one format.
 * Heading-style fields usually carry their value on the next line, which
 * readField handles with a look-ahead.
 */
function normaliseFieldLines(lines: string[]): string[] {
  return lines.map((line) => {
    const m = line.match(/^\s*#{2,6}\s+(.+?):?\s*$/);
    return m ? `**${m[1]}:**` : line;
  });
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
    `^\\s*\\*\\*${escapeRegex(label)}:?\\*\\*:?\\s*(.*?)\\s*$`,
    "i"
  );
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    if (m[1]) return m[1];
    // Empty value on the field line itself — heading-style fields
    // (`### Verdict:` normalised to `**Verdict:**`) put the value on the
    // next line. Take the first non-empty line that isn't a new field
    // header, heading, or bullet list.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) continue;
      if (/^\*\*[^*]+:?\*\*:?/.test(next)) break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^[-*]\s+/.test(next)) break;
      return next;
    }
    return null;
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

/** Exit-code variant of firstInt: `null` instead of NaN when the line has
 *  no integer (e.g. "n/a — static files, no build step"). NaN leaks into
 *  logs/history as the literal string "NaN" ("build exit NaN"); null lets
 *  display sites render "n/a". */
function firstIntOrNull(s: string): number | null {
  const n = firstInt(s);
  return Number.isFinite(n) ? n : null;
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
/** Extracts `NN` from a `Score` field value shaped like `NN/100`. */
const SCORE_LINE_RE = /(\d{1,3})\s*\/\s*100/i;

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
  const raw = readField(normaliseFieldLines(section.lines), "Verdict");
  if (!raw) return null;
  return matchOutcome(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: diff + verdict section parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `## Diff Summary — Attempt N` block. Maker writes this format per
 * `.opencode/agents/loop-maker.md`.
 */
function parseDiffSection(rawLines: string[], attempt: number): DiffSummary {
  const lines = normaliseFieldLines(rawLines);
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
    buildExit: firstIntOrNull(buildLine),
    testsPassed: Number.isFinite(testsPassed) ? testsPassed : 0,
    testsFailed: Number.isFinite(testsFailed) ? testsFailed : 0,
    testsLintExit: firstIntOrNull(lintLine),
    notes: notesBullets.join("\n"),
  };
}

/**
 * Parse a `## Verifier Verdict — Attempt N` block. Verifier writes this format
 * per `.opencode/agents/loop-verifier.md`.
 */
function parseVerdictSection(rawLines: string[], attempt: number): Verdict {
  const lines = normaliseFieldLines(rawLines);
  const verdictRaw = readField(lines, "Verdict") ?? "";
  let outcome = normaliseOutcome(verdictRaw);

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
  const criteriaPassed = criteriaWalk.filter((c) => c.passed).length;

  const scoreLine = readField(lines, "Score") ?? "";
  const scoreMatch = scoreLine.match(SCORE_LINE_RE);
  const score = scoreMatch
    ? Math.min(100, Number(scoreMatch[1]))
    : criteriaWalk.length > 0
    ? ratioToScore(criteriaPassed, criteriaWalk.length)
    : undefined;

  // Approval gate: an APPROVE that contradicts the verifier's own checklist
  // is not an approval. Only explicit failures count (a missing line is not
  // a FAIL), so terse-but-honest verdicts still pass.
  const buildExit = firstIntOrNull(buildLine);
  const failedCount = Number.isFinite(testsFailed) ? testsFailed : 0;
  const gateFailures: string[] = [];
  if (/^FAIL/i.test(scopeLine.trim())) gateFailures.push("Scope: FAIL");
  if (/^FAIL/i.test(intentLine.trim())) gateFailures.push("Intent: FAIL");
  if (/^FAIL/i.test(noCheatingLine.trim())) gateFailures.push("No cheating: FAIL");
  if (/^HIGH/i.test(riskLine.trim())) gateFailures.push("Risk: HIGH");
  if (buildExit !== null && buildExit !== 0) gateFailures.push(`Build exit ${buildExit}`);
  if (failedCount > 0) gateFailures.push(`${failedCount} test(s) failed`);
  const failedCriteria = criteriaWalk.filter((c) => !c.passed);
  if (failedCriteria.length > 0) gateFailures.push(`${failedCriteria.length} criteria unchecked`);
  if (outcome === "APPROVE" && gateFailures.length > 0) {
    outcome = "REJECT";
    requiredFixes.unshift(`Approval gate blocked APPROVE: ${gateFailures.join(", ")}`);
  }

  return {
    attempt,
    outcome,
    buildExit,
    testsPassed: Number.isFinite(testsPassed) ? testsPassed : 0,
    testsFailed: failedCount,
    scopePass: scopeLine.toUpperCase().startsWith("PASS"),
    intentPass: intentLine.toUpperCase().startsWith("PASS"),
    noCheatingPass: noCheatingLine.toUpperCase().startsWith("PASS"),
    risk: normaliseRisk(riskLine),
    criteriaWalk,
    requiredFixes,
    // One-line reason: REJECT → first required fix; otherwise summarise from
    // the criteria walk (count of passed vs failed). An empty walk must not
    // surface as the misleading "0/0 criteria pass" — fall back to the first
    // required fix or an explicit unparseable marker.
    oneLineReason:
      outcome === "REJECT" && requiredFixes.length > 0
        ? requiredFixes[0]
        : criteriaWalk.length > 0
        ? `${criteriaPassed}/${criteriaWalk.length} criteria pass`
        : requiredFixes[0] ?? "criteria walk missing or unparseable",
    score,
  };
}

/** Round a passed/total ratio to a 0-100 score. */
function ratioToScore(passed: number, total: number): number {
  return Math.round((100 * passed) / total);
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
    // Checkbox form (`- [x] …` / `- [ ] …`) or tick/cross form
    // (`- ✓ …` / `- ✗ …`) — verifiers on some models emit the latter.
    let passed: boolean;
    let restRaw: string;
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    const t = m ? null : line.match(/^\s*[-*]\s+([✓✔✅✗✘❌])\s+(.+?)\s*$/);
    if (m) {
      passed = m[1].toLowerCase() === "x";
      restRaw = m[2];
    } else if (t) {
      passed = /[✓✔✅]/.test(t[1]);
      restRaw = t[2];
    } else {
      continue;
    }
    {
      const rest = restRaw.trim();
      // Strip leading "FAILED: " prefix on failed items
      const cleaned = rest.replace(/^FAILED:\s*/i, "");
      // Split criterion — evidence at the first " — " or " - "
      const split = cleaned.match(/^(.+?)\s+[—-]\s+(.+)$/);
      // Pull off an optional `[node: planner]` / `[planner]` / `[maker]` /
      // `[verifier]` tag at the start of the criterion text. The verifier
      // can emit this explicitly so per-node scoring doesn't depend on
      // the F1–F7 fallback below.
      const { text: criterionText, nodeId } = stripNodeTag(
        split ? split[1].trim() : cleaned
      );
      if (split) {
        out.push({
          criterion: criterionText,
          passed,
          evidence: split[2].trim(),
          ...(nodeId ? { nodeId } : {}),
        });
      } else {
        out.push({
          criterion: criterionText,
          passed,
          evidence: "",
          ...(nodeId ? { nodeId } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Pull an optional `[node: planner]` / `[planner]` / `[maker]` / `[verifier]`
 * tag off the front of a criterion string. Returns the cleaned text and the
 * nodeId (or undefined). The tag is case-insensitive; trailing punctuation
 * is tolerated. Anything else is left untouched — we never strip text that
 * happens to be in brackets, so verifier prose survives.
 */
function stripNodeTag(text: string): { text: string; nodeId?: string } {
  // Match a leading bracketed tag like `[planner]` or `[node: planner]`.
  // Allows for nested spaces and a trailing colon.
  const m = text.match(
    /^\s*\[\s*(?:node\s*:\s*)?(planner|maker|verifier)\s*\]\s*:?\s*/i
  );
  if (m) return { text: text.slice(m[0].length).trim(), nodeId: m[1].toLowerCase() };
  return { text };
}

/**
 * Match a verdict outcome inside free-form text. Tolerates markdown
 * decoration (`**REJECT**`), trailing prose (`REJECT — tests failing`),
 * and tense variants (APPROVED / REJECTED). ESCALATE is checked first so
 * "escalate to human, do not approve" never reads as APPROVE.
 */
function matchOutcome(raw: string): VerdictOutcome | null {
  // Strict: only the LEADING keyword decides. A previous version scanned the
  // whole line and checked APPROVE first, so "REJECT — cannot approve" and
  // "NOT APPROVED" both parsed as APPROVE. Approval must never be inferred
  // from prose; anything that doesn't lead with a keyword fails closed.
  const upper = raw.toUpperCase().replace(/[*_`~>#]/g, " ").trim();
  // The verifier echoing the template ("APPROVE | REJECT | ESCALATE_HUMAN")
  // is not a decision.
  if (/APPROVE\s*\|\s*REJECT/.test(upper)) return null;
  const lead = upper.match(/^[^A-Z]*([A-Z_]+)/)?.[1] ?? "";
  if (/^ESCALATE/.test(lead)) return "ESCALATE_HUMAN";
  if (/^REJECT(?:ED)?$/.test(lead)) return "REJECT";
  if (/^APPROVED?$/.test(lead)) {
    // "APPROVE ... but REJECT/escalate" is contradictory → not an approval.
    const rest = upper.slice(upper.indexOf(lead) + lead.length);
    if (/\bREJECT|\bESCALATE/.test(rest)) return "REJECT";
    return "APPROVE";
  }
  // No leading keyword: an escalation mention still escalates (safe side);
  // everything else is REJECT-ish or unknown, never APPROVE.
  if (/\bESCALATE/.test(upper)) return "ESCALATE_HUMAN";
  if (/\bREJECT|\bAPPROVE/.test(upper)) return "REJECT";
  return null;
}

function normaliseOutcome(raw: string): VerdictOutcome {
  // Default to REJECT — verifier default is "reject until proven otherwise".
  return matchOutcome(raw) ?? "REJECT";
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