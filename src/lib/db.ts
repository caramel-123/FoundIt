// ─── Shared data-access layer (Phase 3) ────────────────────────────────────────
//
// Moves application data from per-browser localStorage into shared Supabase
// Postgres so all users see each other's posts. Migrated incrementally, one slice
// at a time — this file currently covers `items` (the catalog).
//
// When Supabase is NOT configured, `isDbEnabled` is false and callers fall back
// to their existing localStorage behavior, so local dev without env vars works.

import { supabase, isSupabaseConfigured } from "./supabase";

export const isDbEnabled = isSupabaseConfigured && supabase != null;

// The item shape shared with the app. Kept structurally in sync with the `Item`
// interface in App.tsx (duplicated here to avoid a circular import).
export interface DbChallengeQuestion {
  id: string;
  prompt: string;
}

export interface DbItem {
  id: string;
  kind?: "found" | "lost";
  finder_id: string;
  finder_name?: string;
  title: string;
  category: string;
  location_found: string;
  time_found: string;
  description: string;
  private_note?: string;
  status: "pending_intake" | "in_office" | "approved_for_pickup" | "released";
  image_url?: string;
  upvotes: number;
  challenge?: DbChallengeQuestion[];
  created_at: string;
}

// Map a DB row (snake_case, nullable) into a DbItem the app can use.
function rowToItem(row: Record<string, unknown>): DbItem {
  return {
    id: String(row.id),
    kind: (row.kind as DbItem["kind"]) ?? "found",
    finder_id: String(row.finder_id ?? ""),
    finder_name: (row.finder_name as string) ?? undefined,
    title: (row.title as string) ?? "",
    category: (row.category as string) ?? "",
    location_found: (row.location_found as string) ?? "",
    time_found: (row.time_found as string) ?? "",
    description: (row.description as string) ?? "",
    private_note: (row.private_note as string) ?? undefined,
    status: (row.status as DbItem["status"]) ?? "in_office",
    image_url: (row.image_url as string) ?? undefined,
    upvotes: typeof row.upvotes === "number" ? row.upvotes : 0,
    challenge: (row.challenge as DbChallengeQuestion[]) ?? undefined,
    created_at: (row.created_at as string) ?? new Date().toISOString(),
  };
}

/** Fetch all catalog items (newest first). Returns [] when the db is disabled. */
export async function listItems(): Promise<DbItem[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!
    .from("items")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("listItems failed:", error.message);
    return [];
  }
  return (data ?? []).map(r => rowToItem(r as Record<string, unknown>));
}

/** Insert a new item. Returns the created item, or null on failure. */
export async function createItem(item: DbItem): Promise<DbItem | null> {
  if (!isDbEnabled) return null;
  const { data, error } = await supabase!
    .from("items")
    .insert({
      id: item.id,
      kind: item.kind ?? "found",
      finder_id: item.finder_id,
      finder_name: item.finder_name ?? null,
      title: item.title,
      category: item.category,
      location_found: item.location_found,
      time_found: item.time_found || null,
      description: item.description,
      private_note: item.private_note ?? null,
      status: item.status,
      image_url: item.image_url ?? null,
      upvotes: item.upvotes ?? 0,
      challenge: item.challenge ?? null,
      created_at: item.created_at,
    })
    .select("*")
    .single();
  if (error) {
    console.warn("createItem failed:", error.message);
    return null;
  }
  return rowToItem(data as Record<string, unknown>);
}

/**
 * Subscribe to realtime item changes. Calls `onChange` with the full, refreshed
 * list whenever any row is inserted/updated/deleted. Returns an unsubscribe fn.
 */
