import assert from "node:assert/strict";
import test from "node:test";
import { trustExitCode } from "./trust-exit-code.mjs";

test("scoreboard failures, including exactly two failures, exit 1", () => {
  for (const failures of [1, 2, 3, 21]) {
    assert.equal(trustExitCode({ preflightFailed: false, failures, checksRun: 21 }), 1);
  }
});
test("only Chromium preflight failure exits 2", () => {
  assert.equal(trustExitCode({ preflightFailed: true, failures: 0, checksRun: 0 }), 2);
});
test("all executed checks must pass; an unmatched filter is not success", () => {
  assert.equal(trustExitCode({ preflightFailed: false, failures: 0, checksRun: 21 }), 0);
  assert.equal(trustExitCode({ preflightFailed: false, failures: 0, checksRun: 0 }), 1);
});
