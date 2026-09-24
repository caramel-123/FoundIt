import { test } from "node:test";
import assert from "node:assert/strict";
import { claimBlockedUntil } from "./claimLimit.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const HOUR = 3_600_000;
const claim = (hoursAgo: number, extra: { responder_id?: string; kind?: "found" | "lost" } = {}) => ({
  responder_id: "me", kind: "found" as const, created_at: new Date(NOW - hoursAgo * HOUR).toISOString(), ...extra,
});

test("under the limit is not blocked", () => {
  assert.equal(claimBlockedUntil([claim(1), claim(2)], "me", NOW), null);
});

test("three claims in 24h block until the oldest of them expires", () => {
  const until = claimBlockedUntil([claim(1), claim(5), claim(20)], "me", NOW);
  assert.equal(until, new Date(NOW - 20 * HOUR + 24 * HOUR).toISOString());
});

test("with more than three, the window reopens when the third-newest expires", () => {
  const until = claimBlockedUntil([claim(1), claim(2), claim(3), claim(10)], "me", NOW);
  assert.equal(until, new Date(NOW - 3 * HOUR + 24 * HOUR).toISOString());
});

test("old claims, other users, and lost-post reports don't count", () => {
  const responses = [claim(1), claim(2), claim(25), claim(3, { responder_id: "other" }), claim(4, { kind: "lost" })];
  assert.equal(claimBlockedUntil(responses, "me", NOW), null);
});
