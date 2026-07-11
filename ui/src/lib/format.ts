// Formatting helpers shared across the token-usage UI. Kept in lib/ so
// both the panel header pill and the popover use the same numbers.

const K = 1000;
const M = 1_000_000;

/** Compact number formatter for token totals.
 *  - <1k   → "123"
 *  - <1M   → "12.3k"
 *  - >=1M  → "1.2M"
 *  Always uses one decimal place for k/M so 12.3k vs 12.0k are visually
 *  distinct — important when comparing two providers in the same row.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < K) return String(Math.round(n));
  if (n < M) {
    const v = n / K;
    return `${v.toFixed(v >= 100 ? 0 : 1)}k`;
  }
  const v = n / M;
  return `${v.toFixed(v >= 100 ? 0 : 1)}M`;
}

/** Same compact form but always shows thousands separator for the
 *  "exact" view inside the popover's per-row "details" line. */
export function formatExactTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/** Relative time string. "just now" < 10s, "Ns ago" < 60s, "Nm ago" < 60m,
 *  "Nh ago" < 24h, else the date. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now.getTime() - t);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}
