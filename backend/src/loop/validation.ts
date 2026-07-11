// Pre-runtime validation gate (Task 5). Two cheap checks run between the
// maker's STATE.md write and the headless-browser runtime check:
//
//   (a) No-op guard — the maker wrote zero files, OR every written file
//       is byte-identical to the previous attempt. Either way, the
//       runtime check has nothing new to inspect AND the verifier will
//       re-issue the same feedback it gave last time. Short-circuit
//       with a synthetic "no effective change" error so the next
//       attempt's prompt carries the message instead of the user
//       waiting for a redundant browser round-trip.
//
//   (b) Syntax gate — for each written file, run a static syntax check
//       appropriate to its type. JS/TS: `node --check` (Node's built-in
//       script verifier). For .ts this is best-effort: Node doesn't
//       strip types, so a real type error slips through to the verifier
//       instead. HTML / CSS: no zero-dep parser available; the
//       headless-browser runtime check downstream is the catch. On any
//       failure, capture the error verbatim and fail the validation
//       with the full output.
//
// The output shape is intentionally minimal — the orchestrator just
// needs to know pass/fail and a list of error strings to feed to the
// next attempt. Everything else is internal.

import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseHtml } from "parse5";

export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

const TEXT_LIKE_EXTS = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
]);

/**
 * Run both gates against the workdir + changed files.
 *
 * @param workdir Absolute path to the workdir (used to resolve file paths)
 * @param filesChanged List of `{ path, reason }` from the diff summary.
 *   Paths are relative to the workdir. Files that don't exist or aren't
 *   text-like are skipped (treated as valid).
 * @param previousFilesContent Optional: map of path → previous content for
 *   the no-op guard. Caller (orchestrator) supplies the previous attempt's
 *   file contents from its in-memory state. Empty/undefined skips the
 *   no-op check.
 */
export async function runValidation(
  workdir: string,
  filesChanged: { path: string; reason: string }[],
  previousFilesContent?: Record<string, string>
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Gate (a): no-op guard. Skip if the maker wrote zero files, OR all
  // text-like files match the previous attempt's content byte-for-byte.
  if (filesChanged.length === 0) {
    errors.push("validation: maker wrote zero files (no effective change)");
  } else if (previousFilesContent) {
    const allUnchanged: string[] = [];
    const newFileNames: string[] = [];
    for (const f of filesChanged) {
      const isText = TEXT_LIKE_EXTS.has(extname(f.path).toLowerCase());
      if (!isText) continue; // binaries can't be diffed cheaply; trust the LLM
      const prev = previousFilesContent[f.path];
      if (prev === undefined) {
        newFileNames.push(f.path);
        continue;
      }
      let current: string;
      try {
        current = await readFile(join(workdir, f.path), "utf8");
      } catch {
        // file was claimed in the diff but doesn't exist on disk — count
        // as a change so the no-op guard doesn't fire on a missing file
        newFileNames.push(f.path);
        continue;
      }
      if (current === prev) {
        allUnchanged.push(f.path);
      } else {
        newFileNames.push(f.path);
      }
    }
    // No-op only fires when EVERY text-like file is unchanged AND no
    // new text-like file was added. If the maker touched at least one
    // file's bytes (or added a new file), it's making progress.
    if (
      allUnchanged.length > 0 &&
      newFileNames.length === 0 &&
      allUnchanged.length === filesChanged.filter((f) =>
        TEXT_LIKE_EXTS.has(extname(f.path).toLowerCase())
      ).length
    ) {
      errors.push(
        `validation: maker produced no effective change (${allUnchanged.length} file(s) identical to previous attempt: ${allUnchanged
          .slice(0, 3)
          .join(", ")}${allUnchanged.length > 3 ? "…" : ""})`
      );
    }
  }

  // Gate (b): syntax check. Only run if (a) didn't already fail — no
  // point syntax-checking unchanged files. Each file is checked
  // independently so a failure in one doesn't short-circuit the others.
  if (errors.length === 0) {
    for (const f of filesChanged) {
      const ext = extname(f.path).toLowerCase();
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        const err = await checkJsSyntax(workdir, f.path);
        if (err) errors.push(err);
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
        // node --check rejects .ts at the type-stripping step (it
        // doesn't strip types); for .ts we run the same checkJsSyntax
        // path. A real type error is then caught by the verifier
        // (or tsc in the test/build flow), not here. We accept
        // false-negatives for the type-stripping step in exchange
        // for keeping validation a zero-dep step.
        const err = await checkJsSyntax(workdir, f.path);
        if (err) errors.push(err);
      } else if (ext === ".html" || ext === ".htm") {
        // HTML gate (Task 2 of 2026-07-11-loop-resilience-and-real-build).
        // parse5 is spec-forgiving, so only ERROR-severity structural
        // problems fail here — benign quirks (missing doctype, unquoted
        // attrs, implied </p>) pass. Real HTML/CSS *behavior* issues are
        // still the headless-browser runtime check's job downstream.
        const errs = await checkHtmlSyntax(workdir, f.path);
        errors.push(...errs);
      }
      // CSS / images / etc. — no cheap parser worth the false-positive
      // risk; the headless-browser runtime check downstream catches
      // real CSS errors. The no-op guard (gate a) is the high-signal
      // one for those.
    }
  }

  return { passed: errors.length === 0, errors };
}

