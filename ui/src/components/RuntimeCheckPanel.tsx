import type { Task } from "@/types/loop";

// Additive component: shows a pass/fail badge + screenshot thumbnail for
// the most recent headless-browser runtime check. Renders NOTHING when the
// task has no runtimeCheck yet (older tasks, or tasks that haven't reached
// the implementation phase) — safe to mount unconditionally.
export function RuntimeCheckPanel({ task }: { task?: Task | null }) {
  const rc = task?.runtimeCheck;
  if (!rc || !task?.previewUrl) return null;

  const screenshotUrl = rc.screenshotRelPath
    ? `${task.previewUrl}${rc.screenshotRelPath}`
    : null;

  return (
    <div
      style={{
        marginTop: 6,
        padding: 8,
        borderRadius: 8,
        border: `1px solid ${rc.ok ? "#3fb95033" : "#f8514933"}`,
        background: rc.ok ? "#3fb95010" : "#f8514910",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span style={{ color: rc.ok ? "#3fb950" : "#f85149" }}>
          {rc.ok ? "● Runtime check passed" : "● Runtime check found errors"}
        </span>
        <span style={{ opacity: 0.6, fontWeight: 400 }}>attempt {rc.attempt}</span>
      </div>
      {!rc.ok && (
        <div style={{ marginTop: 2, opacity: 0.8 }}>
          {rc.pageErrorCount} page error{rc.pageErrorCount === 1 ? "" : "s"},{" "}
          {rc.consoleErrorCount} console error{rc.consoleErrorCount === 1 ? "" : "s"}
        </div>
      )}
      {screenshotUrl && (
        <a href={screenshotUrl} target="_blank" rel="noreferrer">
          <img
            src={screenshotUrl}
            alt="Runtime check screenshot"
            style={{
              marginTop: 6,
              maxWidth: "100%",
              maxHeight: 160,
              borderRadius: 4,
              border: "1px solid #ffffff1a",
              display: "block",
            }}
          />
        </a>
      )}
    </div>
  );
}
