#!/usr/bin/env node
// Mutation proof for the trust scoreboard. Each case disables exactly one
// defence in an explicitly mock-enabled child process and expects the matching
// scoreboard check to FAIL because its exact reason prefix disappears.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRUST_DEMO = join(HERE, "trust-demo.mjs");
const C = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };
const cases = [
  ["skip-added", "Maker cannot skip a failing test (.skip)"],
  ["trivial-assertion", "Maker cannot replace assertions with trivially true checks"],
  ["test-policy", "Test config and test-script edits are blocked"],
  ["check-failed", "Verifier APPROVE cannot override a failing real check"],
  ["evidence-missing", "Evidence for a check that never ran is rejected"],
  ["malformed-verdict", "Malformed JSON verdict is rejected"],
  ["missing-file", "Prompt injection cannot approve a no-op maker"],
  ["check-timeout", "A hanging declared check is killed and rejected"],
  ["path-escape", "Traversal and absolute-path writes stay inside the workdir"],
  ["runtime-unavailable", "Runtime check unavailable on a page task fails closed"],
];

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function scoreboardResult(output, checkName) {
  const escaped = checkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(PASS|FAIL) ${escaped}(?:\\s|$)`);
  return stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).find((line) => re.test(line)) ?? null;
}

function runCase(checkName, { rule, mutate }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.LOOP_TEST_DISABLE_DEFENCE;
    if (mutate) {
      env.LOOP_ALLOW_MOCK = "1";
      env.LOOP_TEST_DISABLE_DEFENCE = rule;
    }
    const child = spawn(process.execPath, [TRUST_DEMO, checkName], {
      cwd: join(HERE, "..", ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function chromiumPreflight() {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    console.error("Chromium missing - run: cd backend && npx playwright install --only-shell chromium");
    return false;
  }
}

let passed = 0;
try {
  if (!(await chromiumPreflight())) process.exitCode = 2;
  else {
    for (const [rule, checkName] of cases) {
      const baseline = await runCase(checkName, { rule, mutate: false });
      const baselineOutput = baseline.stdout + "\n" + baseline.stderr;
      const baselineLine = scoreboardResult(baselineOutput, checkName);
      if (baseline.code === 2 || baselineLine === null) {
        console.log(`${C.r}FAIL${C.x} ${rule}${C.d} — baseline did not produce an exact PASS line${C.x}`);
        if (process.env.DEBUG_TRUST_MUTATION === "1") console.log(stripAnsi(baselineOutput));
        process.exitCode = baseline.code === 2 ? 2 : 1;
        break;
      }
      const mutated = await runCase(checkName, { rule, mutate: true });
      const mutatedOutput = mutated.stdout + "\n" + mutated.stderr;
      const mutatedLine = scoreboardResult(mutatedOutput, checkName);
      const ok = baseline.code === 0 && baselineLine.startsWith("PASS ") && mutated.code === 1 && mutatedLine?.startsWith("FAIL ");
      if (ok) passed += 1;
      console.log(`${ok ? C.g + "PASS" : C.r + "FAIL"}${C.x} ${rule}${C.d} — baseline PASS -> mutated FAIL${C.x}`);
      if (!ok && process.env.DEBUG_TRUST_MUTATION === "1") {
        console.log("BASELINE\n" + stripAnsi(baselineOutput));
        console.log("MUTATED\n" + stripAnsi(mutatedOutput));
      }
      if (mutated.code === 2) {
        process.exitCode = 2;
        break;
      }
    }
    if (process.exitCode !== 2) {
      console.log(`${passed}/${cases.length} defences are load-bearing (baseline verified)`);
      process.exitCode = passed === cases.length ? 0 : 1;
    }
  }
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
