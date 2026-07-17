// Pattern detector for recursive-improve. Reads in-memory task verdicts
// plus on-disk trace records, surfaces failure patterns the meta-agent
// (Phase 3) can target with prompt patches.
//
// ponytail: 5 detectors ship. Each maps to a 1:1 fix category the meta-
// agent can target. The trade-off: pure in-memory scanners (criteria-
// miss, validation-regression, stall-cluster, no-op-attempts) are
// cheap; token-blow-up reads `.loop/traces/` files. If a future
// detector needs heavier IO, put it behind its own lazy function and
// call it from analyzePatterns() — don't bake it into the hot path.

import { listTasks } from "../store/tasks.js";
import { readTracesForTask } from "../store/traces.js";
import type { Task, Verdict } from "../types.js";

export type FindingKind =
  | "repeated-reject"
  | "criteria-miss"
  | "validation-regression"
  | "stall-cluster"
  | "no-op-attempts"
  | "token-blow-up";
export type SuggestedFix = "prompt" | "code" | "discard";

export interface Finding {
  kind: FindingKind;
  /** Human-readable pattern or criterion text. Used by the recipe builder
   *  and the UI as the card's primary label. */
  pattern: string;
  /** Number of distinct tasks whose state matched this pattern. */
  count: number;
  /** Task ids (and the matching attempt number) that contributed. */
  examples: { taskId: string; attempt: number }[];
  /** Most common role that produced the rejection (planner / maker / verifier). */
  role: "planner" | "maker" | "verifier" | "unknown";
  suggestedFix: SuggestedFix;
}

/**
 * Bucket a reject reason into a stable key. Lowercase, strip punctuation,
 * take the first 2 normalized words. The goal is "same opening complaint
 * → same bucket" — not perfect paraphrase detection, just enough to
 * group the obvious repeats ("Missing criteria — list is empty" /
 * "missing criteria! 5 expected" both start with "missing criteria").
 * 2 words is enough to land the noun phrase without trailing detail
 * that varies between attempts ("list is empty" vs "5 expected").
 */
function rejectKey(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

/**
 * Scan every task in the store for REJECT verdicts whose `oneLineReason`
 * recurs. Returns findings sorted by count desc, with the top 10 only
 * (more is noise at this scale).
 */
export function detectRepeatedRejections(
  tasks: Task[] = listTasks()
): Finding[] {
  // bucketKey → { reason (canonical display), count, examples, roles }
  const buckets = new Map<
    string,
    {
      reason: string;
      count: number;
      examples: { taskId: string; attempt: number }[];
      roles: Map<string, number>;
    }
  >();

  for (const task of tasks) {
    if (!task.verdict) continue;
    const v: Verdict = task.verdict;
    if (v.outcome !== "REJECT") continue;
    if (!v.oneLineReason) continue;
    const key = rejectKey(v.oneLineReason);
    if (key.length < 5) continue; // skip "no" / "fail" / etc
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        reason: v.oneLineReason,
        count: 0,
        examples: [],
        roles: new Map(),
      };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.examples.length < 5) {
      bucket.examples.push({ taskId: task.id, attempt: v.attempt });
    }
    // We don't store the per-criterion role that caused the reject, but
    // we DO have task.attempts[].verifierVerdict → "REJECT" which is the
    // canonical reject role. Pluck it from there.
    const attemptRec = task.attempts?.find((a) => a.attemptNumber === v.attempt);
    const role = attemptRec?.verifierVerdict ? "verifier" : "unknown";
    bucket.roles.set(role, (bucket.roles.get(role) ?? 0) + 1);
  }

  const findings: Finding[] = [];
  for (const [pattern, b] of buckets) {
    if (b.count < 2) continue; // need at least 2 to be a "pattern"
    let topRole: Finding["role"] = "unknown";
    let topRoleCount = 0;
    for (const [r, c] of b.roles) {
      if (c > topRoleCount) {
        topRole = r as Finding["role"];
        topRoleCount = c;
      }
    }
    findings.push({
      kind: "repeated-reject",
      pattern,
      count: b.count,
      examples: b.examples,
      role: topRole,
      // Most repeated rejections are prompt-fixable (the verifier keeps
      // asking for the same thing the maker/planner isn't delivering).
      // A few signal code issues (e.g. "build step failed 5 times" =
      // the plan was wrong, not the prompt) — those are minority, treat
      // them as "prompt" too and let the meta-agent decide.
      suggestedFix: "prompt",
    });
  }
  findings.sort((a, b) => b.count - a.count);
  return findings.slice(0, 10);
}

