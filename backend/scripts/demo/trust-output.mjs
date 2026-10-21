export const CHROMIUM_PREFLIGHT_MESSAGE = "Chromium missing - run: cd backend && npx playwright install --only-shell chromium";

export function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A progress rewrite is a line boundary even when it has no following LF. */
export function scoreboardResult(output, checkName) {
  const escaped = checkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(PASS|FAIL) ${escaped}(?: \\(\\d+(?:\\.\\d+)?s\\)(?: |$)|$)`);
  const matches = stripAnsi(output).split(/\r\n|\r|\n/)
    .map((line) => line.trim()).filter((line) => re.test(line));
  return matches.length === 1 ? matches[0] : null;
}

export function matchesScoreboardCheck(filters, name, keywords) {
  return filters.length === 0 || filters.some((filter) =>
    filter === name || keywords.includes(filter.toLowerCase()));
}

export function isChromiumPreflightFailure(result) {
  return result.code === 2 && stripAnsi(result.stdout + "\n" + result.stderr)
    .split(/\r\n|\r|\n/).some((line) => line.trim() === CHROMIUM_PREFLIGHT_MESSAGE);
}

export function mutationProven(baseline, mutated, checkName) {
  return baseline.code === 0 &&
    scoreboardResult(baseline.stdout, checkName)?.startsWith("PASS ") === true &&
    mutated.code === 1 &&
    scoreboardResult(mutated.stdout, checkName)?.startsWith("FAIL ") === true;
}