export function subscribeItems(onChange: (items: DbItem[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:items")
    .on("postgres_changes", { event: "*", schema: "public", table: "items" }, async () => {
      onChange(await listItems());
    })
    .subscribe();
  return () => {
    supabase!.removeChannel(channel);
  };
}

// ─── Comments (branching tree, stored flat with parent_id) ──────────────────────

export interface DbCommentNode {
  id: string;
  author_id: string;
  author_name: string;
  message: string;
  created_at: string;
  replies: DbCommentNode[];
}

interface CommentRow {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string | null;
  message: string;
  created_at: string;
}

// Rebuild the per-post nested tree from flat rows.
function rowsToCommentMap(rows: CommentRow[]): Record<string, DbCommentNode[]> {
  const nodeById = new Map<string, DbCommentNode>();
  for (const r of rows) {
    nodeById.set(r.id, {
      id: r.id,
      author_id: r.author_id,
      author_name: r.author_name ?? "",
      message: r.message,
      created_at: r.created_at,
      replies: [],
    });
  }
  const byPost: Record<string, DbCommentNode[]> = {};
  // Sort oldest first so parents are placed before children reference them.
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of sorted) {
    const node = nodeById.get(r.id)!;
    if (r.parent_id && nodeById.has(r.parent_id)) {
      nodeById.get(r.parent_id)!.replies.push(node);
    } else {
      (byPost[r.post_id] ??= []).push(node);
    }
  }
  return byPost;
}

export async function listComments(): Promise<Record<string, DbCommentNode[]>> {
  if (!isDbEnabled) return {};
  const { data, error } = await supabase!.from("comments").select("*");
  if (error) { console.warn("listComments failed:", error.message); return {}; }
  return rowsToCommentMap((data ?? []) as CommentRow[]);
}

export async function insertComment(input: {
  id: string; post_id: string; parent_id: string | null;
  author_id: string; author_name: string; message: string; created_at: string;
}): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("comments").insert({
    id: input.id, post_id: input.post_id, parent_id: input.parent_id,
    author_id: input.author_id, author_name: input.author_name,
    message: input.message, created_at: input.created_at,
  });
  if (error) { console.warn("insertComment failed:", error.message); return false; }
  return true;
}