/**
 * Scan every task's `verdict.criteriaWalk` for criteria that were
 * marked `passed: false` in 3+ different tasks. Returns one finding
 * per such criterion, with examples. The threshold (3) is low enough
 * to surface real recurring misses without flooding the UI.
 *
 * ponytail: most criteria-miss findings are prompt-fixable (the
 * planner/maker keeps missing the same acceptance criterion). A few
 * are plan-quality issues — those are still "prompt" (the planner
 * prompt needs to ask for the criterion to be testable).
 */
export function detectCriteriaMisses(
  tasks: Task[] = listTasks()
): Finding[] {
  type Bucket = {
    count: number;
    examples: { taskId: string; attempt: number }[];
    roles: Map<string, number>;
  };
  const buckets = new Map<string, Bucket>();

  for (const task of tasks) {
    const v = task.verdict;
    if (!v) continue;
    for (const item of v.criteriaWalk) {
      if (item.passed) continue;
      let bucket = buckets.get(item.criterion);
      if (!bucket) {
        bucket = { count: 0, examples: [], roles: new Map() };
        buckets.set(item.criterion, bucket);
      }
      bucket.count += 1;
      if (bucket.examples.length < 5) {
        bucket.examples.push({ taskId: task.id, attempt: v.attempt });
      }
      const attemptRec = task.attempts?.find(
        (a) => a.attemptNumber === v.attempt
      );
      const role = attemptRec?.verifierVerdict ? "verifier" : "unknown";
      bucket.roles.set(role, (bucket.roles.get(role) ?? 0) + 1);
    }
  }

  const findings: Finding[] = [];
  for (const [criterion, b] of buckets) {
    if (b.count < 3) continue;
    let topRole: Finding["role"] = "unknown";
    let topCount = 0;
    for (const [r, c] of b.roles) {
      if (c > topCount) {
        topRole = r as Finding["role"];
        topCount = c;
      }
    }
    findings.push({
      kind: "criteria-miss",
      pattern: criterion,
      count: b.count,
      examples: b.examples,
      role: topRole,
      suggestedFix: "prompt",
    });
  }
  findings.sort((a, b) => b.count - a.count);
  return findings.slice(0, 10);
}

/**
 * Detect tasks whose `attempts[].validation.passed` flipped from
 * true to false across consecutive attempts. This catches "the
 * maker's first attempt compiled, the second didn't" — a
 * regression that's almost always a maker-prompt issue (the maker
 * is editing too aggressively on retry).
 */
