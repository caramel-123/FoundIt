// ─── Offline intake queue (Requirement 1.7–1.8) ────────────────────────────────
// Posts logged while offline wait here (in page storage) until they can be sent.
// Pure over a Storage-like object so it can be unit tested.

export const QUEUE_KEY = "foundit:v1:offlineQueue";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SendResult = "ok" | "retry" | "failed";

export function readQueue<T extends { id: string }>(store: KeyValueStore): T[] {
  try {
    const parsed = JSON.parse(store.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeQueue<T>(store: KeyValueStore, queue: T[]) {
  try {
    store.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota errors: nothing sensible to do; the in-memory copy still shows the post.
  }
}

/** Add (or replace, by id) an entry at the end of the queue. */
export function enqueue<T extends { id: string }>(store: KeyValueStore, entry: T): T[] {
  const next = [...readQueue<T>(store).filter(e => e.id !== entry.id), entry];
  writeQueue(store, next);
  return next;
}

export function removeFromQueue<T extends { id: string }>(store: KeyValueStore, id: string): T[] {
  const next = readQueue<T>(store).filter(e => e.id !== id);
  writeQueue(store, next);
  return next;
}

/**
 * Send queued entries oldest first. "ok" and "failed" remove the entry; "retry"
 * keeps it and stops, so later entries never overtake earlier ones.
 */
export async function replayQueue<T extends { id: string }>(
  store: KeyValueStore,
  send: (entry: T) => Promise<SendResult>,
): Promise<{ sent: T[]; failed: T[]; remaining: T[] }> {
  const sent: T[] = [];
  const failed: T[] = [];
  for (const entry of readQueue<T>(store)) {
    const result = await send(entry);
    if (result === "retry") break;
    removeFromQueue(store, entry.id);
    (result === "ok" ? sent : failed).push(entry);
  }
  return { sent, failed, remaining: readQueue<T>(store) };
}
