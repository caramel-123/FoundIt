import { test } from "node:test";
import assert from "node:assert/strict";
import { localParse } from "./captionHeuristic.ts";

test("uses the first line as the title and keeps the full text as description", () => {
  const caption = "FOUND: black earbuds\nFound near Library 2F this morning.";
  const parsed = localParse(caption);
  assert.equal(parsed.title, "FOUND: black earbuds");
  assert.equal(parsed.description, caption);
});

test("maps keywords to the app's categories", () => {
  assert.equal(localParse("Found a blue hydro flask").category, "Water Bottle");
  assert.equal(localParse("Someone left their keychain").category, "Keys");
  assert.equal(localParse("nothing recognizable here").category, "");
});

test("prefers an explicit location line, then 'found at/near' cues", () => {
  assert.equal(localParse("Wallet\nLocation: Gym lobby\nCall me").location_found, "Gym lobby");
  assert.equal(localParse("Found at Main Hall, second floor").location_found, "Main Hall");
});
