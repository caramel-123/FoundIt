// ─── Shared data types ────────────────────────────────────────────────────────
//
// Used by App.tsx and the data-access layer (lib/db.ts). Kept in step with the
// Supabase schema in supabase/migrations.

export type ItemStatus = "pending_intake" | "in_office" | "approved_for_pickup" | "released";
export type ClaimStatus = "pending_review" | "approved" | "rejected";

export interface Item {
  id: string;
  kind?: "found" | "lost"; // "lost" = owner-reported; shown in the catalog too. Defaults to found.
  finder_id: string;
  finder_name?: string;
  title: string;
  category: string;
  location_found: string;
  time_found: string;
  description: string;
  private_note?: string;
  status: ItemStatus;
  image_url?: string;
  upvotes: number;
  comments?: number;
  reposts?: number;
  created_at: string;
  challenge?: ChallengeQuestion[]; // optional Ownership Challenge (Requirement 16)
  pending_sync?: boolean; // client-only: logged offline, still in the queue (never sent to the db)
}


// ─── Ownership Challenge (Requirement 16) ───────────────────────────────────────

export interface ChallengeQuestion {
  id: string;
  prompt: string; // short-text question authored by the finder
}

export interface ChallengeAnswer {
  question_id: string;
  prompt: string;
  answer: string;
}

// "found" flow: someone claims a found item (responder answers finder's Qs).
// "lost" flow: someone found a lost-post item (finder authors Qs, owner answers).
export type ChallengeResponseStatus = "pending" | "approved" | "rejected" | "escalated" | "awaiting_owner" | "answered";

export interface ChallengeResponse {
  id: string;
  kind?: "found" | "lost"; // which flow; defaults to "found"
  item_id: string;
  finder_id?: string;     // who holds the item: the found post's poster, or the lost-flow reporter (stored for RLS)
  responder_id: string;   // found: the claimant; lost: the finder who reported
  responder_name: string;
  owner_id?: string;      // lost flow: the lost post's owner (who must answer)
  answers: ChallengeAnswer[];
  note?: string;          // finder's note (lost flow) / responder's note (found flow)
  owner_note?: string;    // lost flow: the owner's note back to the finder
  status: ChallengeResponseStatus;
  created_at: string;
}

// ─── Notifications (Requirement 18) ─────────────────────────────────────────────

export interface AppNotification {
  id: string;
  recipient_id: string;
  message: string;
  item_id?: string;       // post to open when clicked
  response_id?: string;   // related found/challenge report
  read: boolean;
  created_at: string;
}

export interface Claim {
  id: string;
  item_id: string;
  owner_id: string;
  owner_name: string;
  identifying_details: string;
  status: ClaimStatus;
  created_at: string;
  messages: ClaimMessage[];
}

export interface ClaimMessage {
  id: string;
  sender_id: string;
  sender_role: "owner" | "staff";
  message: string;
  created_at: string;
}

// A single recursive node type powers branching (nested) replies: every comment
// and every reply can itself be replied to, at arbitrary depth.
export interface CommentNode {
  id: string;
  author_id: string;
  author_name: string;
  message: string;
  created_at: string;
  visibility?: "public" | "private"; // private = only post author + commenter; defaults public
  replies: CommentNode[];
}

// Back-compat alias: the rest of the app refers to top-level nodes as ItemComment.
export type ItemComment = CommentNode;

// ─── Student verification (Requirement 15) ──────────────────────────────────────

export type VerificationStatus = "unverified" | "verified" | "rejected"; // AI-only, no "pending"
export type DocType = "student_id" | "cor" | "class_schedule";

export interface StudentVerification {
  user_id: string;
  user_name: string;
  status: VerificationStatus;
  doc_type?: DocType;
  extracted?: { name?: string; student_no?: string; school?: string; term_valid?: boolean };
  confidence?: number; // 0..1
  ai_verdict?: "pass" | "fail";
  submitted_at?: string;
  decided_at?: string;
  decided_by?: "ai";
}

export interface Repost {
  id: string;
  item_id: string;
  user_id: string;
  user_name: string;
  caption?: string;
  created_at: string;
}
