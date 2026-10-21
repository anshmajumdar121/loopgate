export const DEFENCE_RULES = [
  "skip-added",
  "trivial-assertion",
  "test-policy",
  "check-failed",
  "evidence-missing",
  "malformed-verdict",
  "missing-file",
  "check-timeout",
  "path-escape",
  "runtime-unavailable",
] as const;

export type DefenceRule = (typeof DEFENCE_RULES)[number];

/**
 * Test-only mutation hook. It is deliberately inert unless the caller has
 * explicitly opted into mock behavior, so a stray environment variable cannot
 * disable a production defence.
 */
export function isDefenceDisabled(
  rule: DefenceRule,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.LOOP_ALLOW_MOCK === "1" && env.LOOP_TEST_DISABLE_DEFENCE === rule;
}
