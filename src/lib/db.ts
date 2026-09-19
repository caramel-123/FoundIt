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
