import { test } from "node:test";
import assert from "node:assert/strict";
import { localParse, splitCaption, joinCaption } from "./captionHeuristic.ts";

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

test("splitCaption uses the first non-empty line as the title", () => {
  assert.deepEqual(splitCaption("\n  Found: black earbuds  \nNear Library 2F.\nCase is scratched."), {
    title: "Found: black earbuds",
    description: "Near Library 2F.\nCase is scratched.",
  });
  assert.deepEqual(splitCaption("Just a title"), { title: "Just a title", description: "" });
  assert.deepEqual(splitCaption("   \n  "), { title: "", description: "" });
});

test("joinCaption doesn't repeat the title and round-trips through splitCaption", () => {
  const caption = joinCaption("Found: wallet", "Found: wallet\nBrown leather, near the gym.");
  assert.equal(caption, "Found: wallet\nBrown leather, near the gym.");
  assert.deepEqual(splitCaption(caption), { title: "Found: wallet", description: "Brown leather, near the gym." });
  assert.equal(joinCaption("", "Only description"), "Only description");
});