export function detectValidationRegressions(
  tasks: Task[] = listTasks()
): Finding[] {
  const findings: Finding[] = [];
  for (const task of tasks) {
    const attempts = task.attempts ?? [];
    for (let i = 1; i < attempts.length; i++) {
      const prev = attempts[i - 1].validation;
      const cur = attempts[i].validation;
      if (!prev || !cur) continue;
      if (prev.passed && !cur.passed) {
        findings.push({
          kind: "validation-regression",
          pattern: `attempt ${attempts[i].attemptNumber} broke validation`,
          count: 1,
          examples: [{ taskId: task.id, attempt: attempts[i].attemptNumber }],
          role: "maker",
          suggestedFix: "prompt",
        });
      }
    }
  }
  // Aggregate by role+attempt-pattern — same shape as the other
  // detectors so the UI treats them uniformly.
  const byPattern = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byPattern.get(f.pattern);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 5) {
        existing.examples.push(f.examples[0]);
      }
    } else {
      byPattern.set(f.pattern, { ...f });
    }
  }
  return Array.from(byPattern.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

/**
 * Surface tasks where the stall watchdog fired. A "cluster" is
 * 2+ stalls in the same role across different tasks — that's a
 * systemic prompt/connection issue, not a one-off network blip.
 *
 * ponytail: 7-day window keeps recent context; the threshold (2)
 * is intentionally low because a single repeated stall is already
 * actionable. Suggestions are "code" if the cluster is concentrated
 * in one role (probably a model/connection issue) and "prompt"
 * otherwise (probably a vague task description confusing the agent).
 */
export function detectStallClusters(
  tasks: Task[] = listTasks()
): Finding[] {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - SEVEN_DAYS;

  const byRole = new Map<
    "planner" | "maker" | "verifier",
    { count: number; examples: { taskId: string; attempt: number }[] }
  >();
  for (const task of tasks) {
    const attempts = task.attempts ?? [];
    for (const a of attempts) {
      if (!a.stalls) continue;
      for (const s of a.stalls) {
        // Use the attempt completion time as a proxy for "when the
        // stall happened" — completedAt is set at the end of every
        // attempt. Falls back to "now" (kept in the cluster) for
        // attempts that haven't completed yet.
        const ts = a.completedAt ? Date.parse(a.completedAt) : now;
        if (Number.isFinite(ts) && ts < cutoff) continue;
        const cur = byRole.get(s.phase) ?? { count: 0, examples: [] };
        cur.count += 1;
        if (cur.examples.length < 5) {
          cur.examples.push({ taskId: task.id, attempt: a.attemptNumber });
        }
        byRole.set(s.phase, cur);
      }
    }
  }

  const findings: Finding[] = [];
  for (const [role, b] of byRole) {
    if (b.count < 2) continue;
    findings.push({
      kind: "stall-cluster",
      pattern: `${b.count} stalls in ${role} (last 7 days)`,
      count: b.count,
      examples: b.examples,
      role,
      // Stalls in one role = model/connection issue (code). Stalls
      // spread across roles = prompt clarity issue (prompt). Single-
      // role case is the common one — most stalls concentrate in
      // the maker phase (largest output budget).
      suggestedFix: "code",
    });
  }
  findings.sort((a, b) => b.count - a.count);
  return findings.slice(0, 10);
}

/**
 * Detect no-op attempts: the same set of files changed across
 * consecutive attempts in the same task. The maker rewrote files
 * but produced byte-identical (or near-identical) output — almost
 * always a sign that the feedback wasn't concrete enough.
 *
 * ponytail: comparing the file LIST (not byte content) is a
 * strong-enough proxy without reading the files again. The real
 * guard in orchestrator.ts (`runValidation`'s noOpGuard) does
 * the byte-equality check at runtime; here we use a cheaper
 * signal that catches the same pattern at the population level.
 */
export function detectNoOpAttempts(
  tasks: Task[] = listTasks()
): Finding[] {
  const findings: Finding[] = [];
  for (const task of tasks) {
    const attempts = task.attempts ?? [];
    for (let i = 1; i < attempts.length; i++) {
      const prev = attempts[i - 1].filesChanged;
      const cur = attempts[i].filesChanged;
      if (!prev || !cur) continue;
      if (prev.length === 0 || cur.length === 0) continue;
      // Same file set, same length = same set. (paths are unique by
      // construction; we don't need a set comparison.)
      const sameSet =
        prev.length === cur.length &&
        prev.every((p, j) => p.path === cur[j].path);
      if (sameSet) {
        findings.push({
          kind: "no-op-attempts",
          pattern: `attempt ${attempts[i].attemptNumber} rewrote the same files as attempt ${attempts[i - 1].attemptNumber}`,
          count: 1,
          examples: [
            { taskId: task.id, attempt: attempts[i].attemptNumber },
          ],
          role: "maker",
          suggestedFix: "prompt",
        });
      }
    }
  }
  // Aggregate identical patterns across tasks.
  const byPattern = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byPattern.get(f.pattern);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 5) {
        existing.examples.push(f.examples[0]);
      }
    } else {
      byPattern.set(f.pattern, { ...f });
    }
  }
  return Array.from(byPattern.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

/**
 * Detect LLM calls whose prompt token count is > 2× the median for
 * the same role on the same workdir. Reads the on-disk trace files
 * — only fires for workdirs that have traces, returns [] otherwise.
 *
 * ponytail: the median is computed across ALL traces in the workdir
 * (not just this task), so a single bloated task doesn't poison its
 * own baseline. Token bloat is a "code" fix (the prompt is the
 * wrong shape, or context files are over-included) — not a
 * per-prompt sentence to add.
 */
export async function detectTokenBlowUps(
  tasks: Task[] = listTasks()
): Promise<Finding[]> {
  // Group traces by (workdir, role). For each group, compute the
  // median promptTokens and flag any call > 2× median.
  const grouped = new Map<
    string,
    { workdir: string; role: "planner" | "maker" | "verifier"; values: number[]; examples: { taskId: string; attempt: number }[] }
  >();
  for (const task of tasks) {
    const traces = await readTracesForTask(task.workdir, task.id).catch(
      () => []
    );
    for (const t of traces) {
      if (t.promptTokens === null) continue;
      const key = `${task.workdir}::${t.role}`;
      let g = grouped.get(key);
      if (!g) {
        g = {
          workdir: task.workdir,
          role: t.role,
          values: [],
          examples: [],
        };
        grouped.set(key, g);
      }
      g.values.push(t.promptTokens);
      if (g.examples.length < 5) {
        g.examples.push({ taskId: task.id, attempt: t.attempt });
      }
    }
  }

  const findings: Finding[] = [];
  for (const g of grouped.values()) {
    if (g.values.length < 5) continue; // need a baseline to compare against
    const sorted = [...g.values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = median * 2;
    const bloated = g.values.filter((v) => v > threshold).length;
    if (bloated < 2) continue;
    findings.push({
      kind: "token-blow-up",
      pattern: `${bloated} ${g.role} calls > 2× median (${median} → >${threshold} prompt tokens) on ${g.workdir}`,
      count: bloated,
      examples: g.examples,
      role: g.role,
      suggestedFix: "code",
    });
  }
  findings.sort((a, b) => b.count - a.count);
  return findings.slice(0, 10);
}

/**
 * Run every detector and return the combined finding list, sorted by
 * count desc, top 10 across all kinds. New detectors get added here;
 * callers don't need to know which exist.
 *
 * detectTokenBlowUps is async (it reads trace files); the rest are
 * pure in-memory scans. We await it inline so the endpoint stays a
 * simple GET — total IO is bounded by "5 trace reads per task".
 */
export async function analyzePatterns(
  tasks: Task[] = listTasks()
): Promise<Finding[]> {
  const all: Finding[] = [
    ...detectRepeatedRejections(tasks),
    ...detectCriteriaMisses(tasks),
    ...detectValidationRegressions(tasks),
    ...detectStallClusters(tasks),
    ...detectNoOpAttempts(tasks),
    ...(await detectTokenBlowUps(tasks)),
  ];
  // De-dupe by (kind, pattern) — two detectors can theoretically
  // surface the same complaint. Keep the first one (highest-priority
  // detector by source-order in the array above).
  const seen = new Set<string>();
  const unique: Finding[] = [];
  for (const f of all) {
    const k = `${f.kind}::${f.pattern}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
  }
  unique.sort((a, b) => b.count - a.count);
  return unique.slice(0, 10);
}
