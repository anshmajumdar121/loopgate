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
  ["skip-added", "skip"],
  ["trivial-assertion", "trivial"],
  ["test-policy", "config"],
  ["check-failed", "real-check"],
  ["evidence-missing", "evidence"],
  ["malformed-verdict", "json"],
  ["missing-file", "injection"],
  ["check-timeout", "hang"],
  ["path-escape", "path"],
  ["runtime-unavailable", "runtime"],
];

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function runCase(rule, filter) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TRUST_DEMO, filter], {
      cwd: join(HERE, "..", ".."),
      env: {
        ...process.env,
        LOOP_ALLOW_MOCK: "1",
        LOOP_TEST_DISABLE_DEFENCE: rule,
      },
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
    for (const [rule, filter] of cases) {
      const result = await runCase(rule, filter);
      const output = stripAnsi(result.stdout + "\n" + result.stderr);
      const failedMatchingCheck = output.split(/\r?\n/).some((line) => line.includes("FAIL") && line.toLowerCase().includes(filter));
      const ok = result.code === 1 && failedMatchingCheck;
      if (ok) passed += 1;
      console.log(`${ok ? C.g + "PASS" : C.r + "FAIL"}${C.x} ${rule}${C.d} — matching scoreboard check ${ok ? "failed" : "did not fail as expected"}${C.x}`);
      if (!ok && process.env.DEBUG_TRUST_MUTATION === "1") console.log(output);
      if (result.code === 2) {
        process.exitCode = 2;
        break;
      }
    }
    if (process.exitCode !== 2) {
      console.log(`${passed}/${cases.length} defences are load-bearing`);
      process.exitCode = passed === cases.length ? 0 : 1;
    }
  }
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
