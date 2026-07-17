// Loop anchors — deterministic top-K retrieval from a JSON dataset of past
// posts. Used by the short-form script optimization loop: the planner and
// maker prompts receive the top-K posts by save_rate so the rewriter can
// emulate what empirically wins, and the evaluator can sanity-check the
// rewriter's output against proven templates.
//
// The dataset shape is intentionally permissive — only `script`,
// `save_rate`, and `niche` are required for the markdown block; everything
// else is ignored. This lets the same loader work with hand-curated
// training data, scraped historical posts, or a thin slice of the loop's
// own prior outputs.
//
// Determinism: we sort by `save_rate` DESC, then by `post_id` ASC (tie
// breaker — stable across runs), then take the first K. The orchestrator
// runs this once before Phase 1 and reuses the result for every prompt
// the loop builds for this task.

import { readFile } from "node:fs/promises";

export interface Anchor {
  post_id: string;
  script: string;
  save_rate: number;
  niche: string;
  /** Original row kept verbatim so future fields (saves, views, etc.) can
   *  be surfaced without re-reading the dataset. */
  raw: Record<string, unknown>;
}

/**
 * Read a JSON dataset, validate each row has the minimum fields, sort by
 * `save_rate` DESC (tie-broken by `post_id` ASC), and return the top K.
 *
 * @param datasetPath Absolute path to a JSON file containing an array of
 *   post records.
 * @param k How many top performers to return. Default 5 — enough to show
 *   the rubric planner the range of winning structures without bloating
 *   the prompt budget.
 */
export async function retrieveAnchors(
  datasetPath: string,
  k: number = 5
): Promise<Anchor[]> {
  const raw = await readFile(datasetPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `retrieveAnchors: ${datasetPath} is not valid JSON (${(err as Error).message})`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `retrieveAnchors: ${datasetPath} must be a JSON array, got ${typeof parsed}`
    );
  }
  const anchors: Anchor[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.script !== "string" || typeof r.save_rate !== "number") continue;
    anchors.push({
      post_id:
        typeof r.post_id === "string" ? r.post_id : `row-${anchors.length}`,
      script: r.script,
      save_rate: r.save_rate,
      niche: typeof r.niche === "string" ? r.niche : "unknown",
      raw: r,
    });
  }
  anchors.sort((a, b) => {
    if (b.save_rate !== a.save_rate) return b.save_rate - a.save_rate;
    return a.post_id.localeCompare(b.post_id);
  });
  return anchors.slice(0, Math.max(0, k));
}

/**
 * Render anchors as a markdown block suitable for pasting into the
 * planner's and maker's user prompt under `## Notes for the maker`.
 * Each anchor gets a stable ordinal so the rewriter can refer to "anchor
 * #3" without re-quoting the whole script.
 */
export function formatAnchorsBlock(anchors: Anchor[]): string {
  if (anchors.length === 0) {
    return "_(no anchors available — dataset was empty or unreadable)_";
  }
  const lines: string[] = [];
  lines.push(`Top ${anchors.length} past posts by save_rate (DESC, ties broken by post_id ASC):`);
  lines.push("");
  anchors.forEach((a, i) => {
    lines.push(`### Anchor #${i + 1} — ${a.post_id}`);
    lines.push(`- save_rate: ${a.save_rate}`);
    lines.push(`- niche: ${a.niche}`);
    lines.push("- script:");
    lines.push("```");
    lines.push(a.script);
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}
