import assert from "node:assert/strict";
import test from "node:test";
import {
  CHROMIUM_PREFLIGHT_MESSAGE,
  scoreboardResult,
  matchesScoreboardCheck,
  mutationProven,
  isChromiumPreflightFailure,
} from "./trust-output.mjs";

// Verbatim result lines from an earlier actual server-only scoreboard capture
// (/tmp/loop-agent-demo-server-default.out). The sandbox header is omitted.
// Escapes preserve ANSI and literal CR rewrites without line-ending conversion.
const captured = "\x1b[2m…\x1b[0m One malformed request can't kill the server (GET //[)\r\x1b[32mPASS\x1b[0m One malformed request can't kill the server (GET //[) \x1b[2m(0.5s) response: HTTP/1.1 400 Bad Request; alive after: true\x1b[0m\n" +
  "\x1b[2m…\x1b[0m Cross-origin WebSocket is refused\r\x1b[32mPASS\x1b[0m Cross-origin WebSocket is refused \x1b[2m(0.0s) refused: Unexpected server response: 403\x1b[0m\n";
const capturedName = "One malformed request can't kill the server (GET //[)";
const attackName = "Maker cannot skip a failing test (.skip)";
const result = (code, stdout, stderr = "") => ({ code, stdout, stderr });

test("parses exact PASS from captured ANSI scoreboard with CR progress rewrites", () => {
  assert.ok(captured.includes("\r"));
  assert.equal(scoreboardResult(captured, capturedName),
    "PASS One malformed request can't kill the server (GET //[) (0.5s) response: HTTP/1.1 400 Bad Request; alive after: true");
  assert.equal(scoreboardResult(captured, "Cross-origin WebSocket is refused"),
    "PASS Cross-origin WebSocket is refused (0.0s) refused: Unexpected server response: 403");
});

test("accepts CRLF, CR, and LF boundaries, including regex metacharacters", () => {
  for (const separator of ["\r\n", "\r", "\n"]) {
    const output = `… ${attackName}${separator}\x1b[31mFAIL\x1b[0m ${attackName} (2.1s) missing proof${separator}`;
    assert.equal(scoreboardResult(output, attackName), `FAIL ${attackName} (2.1s) missing proof`);
  }
});

test("never accepts a progress line, substring, longer name, or duplicate result", () => {
  assert.equal(scoreboardResult(`… ${attackName}`, attackName), null);
  assert.equal(scoreboardResult(`PASS ${attackName} EXTRA (1.0s)`, attackName), null);
  assert.equal(scoreboardResult(captured, "WebSocket"), null);
  assert.equal(scoreboardResult(captured + captured, capturedName), null);
});

test("full mixed-case names select exactly the requested check", () => {
  assert.equal(matchesScoreboardCheck([attackName], attackName, []), true);
  assert.equal(matchesScoreboardCheck(["path"], "Happy path: plan → make → verify → approved", ["happy", "loop"]), false);
  assert.equal(matchesScoreboardCheck(["path"], "Traversal and absolute-path writes stay inside the workdir", ["path", "traversal"]), true);
});

test("proof requires baseline exit 0 PASS followed by mutated exit 1 FAIL", () => {
  const baseline = result(0, captured);
  const mutated = result(1, `… ${capturedName}\rFAIL ${capturedName} (0.5s) missing reason\n`);
  assert.equal(mutationProven(baseline, mutated, capturedName), true);
  assert.equal(mutationProven(mutated, mutated, capturedName), false);
  assert.equal(mutationProven(baseline, baseline, capturedName), false);
  assert.equal(mutationProven(result(1, captured), mutated, capturedName), false);
  assert.equal(mutationProven(baseline, result(1, "crashed before check"), capturedName), false);
  assert.equal(mutationProven(baseline, result(2, mutated.stdout), capturedName), false);
});

test("exit 2 requires the preflight diagnostic and never counts as mutation proof", () => {
  assert.equal(isChromiumPreflightFailure(result(2, "", CHROMIUM_PREFLIGHT_MESSAGE)), true);
  assert.equal(isChromiumPreflightFailure(result(1, "", CHROMIUM_PREFLIGHT_MESSAGE)), false);
  assert.equal(isChromiumPreflightFailure(result(2, "2/2 checks failed")), false);
  assert.equal(mutationProven(result(0, captured), result(2, "", CHROMIUM_PREFLIGHT_MESSAGE), capturedName), false);
});
