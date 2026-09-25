// ─── Shared data-access layer (Phase 3) ────────────────────────────────────────
//
// Moves application data from per-browser localStorage into shared Supabase
// Postgres so all users see each other's posts. Migrated incrementally, one slice
// at a time; every slice now lives here (items through claims and upvotes).
//
// When Supabase is NOT configured, `isDbEnabled` is false and callers fall back
// to their existing localStorage behavior, so local dev without env vars works.

import { supabase, isSupabaseConfigured } from "./supabase";
import type {
  Item, ChallengeQuestion, CommentNode, Repost, ChallengeResponse,
  StudentVerification, AppNotification, Claim, ClaimMessage,
} from "../types";
import { rowsToCommentMap, type CommentRow } from "./comments";

export const isDbEnabled = isSupabaseConfigured && supabase != null;

// Map a DB row (snake_case, nullable) into a Item the app can use.
function rowToItem(row: Record<string, unknown>): Item {
  return {
    id: String(row.id),
    kind: (row.kind as Item["kind"]) ?? "found",
    finder_id: String(row.finder_id ?? ""),
    finder_name: (row.finder_name as string) ?? undefined,
    title: (row.title as string) ?? "",
    category: (row.category as string) ?? "",
    location_found: (row.location_found as string) ?? "",
    time_found: (row.time_found as string) ?? "",
    description: (row.description as string) ?? "",
    private_note: (row.private_note as string) ?? undefined,
    status: (row.status as Item["status"]) ?? "in_office",
    image_url: (row.image_url as string) ?? undefined,
    upvotes: typeof row.upvotes === "number" ? row.upvotes : 0,
    challenge: (row.challenge as ChallengeQuestion[]) ?? undefined,
    created_at: (row.created_at as string) ?? new Date().toISOString(),
  };
}

/** Fetch all catalog items (newest first). Returns [] when the db is disabled. */
export async function listItems(): Promise<Item[]> {
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

/**
 * Insert a new item. "retry" means the network failed (safe to queue and resend);
 * "failed" means the server rejected it. A duplicate id means an earlier attempt
 * already landed, so it counts as "ok".
 */
export async function createItem(item: Item): Promise<"ok" | "retry" | "failed"> {
  if (!isDbEnabled) return "failed";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "retry";
  let error: { message: string; code?: string } | null;
  try {
    ({ error } = await supabase!
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
    }));
  } catch {
    return "retry";
  }
  if (!error) return "ok";
  if (error.code === "23505") return "ok";
  if (/fetch|network|timeout/i.test(error.message) || !error.code) return "retry";
  console.warn("createItem failed:", error.message);
  return "failed";
}

/**
 * Subscribe to realtime item changes. Calls `onChange` with the full, refreshed
 * list whenever any row is inserted/updated/deleted. Returns an unsubscribe fn.
 */
export function subscribeItems(onChange: (items: Item[]) => void): () => void {
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

export async function listComments(): Promise<Record<string, CommentNode[]>> {
  if (!isDbEnabled) return {};
  const { data, error } = await supabase!.from("comments").select("*");
  if (error) { console.warn("listComments failed:", error.message); return {}; }
  return rowsToCommentMap((data ?? []) as CommentRow[]);
}

export async function insertComment(input: {
  id: string; post_id: string; parent_id: string | null;
  author_id: string; author_name: string; message: string; created_at: string;
  visibility?: "public" | "private";
}): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("comments").insert({
    id: input.id, post_id: input.post_id, parent_id: input.parent_id,
    author_id: input.author_id, author_name: input.author_name,
    message: input.message, visibility: input.visibility ?? "public",
    created_at: input.created_at,
  });
  if (error) { console.warn("insertComment failed:", error.message); return false; }
  return true;
}