export function subscribeComments(onChange: (map: Record<string, DbCommentNode[]>) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:comments")
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, async () => {
      onChange(await listComments());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Reposts ─────────────────────────────────────────────────────────────────

export interface DbRepost {
  id: string;
  item_id: string;
  user_id: string;
  user_name: string;
  caption?: string;
  created_at: string;
}

export async function listReposts(): Promise<DbRepost[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("reposts").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listReposts failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), item_id: String(r.item_id), user_id: String(r.user_id),
    user_name: (r.user_name as string) ?? "", caption: (r.caption as string) ?? undefined,
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function upsertRepost(r: DbRepost): Promise<boolean> {
  if (!isDbEnabled) return false;
  // One repost per user per item: remove any existing, then insert.
  await supabase!.from("reposts").delete().eq("item_id", r.item_id).eq("user_id", r.user_id);
  const { error } = await supabase!.from("reposts").insert({
    id: r.id, item_id: r.item_id, user_id: r.user_id, user_name: r.user_name,
    caption: r.caption ?? null, created_at: r.created_at,
  });
  if (error) { console.warn("upsertRepost failed:", error.message); return false; }
  return true;
}

export async function removeRepost(itemId: string, userId: string): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("reposts").delete().eq("item_id", itemId).eq("user_id", userId);
  if (error) { console.warn("removeRepost failed:", error.message); return false; }
  return true;
}

export function subscribeReposts(onChange: (rows: DbRepost[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:reposts")
    .on("postgres_changes", { event: "*", schema: "public", table: "reposts" }, async () => {
      onChange(await listReposts());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Challenge responses ───────────────────────────────────────────────────────

export interface DbChallengeResponse {
  id: string;
  kind?: "found" | "lost";
  item_id: string;
  finder_id: string;
  responder_id: string;
  responder_name: string;
  owner_id?: string;
  answers: { question_id: string; prompt: string; answer: string }[];
  note?: string;
  owner_note?: string;
  status: "pending" | "approved" | "rejected" | "escalated" | "awaiting_owner" | "answered";
  created_at: string;
}

export async function listChallengeResponses(): Promise<DbChallengeResponse[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("challenge_responses").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listChallengeResponses failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), kind: (r.kind as DbChallengeResponse["kind"]) ?? "found",
    item_id: String(r.item_id), finder_id: String(r.finder_id),
    responder_id: String(r.responder_id), responder_name: (r.responder_name as string) ?? "",
    owner_id: (r.owner_id as string) ?? undefined,
    answers: (r.answers as DbChallengeResponse["answers"]) ?? [],
    note: (r.note as string) ?? undefined,
    owner_note: (r.owner_note as string) ?? undefined,
    status: (r.status as DbChallengeResponse["status"]) ?? "pending",
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function insertChallengeResponse(r: DbChallengeResponse): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("challenge_responses").insert({
    id: r.id, kind: r.kind ?? "found", item_id: r.item_id, finder_id: r.finder_id,
    responder_id: r.responder_id, responder_name: r.responder_name, owner_id: r.owner_id ?? null,
    answers: r.answers, note: r.note ?? null, status: r.status, created_at: r.created_at,
  });
  if (error) { console.warn("insertChallengeResponse failed:", error.message); return false; }
  return true;
}

export async function updateChallengeResponseStatus(id: string, status: DbChallengeResponse["status"]): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("challenge_responses").update({ status }).eq("id", id);
  if (error) { console.warn("updateChallengeResponseStatus failed:", error.message); return false; }
  return true;
}

// Owner submits answers to a found report (lost flow): fill answers + set status.
export async function updateChallengeResponseAnswers(
  id: string,
  answers: DbChallengeResponse["answers"],
  status: DbChallengeResponse["status"],
  ownerNote?: string,
): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!
    .from("challenge_responses")
    .update({ answers, status, owner_note: ownerNote ?? null })
    .eq("id", id);
  if (error) { console.warn("updateChallengeResponseAnswers failed:", error.message); return false; }
  return true;
}

export function subscribeChallengeResponses(onChange: (rows: DbChallengeResponse[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:challenge_responses")
    .on("postgres_changes", { event: "*", schema: "public", table: "challenge_responses" }, async () => {
      onChange(await listChallengeResponses());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Verifications ─────────────────────────────────────────────────────────────

export interface DbVerification {
  user_id: string;
  user_name: string;
  status: "unverified" | "verified" | "rejected";
  doc_type?: string;
  extracted?: unknown;
  confidence?: number;
  ai_verdict?: string;
  submitted_at?: string;
  decided_at?: string;
  decided_by?: string;
}

export async function listVerifications(): Promise<Record<string, DbVerification>> {
  if (!isDbEnabled) return {};
  const { data, error } = await supabase!.from("verifications").select("*");
  if (error) { console.warn("listVerifications failed:", error.message); return {}; }
  const map: Record<string, DbVerification> = {};
  for (const r of data ?? []) {
    const v = r as Record<string, unknown>;
    map[String(v.user_id)] = {
      user_id: String(v.user_id), user_name: (v.user_name as string) ?? "",
      status: (v.status as DbVerification["status"]) ?? "unverified",
      doc_type: (v.doc_type as string) ?? undefined,
      extracted: v.extracted ?? undefined,
      confidence: typeof v.confidence === "number" ? v.confidence : undefined,
      ai_verdict: (v.ai_verdict as string) ?? undefined,
      submitted_at: (v.submitted_at as string) ?? undefined,
      decided_at: (v.decided_at as string) ?? undefined,
      decided_by: (v.decided_by as string) ?? undefined,
    };
  }
  return map;
}

export async function upsertVerification(v: DbVerification): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("verifications").upsert({
    user_id: v.user_id, user_name: v.user_name, status: v.status,
    doc_type: v.doc_type ?? null, extracted: v.extracted ?? null,
    confidence: v.confidence ?? null, ai_verdict: v.ai_verdict ?? null,
    submitted_at: v.submitted_at ?? null, decided_at: v.decided_at ?? null,
    decided_by: v.decided_by ?? null,
  });
  if (error) { console.warn("upsertVerification failed:", error.message); return false; }
  return true;
}

export function subscribeVerifications(onChange: (map: Record<string, DbVerification>) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:verifications")
    .on("postgres_changes", { event: "*", schema: "public", table: "verifications" }, async () => {
      onChange(await listVerifications());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Notifications (Requirement 18) ─────────────────────────────────────────────

export interface DbNotification {
  id: string;
  recipient_id: string;
  message: string;
  item_id?: string;
  response_id?: string;
  read: boolean;
  created_at: string;
}

export async function listNotifications(): Promise<DbNotification[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("notifications").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listNotifications failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), recipient_id: String(r.recipient_id), message: (r.message as string) ?? "",
    item_id: (r.item_id as string) ?? undefined, response_id: (r.response_id as string) ?? undefined,
    read: Boolean(r.read), created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function insertNotification(n: DbNotification): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("notifications").insert({
    id: n.id, recipient_id: n.recipient_id, message: n.message,
    item_id: n.item_id ?? null, response_id: n.response_id ?? null,
    read: n.read, created_at: n.created_at,
  });
  if (error) { console.warn("insertNotification failed:", error.message); return false; }
  return true;
}

export async function markNotificationsReadDb(recipientId: string): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("notifications").update({ read: true }).eq("recipient_id", recipientId).eq("read", false);
  if (error) { console.warn("markNotificationsReadDb failed:", error.message); return false; }
  return true;
}

export function subscribeNotifications(onChange: (rows: DbNotification[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:notifications")
    .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, async () => {
      onChange(await listNotifications());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}
