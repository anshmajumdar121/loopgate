// Additive component: renders a "Live Preview" link when the task has a
// previewUrl. Renders NOTHING otherwise — safe to mount unconditionally.
export function PreviewLinkChip({ url }: { url?: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        textDecoration: "none",
        border: "1px solid #3fb95044",
        background: "#3fb95014",
        color: "#3fb950",
      }}
      title="Open the live prototype"
    >
      ● Live Preview
    </a>
  );
}