export function subscribeComments(onChange: (map: Record<string, CommentNode[]>) => void): () => void {
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

export async function listReposts(): Promise<Repost[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("reposts").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listReposts failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), item_id: String(r.item_id), user_id: String(r.user_id),
    user_name: (r.user_name as string) ?? "", caption: (r.caption as string) ?? undefined,
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function upsertRepost(r: Repost): Promise<boolean> {
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

export function subscribeReposts(onChange: (rows: Repost[]) => void): () => void {
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

export async function listChallengeResponses(): Promise<ChallengeResponse[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("challenge_responses").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listChallengeResponses failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), kind: (r.kind as ChallengeResponse["kind"]) ?? "found",
    item_id: String(r.item_id), finder_id: String(r.finder_id),
    responder_id: String(r.responder_id), responder_name: (r.responder_name as string) ?? "",
    owner_id: (r.owner_id as string) ?? undefined,
    answers: (r.answers as ChallengeResponse["answers"]) ?? [],
    note: (r.note as string) ?? undefined,
    owner_note: (r.owner_note as string) ?? undefined,
    status: (r.status as ChallengeResponse["status"]) ?? "pending",
    created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function insertChallengeResponse(r: ChallengeResponse): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("challenge_responses").insert({
    id: r.id, kind: r.kind ?? "found", item_id: r.item_id, finder_id: r.finder_id ?? "",
    responder_id: r.responder_id, responder_name: r.responder_name, owner_id: r.owner_id ?? null,
    answers: r.answers, note: r.note ?? null, status: r.status, created_at: r.created_at,
  });
  if (error) { console.warn("insertChallengeResponse failed:", error.message); return false; }
  return true;
}

export async function updateChallengeResponseStatus(id: string, status: ChallengeResponse["status"]): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("challenge_responses").update({ status }).eq("id", id);
  if (error) { console.warn("updateChallengeResponseStatus failed:", error.message); return false; }
  return true;
}

// Owner submits answers to a found report (lost flow): fill answers + set status.
export async function updateChallengeResponseAnswers(
  id: string,
  answers: ChallengeResponse["answers"],
  status: ChallengeResponse["status"],
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

export function subscribeChallengeResponses(onChange: (rows: ChallengeResponse[]) => void): () => void {
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

export async function listVerifications(): Promise<Record<string, StudentVerification>> {
  if (!isDbEnabled) return {};
  const { data, error } = await supabase!.from("verifications").select("*");
  if (error) { console.warn("listVerifications failed:", error.message); return {}; }
  const map: Record<string, StudentVerification> = {};
  for (const r of data ?? []) {
    const v = r as Record<string, unknown>;
    map[String(v.user_id)] = {
      user_id: String(v.user_id), user_name: (v.user_name as string) ?? "",
      status: (v.status as StudentVerification["status"]) ?? "unverified",
      doc_type: (v.doc_type as StudentVerification["doc_type"]) ?? undefined,
      extracted: (v.extracted as StudentVerification["extracted"]) ?? undefined,
      confidence: typeof v.confidence === "number" ? v.confidence : undefined,
      ai_verdict: (v.ai_verdict as StudentVerification["ai_verdict"]) ?? undefined,
      submitted_at: (v.submitted_at as string) ?? undefined,
      decided_at: (v.decided_at as string) ?? undefined,
      decided_by: (v.decided_by as StudentVerification["decided_by"]) ?? undefined,
    };
  }
  return map;
}

export async function upsertVerification(v: StudentVerification): Promise<boolean> {
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

export function subscribeVerifications(onChange: (map: Record<string, StudentVerification>) => void): () => void {
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

export async function listNotifications(): Promise<AppNotification[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("notifications").select("*").order("created_at", { ascending: false });
  if (error) { console.warn("listNotifications failed:", error.message); return []; }
  return (data ?? []).map(r => ({
    id: String(r.id), recipient_id: String(r.recipient_id), message: (r.message as string) ?? "",
    item_id: (r.item_id as string) ?? undefined, response_id: (r.response_id as string) ?? undefined,
    read: Boolean(r.read), created_at: (r.created_at as string) ?? new Date().toISOString(),
  }));
}

export async function insertNotification(n: AppNotification): Promise<boolean> {
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

export function subscribeNotifications(onChange: (rows: AppNotification[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:notifications")
    .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, async () => {
      onChange(await listNotifications());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Item status (staff) ──────────────────────────────────────────────────────

export async function updateItemStatus(id: string, status: Item["status"]): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("items").update({ status }).eq("id", id);
  if (error) { console.warn("updateItemStatus failed:", error.message); return false; }
  return true;
}

// ─── Claims + private claim threads ───────────────────────────────────────────

/** RLS returns only the caller's own claims, or every claim for staff. */
export async function listClaims(): Promise<Claim[]> {
  if (!isDbEnabled) return [];
  const [claimsRes, msgsRes] = await Promise.all([
    supabase!.from("claims").select("*").order("created_at", { ascending: true }),
    supabase!.from("claim_messages").select("*").order("created_at", { ascending: true }),
  ]);
  if (claimsRes.error) { console.warn("listClaims failed:", claimsRes.error.message); return []; }
  const byClaim: Record<string, ClaimMessage[]> = {};
  for (const m of msgsRes.data ?? []) {
    (byClaim[String(m.claim_id)] ??= []).push({
      id: String(m.id), sender_id: String(m.sender_id),
      sender_role: m.sender_role as ClaimMessage["sender_role"],
      message: String(m.message), created_at: String(m.created_at),
    });
  }
  return (claimsRes.data ?? []).map(c => ({
    id: String(c.id), item_id: String(c.item_id), owner_id: String(c.owner_id),
    owner_name: (c.owner_name as string) ?? "",
    identifying_details: String(c.identifying_details ?? ""),
    status: c.status as Claim["status"],
    created_at: String(c.created_at),
    messages: byClaim[String(c.id)] ?? [],
  }));
}

/** Returns "rate_limited" when the server's 3-per-24h trigger rejects the insert. */
export async function createClaim(c: Claim): Promise<"ok" | "rate_limited" | "failed"> {
  if (!isDbEnabled) return "failed";
  const { error } = await supabase!.from("claims").insert({
    id: c.id, item_id: c.item_id, owner_id: c.owner_id, owner_name: c.owner_name,
    identifying_details: c.identifying_details, status: "pending_review",
  });
  if (!error) return "ok";
  if (error.message.includes("claim_rate_limited")) return "rate_limited";
  console.warn("createClaim failed:", error.message);
  return "failed";
}

export async function updateClaimStatus(id: string, status: Claim["status"]): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("claims").update({ status }).eq("id", id);
  if (error) { console.warn("updateClaimStatus failed:", error.message); return false; }
  return true;
}

export async function insertClaimMessage(claimId: string, m: ClaimMessage): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("claim_messages").insert({
    id: m.id, claim_id: claimId, sender_id: m.sender_id, sender_role: m.sender_role,
    message: m.message, created_at: m.created_at,
  });
  if (error) { console.warn("insertClaimMessage failed:", error.message); return false; }
  return true;
}

/** Finder hands a challenge response to staff; the server creates the claim. */
export async function escalateChallengeResponse(responseId: string, claimId: string): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.rpc("escalate_challenge_response", {
    p_response_id: responseId, p_claim_id: claimId,
  });
  if (error) { console.warn("escalateChallengeResponse failed:", error.message); return false; }
  return true;
}

export function subscribeClaims(onChange: (rows: Claim[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const refresh = async () => onChange(await listClaims());
  const channel = supabase!
    .channel("public:claims")
    .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "claim_messages" }, refresh)
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Upvotes (one row per user per post) ──────────────────────────────────────

export interface DbUpvote {
  post_id: string;
  user_id: string;
}

export async function listUpvotes(): Promise<DbUpvote[]> {
  if (!isDbEnabled) return [];
  const { data, error } = await supabase!.from("upvotes").select("post_id, user_id");
  if (error) { console.warn("listUpvotes failed:", error.message); return []; }
  return (data ?? []).map(r => ({ post_id: String(r.post_id), user_id: String(r.user_id) }));
}

export async function setUpvote(postId: string, userId: string, on: boolean): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = on
    ? await supabase!.from("upvotes").insert({ post_id: postId, user_id: userId })
    : await supabase!.from("upvotes").delete().eq("post_id", postId).eq("user_id", userId);
  if (error) { console.warn("setUpvote failed:", error.message); return false; }
  return true;
}

export function subscribeUpvotes(onChange: (rows: DbUpvote[]) => void): () => void {
  if (!isDbEnabled) return () => {};
  const channel = supabase!
    .channel("public:upvotes")
    .on("postgres_changes", { event: "*", schema: "public", table: "upvotes" }, async () => {
      onChange(await listUpvotes());
    })
    .subscribe();
  return () => { supabase!.removeChannel(channel); };
}

// ─── Profiles (name + Google photo, so others can see them) ───────────────────

export interface DbProfile {
  id: string;
  name: string;
  avatar_url?: string;
}

export async function upsertProfile(p: DbProfile): Promise<boolean> {
  if (!isDbEnabled) return false;
  const { error } = await supabase!.from("profiles").upsert({
    id: p.id, name: p.name, avatar_url: p.avatar_url ?? null, updated_at: new Date().toISOString(),
  });
  if (error) { console.warn("upsertProfile failed:", error.message); return false; }
  return true;
}

export async function listProfiles(): Promise<Record<string, DbProfile>> {
  if (!isDbEnabled) return {};
  const { data, error } = await supabase!.from("profiles").select("id, name, avatar_url");
  if (error) { console.warn("listProfiles failed:", error.message); return {}; }
  const map: Record<string, DbProfile> = {};
  for (const r of data ?? []) {
    map[String(r.id)] = { id: String(r.id), name: (r.name as string) ?? "", avatar_url: (r.avatar_url as string) ?? undefined };
  }
  return map;
}