/**
 * Run `node --check` on a JS/TS file. Returns null on exit 0, or a
 * truncated stderr string on failure. Times out after 10s to bound
 * the validation step (a hung tsc compile shouldn't block the loop).
 */
async function checkJsSyntax(
  workdir: string,
  relPath: string
): Promise<string | null> {
  const abs = join(workdir, relPath);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--check", abs], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(
        `validation: syntax check timed out for ${relPath} (10s) — skipping`
      );
    }, 10_000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      // `node --check` doesn't exist on the runtime? treat as a
      // best-effort pass; the verifier will catch real issues.
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(null);
      } else {
        resolve(
          `validation: syntax error in ${relPath}:\n${stderr
            .trim()
            .slice(0, 1500)}`
        );
      }
    });
  });
}

// ─── HTML syntax gate (Task 2, 2026-07-11-loop-resilience-and-real-build) ──
//
// Two error classes, both genuinely structural:
//   1. Fatal tokenizer errors — unterminated tags/attributes/comments/
//      doctypes (parse5 `eof-in-*` / `unexpected-eof` codes). These mean
//      the file was truncated or the maker emitted broken markup.
//   2. Unclosed non-omittable elements — the HTML spec forgives unclosed
//      <p>/<li>/<td>… (their end tags are omittable), so parse5 reports
//      NO error for a dangling <div>. We walk the location-annotated tree
//      instead: an HTML-namespace element with a startTag location but no
//      endTag location, that is neither void nor omittable, is unclosed.
//
// Everything else parse5 reports (missing-doctype, duplicate-attribute,
// unquoted attrs, implied closes) is a benign quirk browsers handle —
// flagging those would cause false-positive REJECT loops.

/** End tags the HTML spec allows omitting — never flag these as unclosed. */
const OMITTABLE_END_TAGS = new Set([
  "html", "head", "body", "p", "li", "dt", "dd", "rt", "rp",
  "optgroup", "option", "colgroup", "caption", "thead", "tbody",
  "tfoot", "tr", "td", "th",
]);

/** Void elements — no end tag exists by definition. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Fatal tokenizer error codes: markup that is truncated/unterminated. */
const FATAL_HTML_ERROR_CODES = /^(eof-|unexpected-eof)/;

/**
 * Parse an HTML file with parse5 and return ERROR-severity structural
 * problems only (empty array = pass). Exported for tests. Best-effort:
 * any unexpected parser failure resolves to a pass, mirroring
 * checkJsSyntax's stance — the runtime check downstream is the backstop.
 */
export async function checkHtmlSyntax(
  workdir: string,
  relPath: string
): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(join(workdir, relPath), "utf8");
  } catch {
    return []; // claimed in the diff but missing on disk — gate (a) territory
  }
  try {
    const errors: string[] = [];
    const doc = parseHtml(source, {
      sourceCodeLocationInfo: true,
      onParseError: (err) => {
        if (FATAL_HTML_ERROR_CODES.test(err.code)) {
          errors.push(
            `validation: HTML error in ${relPath}:${err.startLine}: ${err.code}`
          );
        }
      },
    });
    collectUnclosedElements(doc as unknown as WalkableNode, relPath, errors);
    return errors.slice(0, 10); // bound the feedback size
  } catch {
    return []; // parser blew up — don't block the loop on our own tooling
  }
}

/** Minimal structural view of a parse5 node — enough for the walk. */
interface WalkableNode {
  tagName?: string;
  namespaceURI?: string;
  sourceCodeLocation?: { startTag?: { startLine: number }; endTag?: unknown } | null;
  childNodes?: unknown[];
  content?: unknown;
}

/**
 * Recursively find HTML-namespace elements whose start tag appears in the
 * source but whose end tag does not (and isn't void/omittable).
 */
function collectUnclosedElements(
  node: WalkableNode,
  relPath: string,
  out: string[]
): void {
  if (
    node.tagName &&
    (!node.namespaceURI || node.namespaceURI.includes("xhtml")) &&
    !VOID_ELEMENTS.has(node.tagName) &&
    !OMITTABLE_END_TAGS.has(node.tagName)
  ) {
    const loc = node.sourceCodeLocation;
    if (loc && loc.startTag && !loc.endTag) {
      out.push(
        `validation: HTML error in ${relPath}:${loc.startTag.startLine}: unclosed <${node.tagName}> (end tag missing and not omittable)`
      );
    }
  }
  for (const child of node.childNodes ?? []) {
    collectUnclosedElements(child as WalkableNode, relPath, out);
  }
  // <template> children live under .content
  if (node.content) {
    collectUnclosedElements(node.content as WalkableNode, relPath, out);
  }
}
