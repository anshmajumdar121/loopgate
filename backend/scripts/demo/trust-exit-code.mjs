/** Exit 2 is reserved for preflight, never the number of failed checks. */
export function trustExitCode({ preflightFailed, failures, checksRun }) {
  if (preflightFailed) return 2;
  return checksRun > 0 && failures === 0 ? 0 : 1;
}
