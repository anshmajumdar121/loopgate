import type { AttemptRecord, Task } from "@/types/loop";

/**
 * Per-attempt timeline. One collapsible card per attempt, showing what
 * changed, what the runtime check found, and why the verifier
 * approved/rejected. Renders NOTHING when `task.attempts` is missing
 * or empty — old tasks display unchanged (the established render-
 * nothing-when-absent pattern shared with PreviewLinkChip and
 * RuntimeCheckPanel).
 *
 * Pure presentational component — reads props only, dispatches no
 * state. Live-updates work via the same task-mirror subscription the
 * rest of the canvas uses: the parent ProgressNode re-renders when
 * the WS task_update arrives, and we re-derive the timeline.
 */
export function AttemptTimeline({ task }: { task?: Task | null }) {
  const attempts = task?.attempts;
  if (!attempts || attempts.length === 0) return null;

  // Sort by attempt number — defensive: the orchestrator already
  // sorts, but a manual edit or a stale payload could leave them
  // out of order.
  const sorted = [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);

  return (
    <div className="nodrag nopan mt-2 space-y-1.5">
      <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        Attempt history ({sorted.length})
      </div>
      {sorted.map((a) => (
        <AttemptCard key={a.attemptNumber} attempt={a} task={task} />
      ))}
    </div>
  );
}

