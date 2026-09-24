// ─── Time labels (Requirement 4.2) ─────────────────────────────────────────────
// Pure helpers; `now` is injectable so tests don't depend on the clock.

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "just now", "5m ago", "3h ago", "12d ago" — no cutoff. */
export function relativeDate(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Relative label up to 7 days, then the full date (e.g. "Sep 14, 2026"). */
export function postedLabel(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  return days <= 7 ? relativeDate(iso, now) : formatDate(iso);
}
