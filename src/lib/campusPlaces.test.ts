import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMPUS_PLACES, matchPlaces } from "./campusPlaces.ts";

test("has the 50 places from the vicinity map legend", () => {
  assert.equal(CAMPUS_PLACES.length, 50);
  assert.equal(CAMPUS_PLACES[13], "Main Academic Building"); // #14
  assert.equal(CAMPUS_PLACES[29], "Ninoy Aquino Learning Resource Center"); // #30
});

test("empty query returns places in map order", () => {
  assert.deepEqual(matchPlaces("", 3), ["The Pylon", "The Mural", "Visitor's Lounge"]);
});

test("matching is case-insensitive and prefers word starts", () => {
  const r = matchPlaces("park");
  assert.ok(r.includes("Lagoon Park") && r.includes("Linear Park"));
  assert.deepEqual(matchPlaces("LEARN"), ["Ninoy Aquino Learning Resource Center"]);
  // "tennis" matches word starts in two places
  assert.deepEqual(matchPlaces("tennis"), ["Lawn Tennis Court", "NDC Tennis Court and Club House"]);
  assert.deepEqual(matchPlaces("zzz"), []);
});