function AttemptCard({ attempt, task }: { attempt: AttemptRecord; task?: Task | null }) {
  const verdict = attempt.verifierVerdict;
  const isApprove = verdict === "APPROVE";
  const isReject = verdict === "REJECT";
  const isEscalate = verdict === "ESCALATE_HUMAN";
  // Duration shown in the header — sum of phases that actually ran.
  const totalMs =
    (attempt.makerMs ?? 0) +
    (attempt.runtimeCheckMs ?? 0) +
    (attempt.verifierMs ?? 0);
  const durLabel = totalMs > 0 ? formatDuration(totalMs) : "—";
  // Verdict label + color, matching the existing step-status palette.
  const verdictLabel = isApprove
    ? "APPROVE"
    : isReject
    ? "REJECT"
    : isEscalate
    ? "ESCALATE"
    : "—";
  const verdictColor = isApprove
    ? "text-emerald-700 dark:text-emerald-300"
    : isReject
    ? "text-rose-700 dark:text-rose-300"
    : isEscalate
    ? "text-amber-700 dark:text-amber-300"
    : "text-zinc-500";

  // Screenshot URL — combines previewUrl (set on the task) with the
  // artifact's relative path. previewUrl may be absent for very old
  // tasks; in that case the thumbnail is just unlinked.
  const screenshotUrl =
    task?.previewUrl && attempt.runtimeResult?.screenshotRelPath
      ? `${task.previewUrl}${attempt.runtimeResult.screenshotRelPath}`
      : null;

  return (
    <details
      className="rounded-md border border-zinc-200 bg-zinc-50/50 px-2 py-1.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-800/40"
      // Default-open the most recent attempt so users see the failure
      // detail without clicking — but only if it's not an APPROVE
      // (APPROVE has nothing to debug).
      open={!isApprove && attempt.attemptNumber === Math.max(...(task?.attempts?.map((a) => a.attemptNumber) ?? [0]))}
    >
      <summary className="flex cursor-pointer items-center gap-2 list-none">
        <span className="font-mono text-[10px] font-semibold text-zinc-700 dark:text-zinc-200">
          #{attempt.attemptNumber}
        </span>
        <span className={`font-semibold ${verdictColor}`}>{verdictLabel}</span>
        {attempt.stuckDetected && (
          <span
            className="rounded bg-rose-100 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
            title="Stuck-loop detector: this attempt repeated the previous one (identical diff + errors)"
          >
            STUCK
          </span>
        )}
        {attempt.validation && !attempt.validation.passed && (
          <span
            className="rounded bg-amber-100 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            title="Pre-runtime validation failed (syntax error or no-op diff)"
          >
            PRE-RT FAIL
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-500 dark:text-zinc-400">{durLabel}</span>
      </summary>

      <div className="mt-1.5 space-y-1.5 pl-1">
        {/* Per-phase timings — only show phases that actually ran. */}
        {(attempt.makerMs !== undefined ||
          attempt.runtimeCheckMs !== undefined ||
          attempt.verifierMs !== undefined) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
            {attempt.makerMs !== undefined && (
              <span>make {formatDuration(attempt.makerMs)}</span>
            )}
            {attempt.runtimeCheckMs !== undefined && (
              <span>runtime {formatDuration(attempt.runtimeCheckMs)}</span>
            )}
            {attempt.verifierMs !== undefined && (
              <span>verify {formatDuration(attempt.verifierMs)}</span>
            )}
          </div>
        )}

        {/* Files changed — reuse the existing monospace list pattern from
            the implementation step. */}
        {attempt.filesChanged && attempt.filesChanged.length > 0 && (
          <div className="space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Files ({attempt.filesChanged.length})
            </div>
            {attempt.filesChanged.map((f, i) => (
              <div
                key={i}
                className="font-mono text-[10px] text-zinc-600 dark:text-zinc-300"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={f.reason}
              >
                {f.path}
              </div>
            ))}
          </div>
        )}

        {/* Runtime check — mini summary. Visually distinct from the
            live RuntimeCheckPanel (which is on the *current* attempt
            only); this is historical. */}
        {attempt.runtimeResult && (
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span
              className={
                attempt.runtimeResult.passed
                  ? "font-semibold text-emerald-700 dark:text-emerald-300"
                  : "font-semibold text-rose-700 dark:text-rose-300"
              }
            >
              {attempt.runtimeResult.passed ? "● runtime ok" : "● runtime errors"}
            </span>
            {!attempt.runtimeResult.passed && (
              <span className="text-zinc-500 dark:text-zinc-400">
                {attempt.runtimeResult.pageErrorCount} page /{" "}
                {attempt.runtimeResult.consoleErrorCount} console
              </span>
            )}
            {screenshotUrl && (
              <a
                href={screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
                title="Open runtime screenshot in new tab"
              >
                screenshot
              </a>
            )}
          </div>
        )}

        {/* Validation result (Task 5: pre-runtime gate). */}
        {attempt.validation && (
          <div
            className={
              attempt.validation.passed
                ? "text-[10px] text-emerald-700 dark:text-emerald-300"
                : "text-[10px] text-rose-700 dark:text-rose-300"
            }
          >
            validation:{" "}
            {attempt.validation.passed
              ? "passed"
              : `failed — ${attempt.validation.errors.slice(0, 2).join("; ")}${
                  attempt.validation.errors.length > 2 ? "…" : ""
                }`}
          </div>
        )}

        {/* Verifier reason — the verdict.oneLineReason. Read-only text,
            full text on hover if it's long. */}
        {attempt.rejectReason && (
          <div
            className="text-[10px] text-zinc-700 dark:text-zinc-200"
            title={attempt.rejectReason}
          >
            <span className="font-semibold">reason:</span> {attempt.rejectReason}
          </div>
        )}

        {/* Raw artifact links — open in the preview server or via
            file:// (browser may block, that's fine). */}
        {attempt.artifactPaths && task?.previewUrl && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            {attempt.artifactPaths.maker && (
              <a
                href={`${task.previewUrl}${attempt.artifactPaths.maker}`}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
              >
                maker.md
              </a>
            )}
            {attempt.artifactPaths.verifier && (
              <a
                href={`${task.previewUrl}${attempt.artifactPaths.verifier}`}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
              >
                verifier.md
              </a>
            )}
            {attempt.artifactPaths.runtimeJson && (
              <a
                href={`${task.previewUrl}${attempt.artifactPaths.runtimeJson}`}
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:underline dark:text-violet-300"
              >
                runtime.json
              </a>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

/** "1m 23s" / "45s" / "1.2s" — concise ms→human label. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m ${rem}s`;
}
