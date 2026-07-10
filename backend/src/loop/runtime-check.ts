// The "trial" in trial-and-error. Loads the served prototype in headless
// chromium, watches for console errors / uncaught exceptions / failed
// requests, pokes the first few interactive elements, and screenshots the
// result. The returned evidence is injected verbatim into the verifier's
// prompt (Task 3) so verdicts are grounded in observed behavior instead of
// source-reading vibes. Artifacts land in <workdir>/.loop/ for the human.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RuntimeCheckResult {
  ok: boolean;
  url: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  interactionLog: string[];
  screenshotPath: string | null;
  /** Pre-formatted markdown block for prompt injection. */
  evidenceMarkdown: string;
}

const SETTLE_MS = 2_500; // let init scripts / rAF loops run
const MAX_INTERACTIONS = 5;

export async function runRuntimeCheck(
  url: string,
  workdir: string,
  attempt: number
): Promise<RuntimeCheckResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const interactionLog: string[] = [];
  let screenshotPath: string | null = null;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 500)));
    page.on("requestfailed", (req) =>
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`)
    );

    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);

    // Smoke interactions: click the first few visible buttons/links so
    // handlers with immediate errors get exercised. Errors they throw are
    // captured by the pageerror listener above.
    const clickables = page.locator("button:visible, [role='button']:visible, a[href='#']:visible");
    const count = Math.min(await clickables.count(), MAX_INTERACTIONS);
    for (let i = 0; i < count; i++) {
      try {
        const el = clickables.nth(i);
        const label = ((await el.textContent()) ?? "").trim().slice(0, 40) || `<element ${i}>`;
        await el.click({ timeout: 2_000 });
        interactionLog.push(`clicked "${label}" — ok`);
        await page.waitForTimeout(300);
      } catch (err) {
        interactionLog.push(`click ${i} failed: ${String(err).slice(0, 200)}`);
      }
    }

    const loopDir = join(workdir, ".loop");
    await mkdir(loopDir, { recursive: true });
    screenshotPath = join(loopDir, `runtime-attempt-${attempt}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (err) {
    pageErrors.push(`runtime-check harness error: ${String(err).slice(0, 300)}`);
  } finally {
    await browser.close();
  }

  const ok = pageErrors.length === 0 && consoleErrors.length === 0;
  const fmt = (label: string, items: string[]) =>
    items.length === 0 ? `${label}: none` : `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}`;
  const evidenceMarkdown = [
    `Loaded ${url} in headless chromium (viewport 1280x800, settled ${SETTLE_MS}ms).`,
    fmt("Uncaught page errors", pageErrors),
    fmt("Console errors", consoleErrors),
    fmt("Failed network requests", failedRequests),
    fmt("Smoke interactions", interactionLog),
    `Overall: ${ok ? "NO runtime errors observed" : "RUNTIME ERRORS OBSERVED — the prototype is broken as shipped"}`,
  ].join("\n");

  const result: RuntimeCheckResult = {
    ok, url, consoleErrors, pageErrors, failedRequests, interactionLog,
    screenshotPath, evidenceMarkdown,
  };
  // Persist the evidence JSON next to the screenshot for post-mortems.
  try {
    await writeFile(
      join(workdir, ".loop", `runtime-attempt-${attempt}.json`),
      JSON.stringify(result, null, 2),
      "utf8"
    );
  } catch { /* artifact write is best-effort */ }
  return result;
}
