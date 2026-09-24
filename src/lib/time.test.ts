import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeDate, postedLabel } from "./time.ts";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test("relativeDate buckets minutes, hours, days", () => {
  assert.equal(relativeDate(ago(30_000), NOW), "just now");
  assert.equal(relativeDate(ago(5 * MIN), NOW), "5m ago");
  assert.equal(relativeDate(ago(3 * HOUR), NOW), "3h ago");
  assert.equal(relativeDate(ago(12 * DAY), NOW), "12d ago");
});

test("postedLabel is relative up to 7 days, then a full date", () => {
  assert.equal(postedLabel(ago(7 * DAY), NOW), "7d ago");
  assert.equal(postedLabel("2026-09-14T12:00:00Z", NOW), "Sep 14, 2026");
});
