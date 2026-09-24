import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUE_KEY, readQueue, enqueue, removeFromQueue, replayQueue, type KeyValueStore, type SendResult } from "./offlineQueue.ts";

function memoryStore(initial?: string): KeyValueStore {
  const m = new Map<string, string>();
  if (initial !== undefined) m.set(QUEUE_KEY, initial);
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
type Entry = { id: string };

test("readQueue survives missing and malformed data", () => {
  assert.deepEqual(readQueue(memoryStore()), []);
  assert.deepEqual(readQueue(memoryStore("{not json")), []);
  assert.deepEqual(readQueue(memoryStore('{"a":1}')), []);
});

test("enqueue appends and replaces by id; removeFromQueue drops one", () => {
  const store = memoryStore();
  enqueue(store, { id: "a", v: 1 });
  enqueue(store, { id: "b", v: 1 });
  enqueue(store, { id: "a", v: 2 });
  assert.deepEqual(readQueue(store), [{ id: "b", v: 1 }, { id: "a", v: 2 }]);
  assert.deepEqual(removeFromQueue(store, "b"), [{ id: "a", v: 2 }]);
});

test("replayQueue sends in order, removes ok/failed, and stops at the first retry", async () => {
  const store = memoryStore();
  for (const id of ["a", "b", "c", "d"]) enqueue<Entry>(store, { id });
  const results: Record<string, SendResult> = { a: "ok", b: "failed", c: "retry", d: "ok" };
  const seen: string[] = [];
  const out = await replayQueue<Entry>(store, async e => { seen.push(e.id); return results[e.id]; });
  assert.deepEqual(seen, ["a", "b", "c"]); // d never overtakes c
  assert.deepEqual(out.sent.map(e => e.id), ["a"]);
  assert.deepEqual(out.failed.map(e => e.id), ["b"]);
  assert.deepEqual(out.remaining.map(e => e.id), ["c", "d"]);
});
