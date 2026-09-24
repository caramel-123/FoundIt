// ─── Claim rate limit (Requirement 6.5) ───────────────────────────────────────
// Owners claim via "Prove it's yours" (found-post responses). The server enforces
// the same rule with a trigger; this lets the UI explain it before submitting.

import type { ChallengeResponse } from "../types";

export const CLAIM_LIMIT = 3;
export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * When the user may claim again (ISO string), or null if they're under the limit.
 * That's when the oldest of their last CLAIM_LIMIT claims leaves the 24h window.
 */
export function claimBlockedUntil(
  responses: Pick<ChallengeResponse, "responder_id" | "kind" | "created_at">[],
  userId: string,
  now: number = Date.now(),
): string | null {
  const recent = responses
    .filter(r => r.responder_id === userId && r.kind !== "lost" && now - Date.parse(r.created_at) < CLAIM_WINDOW_MS)
    .map(r => Date.parse(r.created_at))
    .sort((a, b) => a - b);
  if (recent.length < CLAIM_LIMIT) return null;
  return new Date(recent[recent.length - CLAIM_LIMIT] + CLAIM_WINDOW_MS).toISOString();
}
