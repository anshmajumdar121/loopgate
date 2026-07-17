import { Hono } from "hono";
import { analyzePatterns } from "../loop/trace-analysis.js";
import { buildImproveRecipe } from "../loop/improve-recipe.js";

export const insightsApi = new Hono();

/**
 * Run the pattern detector across every task the store knows about.
 * Returns findings sorted by count desc, top 10. The endpoint is
 * deliberately synchronous and cheap — 5 in-memory scanners plus
 * one trace-file read per task. Add a cache + cron if it ever
 * shows up in a flame graph.
 */
insightsApi.get("/insights", async (c) => {
  const findings = await analyzePatterns();
  return c.json({ findings });
});

/**
 * Generate a self-contained GOAL.md recipe that turns the current
 * pattern findings into a `taskType: improve-agents` style task the
 * existing loop can run. The user pastes the returned markdown as
 * the prompt of a new task, the planner turns it into a plan, the
 * maker (constrained to `.opencode/agents/**`) edits the system
 * prompts, the verifier checks scope + intent. No new agent type,
 * no new orchestrator code path.
 *
 * ponytail: this is Phase 3 of recursive-improve in one HTTP call.
 * The loop already has a plan→implement→verify cycle, a file
 * allowlist in GOAL.md, a scope-check verifier, and a denylist
 * for auth/payments/etc. The recipe just points all of that at
 * the meta-target.
 */
insightsApi.get("/improve-recipe", async (c) => {
  const md = buildImproveRecipe(await analyzePatterns());
  return c.text(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});
