import { useState, useRef, useEffect } from "react";
import type { ReactElement } from "react";
import type { AuthState, AuthUser, Role } from "./lib/auth";
import { getSession, signInWithGoogle, signOut, onAuthChange } from "./lib/auth";
import { parseCaption } from "./lib/captionImport";

// ─── Types ────────────────────────────────────────────────────────────────────

type ItemStatus = "pending_intake" | "in_office" | "approved_for_pickup" | "released";
type ClaimStatus = "pending_review" | "approved" | "rejected";

interface Item {
  id: string;
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
}

interface Claim {
  id: string;
  item_id: string;
  owner_id: string;
  owner_name: string;
  identifying_details: string;
  status: ClaimStatus;
  created_at: string;
  messages: ClaimMessage[];
}

interface ClaimMessage {
  id: string;
  sender_id: string;
  sender_role: "owner" | "staff";
  message: string;
  created_at: string;
}

interface MissingNotice {
  id: string;
  owner_id: string;
  description: string;
  location_lost: string;
  time_lost: string;
  created_at: string;
}

interface CommentReply {
  id: string;
  author_id: string;
  author_name: string;
  message: string;
  created_at: string;
}

interface ItemComment {
  id: string;
  author_id: string;
  author_name: string;
  message: string;
  created_at: string;
  replies: CommentReply[];
}

interface Repost {
  id: string;
  item_id: string;
  user_id: string;
  user_name: string;
  caption?: string;
  created_at: string;
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

// No seeded data — items, claims, and missing notices are created by the
// signed-in user at runtime. (In-memory only; resets on reload until the
// Supabase data layer lands.)
const MOCK_ITEMS: Item[] = [];
const MOCK_CLAIMS: Claim[] = [];
const MOCK_MISSING: MissingNotice[] = [];

const CATEGORIES = ["All", "Electronics", "ID / Card", "Bag / Backpack", "Keys", "Clothing", "Wallet / Purse", "Water Bottle", "Books / Notes", "Other"];

// Display names for finders (by user id). Populated at runtime as posts are
// created; empty by default (no seeded users).
const USER_NAMES: Record<string, string> = {};
function userName(id: string) {
  return USER_NAMES[id] || "Campus member";
}
function initials(name: string) {
  return name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
}
// Deterministic accent color per user id so avatars stay consistent
const AVATAR_COLORS = ["#9A3F3F", "#7A3A1A", "#5C2020", "#C1856D", "#7A2E2E", "#6B3A3A"];
function avatarColor(id: string) {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}
function Avatar({ id, name: nameProp, size = 32 }: { id: string; name?: string; size?: number }) {
  const name = nameProp || userName(id);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full shrink-0 font-semibold"
      style={{ width: size, height: size, background: avatarColor(id), color: "#FBF9D1", fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function relativeDate(iso: string) {
  const now = new Date("2026-09-12T12:00:00Z").getTime();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
// Relative label up to 7 days, then falls back to the full date (e.g. "Sep 14, 2026")
function postedLabel(iso: string) {
  const now = new Date("2026-09-12T12:00:00Z").getTime();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return formatDate(iso);
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<ItemStatus, string> = {
  pending_intake: "Pending Intake",
  in_office: "In Office",
  approved_for_pickup: "Approved for Pickup",
  released: "Released",
};

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending_review: "Under Review",
  approved: "Approved",
  rejected: "Rejected",
};

// Small status icons (14px) for the status badge
function IconArchive() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3" width="22" height="5" rx="1"/>
      <path d="M3 8v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8"/>
      <line x1="10" y1="12" x2="14" y2="12"/>
    </svg>
  );
}
function IconOffice() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18"/>
      <path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/>
      <path d="M15 9h4a2 2 0 0 1 2 2v10"/>
      <line x1="9" y1="7" x2="9" y2="7"/><line x1="9" y1="11" x2="9" y2="11"/><line x1="9" y1="15" x2="9" y2="15"/>
    </svg>
  );
}
function IconBag() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  );
}
function IconCheckCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

const STATUS_ICONS: Record<ItemStatus, () => ReactElement> = {
  pending_intake: IconArchive,
  in_office: IconOffice,
  approved_for_pickup: IconBag,
  released: IconCheckCircle,
};

function StatusBadge({ status }: { status: ItemStatus }) {
  const styles: Record<ItemStatus, { bg: string; text: string; dot: string; border: string }> = {
    pending_intake: { bg: "#FDF3EC", text: "#7A3A1A", dot: "#C1856D", border: "#E8C4AD" },
    in_office: { bg: "#F2EBE5", text: "#5C2020", dot: "#9A3F3F", border: "#D4A896" },
    approved_for_pickup: { bg: "#F5ECEC", text: "#9A3F3F", dot: "#9A3F3F", border: "#C1856D" },
    released: { bg: "#F5F3E8", text: "#9A7070", dot: "#C1856D", border: "#E6CFA9" },
  };
  const s = styles[status];
  const Icon = STATUS_ICONS[status];
  return (
    <span
      className="inline-flex items-center"
      style={{ color: s.text }}
      title={STATUS_LABELS[status]}
      aria-label={STATUS_LABELS[status]}
    >
      <Icon />
    </span>
  );
}

function ClaimBadge({ status }: { status: ClaimStatus }) {
  const styles: Record<ClaimStatus, { bg: string; text: string; border: string }> = {
    pending_review: { bg: "#FDF3EC", text: "#7A3A1A", border: "#E8C4AD" },
    approved: { bg: "#F2EBE5", text: "#5C2020", border: "#C1856D" },
    rejected: { bg: "#F5ECEC", text: "#9A3F3F", border: "#C1856D" },
  };
  const s = styles[status];
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border" style={{ background: s.bg, color: s.text, borderColor: s.border }}>
      {CLAIM_STATUS_LABELS[status]}
    </span>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconCamera() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function IconMenu() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  );
}

function IconFilter() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function IconMapPin() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  );
}

function IconChevronUp({ filled }: { filled?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15"/>
    </svg>
  );
}

function IconComment() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
  );
}

function IconRepost() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  );
}

function IconShare() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
      <polyline points="16 6 12 2 8 6"/>
      <line x1="12" y1="2" x2="12" y2="15"/>
    </svg>
  );
}

function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function IconInbox() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
    </svg>
  );
}

function IconWifi() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
      <line x1="12" y1="20" x2="12.01" y2="20"/>
    </svg>
  );
}

// ─── Input styles (shared) ────────────────────────────────────────────────────

const inputCls = "w-full px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:ring-2 border"
  + " bg-[#FBF9D1] border-[#C1856D] text-[#2C1414] placeholder:text-[#9A7070]"
  + " focus:ring-[#9A3F3F] focus:border-[#9A3F3F]";

const btnPrimary = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors text-[#FBF9D1] bg-[#9A3F3F] hover:bg-[#7A2E2E]";
const btnSecondary = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors border border-[#C1856D] text-[#9A3F3F] hover:bg-[#F5ECEC]";

// ─── Post Actions (shared by item cards and repost cards) ───────────────────────

// A reusable action row (upvote / comment / repost / share) plus an inline
// comment thread, keyed by a generic post id so both items and reposts can carry
// their own independent engagement. `repostItem` is the item that the Repost
// action targets (the underlying original for a reposted card).
function PostActions({
  postId, baseUpvotes, upvoted, onUpvote,
  comments, onAddComment, onAddReply,
  repostItem, onRepost, reposted, repostCount,
  onShare, extra,
}: {
  postId: string;
  baseUpvotes: number;
  upvoted?: boolean;
  onUpvote?: (id: string) => void;
  comments: ItemComment[];
  onAddComment?: (postId: string, message: string) => void;
  onAddReply?: (postId: string, commentId: string, message: string) => void;
  repostItem: Item;
  onRepost?: (item: Item) => void;
  reposted?: boolean;
  repostCount?: number;
  onShare?: (item: Item) => Promise<boolean>;
  extra?: ReactElement | null;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const commentCount = comments.length + comments.reduce((n, c) => n + c.replies.length, 0);

  async function handleShareClick() {
    const ok = onShare ? await onShare(repostItem) : false;
    setShareMsg(ok ? "Link copied" : "Copy failed — try again");
    setTimeout(() => setShareMsg(null), 2000);
  }
  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentDraft.trim()) return;
    onAddComment?.(postId, commentDraft);
    setCommentDraft("");
  }
  function submitReply(e: React.FormEvent, commentId: string) {
    e.preventDefault();
    if (!replyDraft.trim()) return;
    onAddReply?.(postId, commentId, replyDraft);
    setReplyDraft("");
    setReplyingTo(null);
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onUpvote?.(postId)}
          className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors"
          style={{ background: "#F5ECEC", color: upvoted ? "#9A3F3F" : "#6B3A3A" }}
        >
          <IconChevronUp filled={upvoted} />
          <span>{baseUpvotes + (upvoted ? 1 : 0)}</span>
        </button>

        <button
          onClick={() => setShowComments(s => !s)}
          className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors"
          style={{ background: "#F5ECEC", color: showComments ? "#9A3F3F" : "#6B3A3A" }}
          aria-label="Comments"
          aria-expanded={showComments}
        >
          <IconComment />
          <span>{commentCount}</span>
        </button>

        <button
          onClick={() => onRepost?.(repostItem)}
          className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors"
          style={{ background: "#F5ECEC", color: reposted ? "#9A3F3F" : "#6B3A3A" }}
          aria-label="Repost"
          aria-pressed={reposted}
          title={reposted ? "You reposted this" : "Repost"}
        >
          <IconRepost />
          <span>{(repostItem.reposts ?? 0) + (repostCount ?? 0)}</span>
        </button>

        <button
          onClick={handleShareClick}
          className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors"
          style={{ background: "#F5ECEC", color: "#6B3A3A" }}
          aria-label="Share"
          title="Share"
        >
          <IconShare />
        </button>

        {shareMsg && <span className="text-xs font-medium" style={{ color: "#9A3F3F" }}>{shareMsg}</span>}

        {extra}
      </div>

      {showComments && (
        <div className="pt-1" style={{ borderTop: "1px solid #C1856D" }}>
          {comments.length === 0 ? (
            <p className="text-xs py-2" style={{ color: "#9A7070" }}>No comments yet. Be the first to comment.</p>
          ) : (
            <div className="flex flex-col gap-2 py-2">
              {comments.map(c => (
                <div key={c.id} className="flex gap-2">
                  <Avatar id={c.author_id} name={c.author_name} size={20} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{c.author_name}</span>
                      <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(c.created_at)}</span>
                    </div>
                    <p className="text-sm leading-snug" style={{ color: "#2C1414" }}>{c.message}</p>
                    <button
                      type="button"
                      onClick={() => { setReplyingTo(replyingTo === c.id ? null : c.id); setReplyDraft(""); }}
                      className="text-xs font-medium mt-0.5 hover:underline"
                      style={{ color: "#9A3F3F" }}
                    >
                      Reply
                    </button>
                    {c.replies.length > 0 && (
                      <div className="flex flex-col gap-2 mt-2 pl-3" style={{ borderLeft: "2px solid #C1856D" }}>
                        {c.replies.map(r => (
                          <div key={r.id} className="flex gap-2">
                            <Avatar id={r.author_id} name={r.author_name} size={18} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{r.author_name}</span>
                                <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(r.created_at)}</span>
                              </div>
                              <p className="text-sm leading-snug" style={{ color: "#2C1414" }}>{r.message}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {replyingTo === c.id && (
                      <form onSubmit={e => submitReply(e, c.id)} className="flex items-center gap-2 mt-2">
                        <input
                          type="text"
                          value={replyDraft}
                          onChange={e => setReplyDraft(e.target.value)}
                          placeholder={`Reply to ${c.author_name}…`}
                          autoFocus
                          className="flex-1 px-3 py-1.5 text-sm rounded-lg border focus:outline-none focus:ring-2"
                          style={{ background: "#FBF9D1", borderColor: "#C1856D", color: "#2C1414" }}
                        />
                        <button type="submit" disabled={!replyDraft.trim()} className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
                          Reply
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={submitComment} className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={commentDraft}
              onChange={e => setCommentDraft(e.target.value)}
              placeholder="Add a comment…"
              className="flex-1 px-3 py-1.5 text-sm rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: "#FBF9D1", borderColor: "#C1856D", color: "#2C1414" }}
            />
            <button type="submit" disabled={!commentDraft.trim()} className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
              Post
            </button>
          </form>
        </div>
      )}
    </>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({ item, onClaim, onUpvote, upvoted, onRepost, reposted, repostCount, onShare, comments, onAddComment, onAddReply, role }: {
  item: Item;
  onClaim?: (item: Item) => void;
  onUpvote?: (id: string) => void;
  upvoted?: boolean;
  onRepost?: (item: Item) => void;
  reposted?: boolean;
  repostCount?: number;
  onShare?: (item: Item) => Promise<boolean>;
  comments?: ItemComment[];
  onAddComment?: (itemId: string, message: string) => void;
  onAddReply?: (itemId: string, commentId: string, message: string) => void;
  role: Role;
}) {
  const commentList = comments ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-xl p-4 transition-shadow duration-200 hover:shadow-md"
      style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>

      <div className="flex gap-4">
      {/* Content */}
      <div className="flex flex-col gap-2 flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Avatar id={item.finder_id} name={item.finder_name} size={20} />
          <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{item.finder_name || userName(item.finder_id)}</span>
          <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(item.created_at)}</span>
          <StatusBadge status={item.status} />
        </div>

        <h3 className="text-base font-semibold leading-snug" style={{ color: "#2C1414" }}>{item.title}</h3>
        <p className="text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>{item.description}</p>

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "#6B3A3A" }}>
            <IconMapPin /><span className="truncate">{item.location_found}</span>
          </div>
        </div>
      </div>

      {/* Thumbnail */}
      {item.image_url && (
        <div className="shrink-0 w-24 h-24 rounded-lg overflow-hidden" style={{ background: "#D4B890" }}>
          <img src={item.image_url} alt={item.description} className="w-full h-full object-cover" />
        </div>
      )}
      </div>

      {/* Action row + comment thread (shared component) */}
      <PostActions
        postId={item.id}
        baseUpvotes={item.upvotes}
        upvoted={upvoted}
        onUpvote={onUpvote}
        comments={commentList}
        onAddComment={onAddComment}
        onAddReply={onAddReply}
        repostItem={item}
        onRepost={onRepost}
        reposted={reposted}
        repostCount={repostCount}
        onShare={onShare}
        extra={
          role !== "staff" && item.status === "in_office" && onClaim ? (
            <button
              onClick={() => onClaim(item)}
              className="ml-auto px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
              style={{ background: "#9A3F3F", color: "#FBF9D1" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
              onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
            >
              Claim this item
            </button>
          ) : item.status === "approved_for_pickup" ? (
            <span className="ml-auto text-xs font-medium flex items-center gap-1" style={{ color: "#9A3F3F" }}>
              <IconShield /> Pickup approved
            </span>
          ) : null
        }
      />
    </div>
  );
}

// ─── Repost Card (feed + timeline) ──────────────────────────────────────────

// Compact quoted version of an item, shown inside a repost.
function QuotedItem({ item }: { item: Item }) {
  return (
    <div className="rounded-lg p-3 flex gap-3" style={{ background: "#FBF9D1", border: "1px solid #C1856D" }}>
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Avatar id={item.finder_id} name={item.finder_name} size={18} />
          <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{item.finder_name || userName(item.finder_id)}</span>
          <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(item.created_at)}</span>
        </div>
        <p className="text-sm font-semibold leading-snug" style={{ color: "#2C1414" }}>{item.title}</p>
        <p className="text-xs leading-snug line-clamp-2" style={{ color: "#6B3A3A" }}>{item.description}</p>
        <span className="flex items-center gap-1 text-xs" style={{ color: "#6B3A3A" }}><IconMapPin />{item.location_found}</span>
      </div>
      {item.image_url && (
        <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden" style={{ background: "#D4B890" }}>
          <img src={item.image_url} alt={item.description} className="w-full h-full object-cover" />
        </div>
      )}
    </div>
  );
}

function RepostCard({ repost, item, onRemove, actions }: {
  repost: Repost;
  item: Item;
  onRemove?: () => void;
  actions?: {
    upvoted?: boolean;
    onUpvote?: (id: string) => void;
    comments: ItemComment[];
    onAddComment?: (postId: string, message: string) => void;
    onAddReply?: (postId: string, commentId: string, message: string) => void;
    onRepost?: (item: Item) => void;
    reposted?: boolean;
    repostCount?: number;
    onShare?: (item: Item) => Promise<boolean>;
  };
}) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-2" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
      <div className="flex items-center gap-1.5">
        <span style={{ color: "#9A3F3F" }}><IconRepost /></span>
        <Avatar id={repost.user_id} name={repost.user_name} size={20} />
        <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{repost.user_name}</span>
        <span className="text-xs" style={{ color: "#9A7070" }}>reposted · {postedLabel(repost.created_at)}</span>
        {onRemove && (
          <button onClick={onRemove} className="ml-auto text-xs font-medium hover:underline" style={{ color: "#9A3F3F" }}>
            Remove
          </button>
        )}
      </div>
      {repost.caption && (
        <p className="text-sm leading-relaxed" style={{ color: "#2C1414" }}>{repost.caption}</p>
      )}
      <QuotedItem item={item} />
      {actions && (
        <PostActions
          postId={repost.id}
          baseUpvotes={0}
          upvoted={actions.upvoted}
          onUpvote={actions.onUpvote}
          comments={actions.comments}
          onAddComment={actions.onAddComment}
          onAddReply={actions.onAddReply}
          repostItem={item}
          onRepost={actions.onRepost}
          reposted={actions.reposted}
          repostCount={actions.repostCount}
          onShare={actions.onShare}
        />
      )}
    </div>
  );
}

// ─── Repost Dialog ──────────────────────────────────────────────────────────

function RepostDialog({ item, alreadyReposted, onClose, onRepost, onRemove }: {
  item: Item;
  alreadyReposted: boolean;
  onClose: () => void;
  onRepost: (itemId: string, caption: string) => void;
  onRemove: (itemId: string) => void;
}) {
  const [caption, setCaption] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-2xl shadow-xl w-full max-w-md flex flex-col" style={{ background: "#FBF9D1" }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: "1px solid #C1856D" }}>
          <h2 className="text-base font-semibold" style={{ color: "#2C1414" }}>{alreadyReposted ? "Edit your repost" : "Repost to your timeline"}</h2>
          <button onClick={onClose} style={{ color: "#9A7070" }}><IconX /></button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value)}
            rows={3}
            placeholder="Say something about this (optional)…"
            className={inputCls + " resize-none"}
          />
          <QuotedItem item={item} />
          <div className="flex items-center gap-2">
            <button
              onClick={() => { onRepost(item.id, caption); onClose(); }}
              className={btnPrimary + " flex-1"}
            >
              {alreadyReposted ? "Update repost" : "Repost"}
            </button>
            {alreadyReposted && (
              <button
                onClick={() => { onRemove(item.id); onClose(); }}
                className={btnSecondary}
              >
                Remove repost
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Claim Modal ──────────────────────────────────────────────────────────────

function ClaimModal({ item, onClose, onSubmit }: { item: Item; onClose: () => void; onSubmit: (details: string) => void }) {
  const [details, setDetails] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!details.trim()) return;
    setSubmitted(true);
    onSubmit(details);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative rounded-2xl shadow-xl w-full max-w-md flex flex-col" style={{ background: "#FBF9D1" }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: "1px solid #C1856D" }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: "#2C1414" }}>Submit a Claim</h2>
            <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>Staff will verify your details privately</p>
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: "#9A7070" }}>
            <IconX />
          </button>
        </div>

        <div className="p-5">
          <div className="flex items-start gap-3 p-3 rounded-lg mb-4" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full mt-0.5" style={{ background: "#FBF9D1", color: "#9A3F3F" }}>{item.category}</span>
            <p className="text-sm line-clamp-2" style={{ color: "#2C1414" }}>{item.description}</p>
          </div>

          {submitted ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: "#F2EBE5" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <p className="font-semibold" style={{ color: "#2C1414" }}>Claim submitted</p>
              <p className="text-sm mt-1" style={{ color: "#6B3A3A" }}>Staff will review your details and follow up in the claim thread.</p>
              <button onClick={onClose} className={btnPrimary + " mt-4"}>Done</button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>
                  Identifying details <span style={{ color: "#9A3F3F" }}>*</span>
                </label>
                <textarea
                  value={details}
                  onChange={e => setDetails(e.target.value)}
                  rows={4}
                  className={inputCls + " resize-none"}
                  placeholder="Describe something only the owner would know — a serial number, what's inside, a distinctive marking, your name written somewhere..."
                  required
                />
                <p className="text-xs mt-1.5" style={{ color: "#9A7070" }}>Only visible to you and office staff. Never shared publicly.</p>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: "#F5ECEC", border: "1px solid #C1856D" }}>
                <span style={{ color: "#9A3F3F" }}><IconShield /></span>
                <p className="text-xs" style={{ color: "#7A3A1A" }}>Limited to 3 claims per 24 hours. Pickup is handled in-person at the admin office.</p>
              </div>
              <button type="submit" disabled={!details.trim()} className={btnPrimary + " w-full py-3 disabled:opacity-40 disabled:cursor-not-allowed"}>
                Submit claim
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Catalog View ─────────────────────────────────────────────────────────────

function CatalogView({ items, role, user, search, categoryFilter, onClaim, onUpvote, upvotedIds, onRepost, repostCounts, myRepostItemIds, reposts, onShare, comments, onAddComment, onAddReply }: {
  items: Item[];
  role: Role;
  user: AuthUser;
  search: string;
  categoryFilter: string;
  onClaim: (item: Item) => void;
  onUpvote: (id: string) => void;
  upvotedIds: Set<string>;
  onRepost: (item: Item) => void;
  repostCounts: Record<string, number>;
  myRepostItemIds: Set<string>;
  reposts: Repost[];
  onShare: (item: Item) => Promise<boolean>;
  comments: Record<string, ItemComment[]>;
  onAddComment: (itemId: string, message: string) => void;
  onAddReply: (itemId: string, commentId: string, message: string) => void;
}) {
  // Public items are visible to everyone; a user also sees their own
  // pending-intake items so a freshly logged item reflects immediately.
  const publicItems = items.filter(i =>
    i.status === "in_office" ||
    i.status === "approved_for_pickup" ||
    (i.status === "pending_intake" && i.finder_id === user.id),
  );
  const filtered = publicItems.filter(i => {
    const matchCat = categoryFilter === "All" || i.category === categoryFilter;
    const q = search.toLowerCase();
    const matchSearch = !search || i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || i.location_found.toLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "#2C1414" }}>Found Items</h1>
        <p className="mt-1 text-sm" style={{ color: "#6B3A3A" }}>Items physically held by the admin office. All pickups require ID verification at the desk.</p>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>No items match your search</p>
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Try a different category or search term from the header</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map(item => {
            const itemReposts = reposts.filter(r => r.item_id === item.id);
            return (
              <div key={item.id} className="flex flex-col gap-3">
                <ItemCard
                  item={item}
                  onClaim={onClaim}
                  onUpvote={onUpvote}
                  upvoted={upvotedIds.has(item.id)}
                  onRepost={onRepost}
                  reposted={myRepostItemIds.has(item.id)}
                  repostCount={repostCounts[item.id] ?? 0}
                  onShare={onShare}
                  comments={comments[item.id] ?? []}
                  onAddComment={onAddComment}
                  onAddReply={onAddReply}
                  role={role}
                />
                {itemReposts.map(rp => (
                  <RepostCard
                    key={rp.id}
                    repost={rp}
                    item={item}
                    actions={{
                      upvoted: upvotedIds.has(rp.id),
                      onUpvote,
                      comments: comments[rp.id] ?? [],
                      onAddComment,
                      onAddReply,
                      onRepost,
                      reposted: myRepostItemIds.has(item.id),
                      repostCount: repostCounts[item.id] ?? 0,
                      onShare,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Finder Form ──────────────────────────────────────────────────────────────

function FinderForm({ onSubmit }: { onSubmit: (item: Partial<Item>) => void }) {
  const [form, setForm] = useState({ title: "", category: "", location_found: "", time_found: "", description: "", private_note: "" });
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [caption, setCaption] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleFillFromCaption() {
    if (!caption.trim() || importing) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const parsed = await parseCaption(caption);
      const anyFilled = Boolean(parsed.title || parsed.category || parsed.location_found || parsed.description);
      if (!anyFilled) {
        setImportMsg("Couldn't pull details from that text. Try adding more, or fill the fields manually.");
      } else {
        setForm(f => ({
          ...f,
          title: parsed.title || f.title,
          category: parsed.category || f.category,
          location_found: parsed.location_found || f.location_found,
          description: parsed.description || f.description,
        }));
        setImportMsg("Filled from caption. Review the fields before logging.");
      }
    } catch {
      setImportMsg("Something went wrong reading that caption. Please fill the fields manually.");
    } finally {
      setImporting(false);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcessing(true);
    setTimeout(() => { setPhotoName(file.name); setProcessing(false); }, 800);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    onSubmit({ ...form, status: "pending_intake", upvotes: 0 });
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 className="text-xl font-semibold" style={{ color: "#2C1414" }}>Item logged</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
          Drop it off at the admin office (Room 101, Main Hall) to complete intake. The item won't appear in the public catalog until staff confirm physical custody.
        </p>
        <button
          onClick={() => { setSubmitted(false); setForm({ title: "", category: "", location_found: "", time_found: "", description: "", private_note: "" }); setPhotoName(null); }}
          className={btnPrimary + " mt-6"}
        >
          Log another item
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "#2C1414" }}>Log a Found Item</h1>
        <p className="mt-1 text-sm" style={{ color: "#6B3A3A" }}>Fill in what you found, then drop it off at the admin office. Works offline — your submission will sync when you reconnect.</p>
      </div>

      {/* AI caption import */}
      <div className="rounded-lg p-4 mb-5" style={{ background: "#F5ECEC", border: "1px dashed #C1856D" }}>
        <label className="block text-sm font-semibold mb-1.5" style={{ color: "#2C1414" }}>Fill from a post caption</label>
        <p className="text-xs mb-2" style={{ color: "#6B3A3A" }}>Paste the caption of a lost-and-found post and we'll fill in the fields below. You can edit everything before logging.</p>
        <textarea
          value={caption}
          onChange={e => setCaption(e.target.value)}
          rows={3}
          placeholder="Paste the post caption here..."
          className={inputCls + " resize-none"}
        />
        <div className="flex items-center gap-3 mt-2">
          <button
            type="button"
            onClick={handleFillFromCaption}
            disabled={!caption.trim() || importing}
            className={btnPrimary + " disabled:opacity-40 disabled:cursor-not-allowed"}
          >
            {importing ? "Generating…" : "Generate"}
          </button>
          {importMsg && <span className="text-xs" style={{ color: "#6B3A3A" }}>{importMsg}</span>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Title <span style={{ color: "#9A3F3F" }}>*</span></label>
          <input name="title" value={form.title} onChange={handleChange} required type="text" placeholder="A short headline, e.g. 'Found: black earbuds near the library'" className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Category <span style={{ color: "#9A3F3F" }}>*</span></label>
          <select name="category" value={form.category} onChange={handleChange} required className={inputCls}>
            <option value="">Select a category</option>
            {CATEGORIES.slice(1).map(c => <option key={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Where did you find it? <span style={{ color: "#9A3F3F" }}>*</span></label>
          <input name="location_found" value={form.location_found} onChange={handleChange} required type="text" placeholder="Building, room, or outdoor area" className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>When did you find it? <span style={{ color: "#9A3F3F" }}>*</span></label>
          <input name="time_found" value={form.time_found} onChange={handleChange} required type="datetime-local" className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Description <span style={{ color: "#9A3F3F" }}>*</span></label>
          <textarea name="description" value={form.description} onChange={handleChange} required rows={3} placeholder="Color, brand, notable markings, contents..." className={inputCls + " resize-none"} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Private note to staff</label>
          <textarea name="private_note" value={form.private_note} onChange={handleChange} rows={2} placeholder="Context the catalog shouldn't show — condition, exact location, etc." className={inputCls + " resize-none"} />
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Visible only to staff. Not shown publicly.</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Photo</label>
          <div
            className="rounded-lg p-5 text-center cursor-pointer transition-colors"
            style={{ border: "2px dashed #C1856D", background: "#F5ECEC" }}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            {processing ? (
              <div className="flex flex-col items-center gap-2">
                <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#9A3F3F", borderTopColor: "transparent" }} />
                <p className="text-xs" style={{ color: "#6B3A3A" }}>Stripping location metadata…</p>
              </div>
            ) : photoName ? (
              <div className="flex flex-col items-center gap-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <p className="text-sm font-medium" style={{ color: "#9A3F3F" }}>{photoName}</p>
                <p className="text-xs" style={{ color: "#9A7070" }}>EXIF/GPS stripped · re-encoded as WebP</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2" style={{ color: "#9A7070" }}>
                <IconCamera />
                <p className="text-sm">Tap to add a photo</p>
                <p className="text-xs">Location data removed automatically before upload</p>
              </div>
            )}
          </div>
        </div>

        <button type="submit" className={btnPrimary + " w-full py-3"}>Log found item</button>
      </form>
    </div>
  );
}

// ─── Missing Notices ──────────────────────────────────────────────────────────

function MissingNotices({ notices, onPost }: { notices: MissingNotice[]; onPost: (n: Partial<MissingNotice>) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ description: "", location_lost: "", time_lost: "" });
  const [posted, setPosted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onPost(form);
    setPosted(true);
    setShowForm(false);
    setForm({ description: "", location_lost: "", time_lost: "" });
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "#2C1414" }}>Missing Notices</h1>
          <p className="mt-1 text-sm" style={{ color: "#6B3A3A" }}>Passive bulletin for items not yet found. No chat or claims — if your item turns up in the catalog, claim it there.</p>
        </div>
        <button onClick={() => { setShowForm(s => !s); setPosted(false); }} className={btnPrimary + " shrink-0"}>
          Post notice
        </button>
      </div>

      {posted && (
        <div className="mb-4 p-3 rounded-lg text-sm font-medium" style={{ background: "#F2EBE5", border: "1px solid #C1856D", color: "#5C2020" }}>
          Notice posted. Check the catalog daily — staff will add your item once it's turned in.
        </div>
      )}

      {showForm && (
        <div className="mb-6 rounded-xl p-5" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
          <h2 className="font-semibold mb-4 text-sm" style={{ color: "#2C1414" }}>Post a missing notice</h2>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Description <span style={{ color: "#9A3F3F" }}>*</span></label>
              <textarea required rows={3} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Brand, color, identifying markings..." className={inputCls + " resize-none"} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Where did you lose it? <span style={{ color: "#9A3F3F" }}>*</span></label>
              <input required type="text" value={form.location_lost} onChange={e => setForm(f => ({ ...f, location_lost: e.target.value }))} placeholder="Building, area, or route" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Approximately when? <span style={{ color: "#9A3F3F" }}>*</span></label>
              <input required type="datetime-local" value={form.time_lost} onChange={e => setForm(f => ({ ...f, time_lost: e.target.value }))} className={inputCls} />
            </div>
            <div className="flex gap-3">
              <button type="submit" className={btnPrimary + " flex-1"}>Post notice</button>
              <button type="button" onClick={() => setShowForm(false)} className={btnSecondary}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {notices.map(n => (
          <div key={n.id} className="rounded-xl p-5" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
            <p className="text-sm leading-relaxed" style={{ color: "#2C1414" }}>{n.description}</p>
            <div className="flex flex-wrap gap-3 mt-3">
              <span className="flex items-center gap-1.5 text-xs" style={{ color: "#6B3A3A" }}><IconMapPin />{n.location_lost}</span>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: "#6B3A3A" }}><IconClock />{formatDate(n.time_lost)}</span>
            </div>
            <p className="text-xs mt-2" style={{ color: "#9A7070" }}>Posted {relativeDate(n.created_at)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Owner Claims View ────────────────────────────────────────────────────────

function OwnerClaimsView({ claims, items, onReply }: { claims: Claim[]; items: Item[]; onReply: (claimId: string, message: string) => void }) {
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [reply, setReply] = useState("");

  const activeClaim = claims.find(c => c.id === activeClaimId);

  function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim() || !activeClaimId) return;
    onReply(activeClaimId, reply);
    setReply("");
  }

  if (claims.length === 0) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: "#E6CFA9" }}>
          <span style={{ color: "#9A7070" }}><IconInbox /></span>
        </div>
        <p className="font-medium" style={{ color: "#2C1414" }}>No active claims</p>
        <p className="text-sm mt-1" style={{ color: "#9A7070" }}>Browse the catalog to claim a found item</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-semibold mb-6" style={{ color: "#2C1414" }}>My Claims</h1>

      {!activeClaim ? (
        <div className="flex flex-col gap-4">
          {claims.map(claim => {
            const item = items.find(i => i.id === claim.item_id);
            return (
              <button key={claim.id} onClick={() => setActiveClaimId(claim.id)} className="text-left rounded-xl p-5 transition-shadow hover:shadow-md" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="text-xs font-semibold" style={{ color: "#9A3F3F" }}>{item?.category}</span>
                    <p className="text-sm mt-1 line-clamp-2" style={{ color: "#2C1414" }}>{item?.description}</p>
                    <p className="text-xs mt-2" style={{ color: "#9A7070" }}>{claim.messages.length} message{claim.messages.length !== 1 ? "s" : ""} · {relativeDate(claim.created_at)}</p>
                  </div>
                  <ClaimBadge status={claim.status} />
                </div>
                {claim.status === "approved" && (
                  <div className="mt-3 p-2.5 rounded-lg text-xs font-medium" style={{ background: "#F2EBE5", border: "1px solid #C1856D", color: "#5C2020" }}>
                    Approved for pickup — bring your ID to the office (Mon–Fri 9am–5pm)
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div>
          <button onClick={() => setActiveClaimId(null)} className="flex items-center gap-2 text-sm mb-4 transition-colors" style={{ color: "#6B3A3A" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back to claims
          </button>

          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #C1856D" }}>
            <div className="p-5 flex items-start justify-between gap-4" style={{ borderBottom: "1px solid #C1856D", background: "#E6CFA9" }}>
              <div>
                <p className="text-sm font-medium" style={{ color: "#2C1414" }}>{items.find(i => i.id === activeClaim.item_id)?.description}</p>
                <p className="text-xs mt-1" style={{ color: "#6B3A3A" }}>Submitted {formatDate(activeClaim.created_at)}</p>
              </div>
              <ClaimBadge status={activeClaim.status} />
            </div>

            <div className="p-5 flex flex-col gap-4 max-h-80 overflow-y-auto scroll-area" style={{ background: "#FBF9D1" }}>
              <div className="p-3 rounded-lg" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                <p className="text-xs font-medium mb-1" style={{ color: "#6B3A3A" }}>Your identifying details</p>
                <p className="text-sm" style={{ color: "#2C1414" }}>{activeClaim.identifying_details}</p>
              </div>
              {activeClaim.messages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.sender_role === "owner" ? "items-end" : "items-start"}`}>
                  <div className="max-w-xs px-4 py-3 rounded-2xl text-sm leading-relaxed"
                    style={msg.sender_role === "staff"
                      ? { background: "#9A3F3F", color: "#FBF9D1" }
                      : { background: "#E6CFA9", color: "#2C1414", border: "1px solid #C1856D" }
                    }>
                    {msg.sender_role === "staff" && (
                      <span className="flex items-center gap-1 text-xs font-semibold mb-1" style={{ color: "#E6CFA9" }}><IconShield /> Staff</span>
                    )}
                    {msg.message}
                  </div>
                  <span className="text-xs mt-1" style={{ color: "#9A7070" }}>{formatTime(msg.created_at)}</span>
                </div>
              ))}
            </div>

            {activeClaim.status === "pending_review" && (
              <form onSubmit={handleReply} className="p-4 flex gap-3" style={{ borderTop: "1px solid #C1856D", background: "#FBF9D1" }}>
                <input type="text" value={reply} onChange={e => setReply(e.target.value)} placeholder="Reply to staff..." className={inputCls + " flex-1"} />
                <button type="submit" disabled={!reply.trim()} className={btnPrimary + " disabled:opacity-40 disabled:cursor-not-allowed"}>Send</button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Staff Dashboard ──────────────────────────────────────────────────────────

function StaffDashboard({ items, claims, allItems, onStatusChange, onClaimAction, onStaffReply }: {
  items: Item[];
  claims: Claim[];
  allItems: Item[];
  onStatusChange: (id: string, status: ItemStatus) => void;
  onClaimAction: (id: string, action: "approved" | "rejected") => void;
  onStaffReply: (claimId: string, message: string) => void;
}) {
  const [tab, setTab] = useState<"intake" | "claims">("intake");
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);
  const [reply, setReply] = useState("");

  const pendingIntake = items.filter(i => i.status === "pending_intake");
  const pendingClaims = claims.filter(c => c.status === "pending_review");
  const activeClaim = claims.find(c => c.id === activeClaimId);

  const NEXT_STATUS: Partial<Record<ItemStatus, ItemStatus>> = {
    pending_intake: "in_office",
    in_office: "approved_for_pickup",
    approved_for_pickup: "released",
  };

  const NEXT_LABEL: Partial<Record<ItemStatus, string>> = {
    pending_intake: "Mark as received — item is in hand",
    in_office: "Approve for pickup",
    approved_for_pickup: "Mark as released",
  };

  function handleStaffReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim() || !activeClaimId) return;
    onStaffReply(activeClaimId, reply);
    setReply("");
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
          <IconShield />
        </div>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "#2C1414" }}>Staff Dashboard</h1>
          <p className="text-xs" style={{ color: "#6B3A3A" }}>Admin Office · Main Hall Room 101</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg w-fit" style={{ background: "#E6CFA9" }}>
        {[
          { id: "intake" as const, label: "Pending Intake", count: pendingIntake.length, countBg: "#C1856D" },
          { id: "claims" as const, label: "Claims Review", count: pendingClaims.length, countBg: "#9A3F3F" },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setActiveClaimId(null); }}
            className="px-4 py-2 text-sm font-medium rounded-md transition-colors relative"
            style={tab === t.id
              ? { background: "#FBF9D1", color: "#2C1414" }
              : { color: "#6B3A3A" }
            }
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full font-semibold" style={{ background: t.countBg, color: "#FBF9D1" }}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "intake" && (
        <div>
          {pendingIntake.length === 0 ? (
            <div className="text-center py-12 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
              <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>All clear — no pending intake</p>
              <p className="text-xs mt-1" style={{ color: "#9A7070" }}>New items logged by finders will appear here</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {pendingIntake.map(item => (
                <div key={item.id} className="rounded-xl p-5" style={{ background: "#E6CFA9", borderLeft: "4px solid #C1856D", border: "1px solid #C1856D", borderLeftWidth: "4px" }}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "#FBF9D1", color: "#9A3F3F" }}>{item.category}</span>
                        <StatusBadge status={item.status} />
                      </div>
                      <p className="text-sm mb-2" style={{ color: "#2C1414" }}>{item.description}</p>
                      {item.private_note && (
                        <div className="p-2.5 rounded-lg mb-2" style={{ background: "#FBF9D1", border: "1px solid #C1856D" }}>
                          <p className="text-xs" style={{ color: "#6B3A3A" }}><span className="font-semibold">Finder note:</span> {item.private_note}</p>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-3">
                        <span className="flex items-center gap-1 text-xs" style={{ color: "#6B3A3A" }}><IconMapPin />{item.location_found}</span>
                        <span className="flex items-center gap-1 text-xs" style={{ color: "#6B3A3A" }}><IconClock />{formatDate(item.time_found)}</span>
                      </div>
                    </div>
                    {item.image_url && <img src={item.image_url} alt="" className="w-20 h-20 rounded-lg object-cover shrink-0" />}
                  </div>
                  <div className="flex gap-3 mt-4 pt-4" style={{ borderTop: "1px solid #C1856D" }}>
                    <button
                      onClick={() => onStatusChange(item.id, NEXT_STATUS[item.status]!)}
                      className="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-colors"
                      style={{ background: "#9A3F3F", color: "#FBF9D1" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
                      onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
                    >
                      {NEXT_LABEL[item.status]}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "claims" && !activeClaim && (
        <div>
          {claims.length === 0 ? (
            <div className="text-center py-12 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
              <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>No claims to review</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {claims.map(claim => {
                const item = allItems.find(i => i.id === claim.item_id);
                return (
                  <button key={claim.id} onClick={() => setActiveClaimId(claim.id)} className="text-left rounded-xl p-5 transition-shadow hover:shadow-md" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <ClaimBadge status={claim.status} />
                          <span className="text-xs" style={{ color: "#6B3A3A" }}>from {claim.owner_name}</span>
                        </div>
                        <p className="text-sm mt-1" style={{ color: "#2C1414" }}>{item?.category} · {item?.description?.slice(0, 60)}…</p>
                        <p className="text-xs mt-1" style={{ color: "#9A7070" }}>{claim.messages.length} message{claim.messages.length !== 1 ? "s" : ""} · {relativeDate(claim.created_at)}</p>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C1856D" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-1"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "claims" && activeClaim && (
        <div>
          <button onClick={() => setActiveClaimId(null)} className="flex items-center gap-2 text-sm mb-4 transition-colors" style={{ color: "#6B3A3A" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back to all claims
          </button>

          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid #C1856D" }}>
            <div className="p-5 flex items-center justify-between gap-4" style={{ borderBottom: "1px solid #C1856D", background: "#E6CFA9" }}>
              <div>
                <p className="font-medium text-sm" style={{ color: "#2C1414" }}>Claim by {activeClaim.owner_name}</p>
                <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>{allItems.find(i => i.id === activeClaim.item_id)?.description}</p>
              </div>
              <ClaimBadge status={activeClaim.status} />
            </div>

            <div className="p-5 flex flex-col gap-4 max-h-72 overflow-y-auto scroll-area" style={{ background: "#FBF9D1" }}>
              <div className="p-3 rounded-lg" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                <p className="text-xs font-medium mb-1" style={{ color: "#6B3A3A" }}>Owner's identifying details</p>
                <p className="text-sm" style={{ color: "#2C1414" }}>{activeClaim.identifying_details}</p>
              </div>
              {activeClaim.messages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.sender_role === "staff" ? "items-end" : "items-start"}`}>
                  <div className="max-w-xs px-4 py-3 rounded-2xl text-sm leading-relaxed"
                    style={msg.sender_role === "owner"
                      ? { background: "#E6CFA9", color: "#2C1414", border: "1px solid #C1856D" }
                      : { background: "#9A3F3F", color: "#FBF9D1" }
                    }>
                    {msg.sender_role === "owner" && <span className="text-xs font-medium block mb-1" style={{ color: "#6B3A3A" }}>{activeClaim.owner_name}</span>}
                    {msg.message}
                  </div>
                  <span className="text-xs mt-1" style={{ color: "#9A7070" }}>{formatTime(msg.created_at)}</span>
                </div>
              ))}
            </div>

            {activeClaim.status === "pending_review" && (
              <>
                <form onSubmit={handleStaffReply} className="p-4 flex gap-3" style={{ borderTop: "1px solid #C1856D", background: "#FBF9D1" }}>
                  <input type="text" value={reply} onChange={e => setReply(e.target.value)} placeholder="Reply to owner..." className={inputCls + " flex-1"} />
                  <button type="submit" disabled={!reply.trim()} className={btnPrimary + " disabled:opacity-40 disabled:cursor-not-allowed"}>Send</button>
                </form>
                <div className="px-5 pb-5 flex gap-3" style={{ background: "#FBF9D1" }}>
                  <button
                    onClick={() => { onClaimAction(activeClaim.id, "approved"); setActiveClaimId(null); }}
                    className="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-colors"
                    style={{ background: "#9A3F3F", color: "#FBF9D1" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
                    onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
                  >
                    Approve claim
                  </button>
                  <button
                    onClick={() => { onClaimAction(activeClaim.id, "rejected"); setActiveClaimId(null); }}
                    className="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-colors"
                    style={{ border: "1px solid #C1856D", color: "#9A3F3F", background: "transparent" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#F5ECEC")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    Reject claim
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

type View = "catalog" | "log" | "missing" | "claims" | "profile" | "staff";

function Nav({ view, setView, role, user, search, setSearch, categoryFilter, setCategoryFilter, offlineQueueCount }: {
  view: View;
  setView: (v: View) => void;
  role: Role;
  user: AuthUser;
  search: string;
  setSearch: (s: string) => void;
  categoryFilter: string;
  setCategoryFilter: (c: string) => void;
  offlineQueueCount: number;
}) {
  const navItems: { id: View; label: string; roles: Role[] }[] = [
    { id: "catalog", label: "Catalog", roles: ["finder", "owner", "staff"] },
    { id: "log", label: "Log Item", roles: ["finder", "owner"] },
    { id: "missing", label: "Missing", roles: ["finder", "owner"] },
    { id: "claims", label: "My Claims", roles: ["owner"] },
    { id: "staff", label: "Staff", roles: ["staff"] },
  ];

  const visible = navItems.filter(n => n.roles.includes(role));
  const canCreate = role !== "staff";
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  function go(v: View) {
    setView(v);
    setMenuOpen(false);
  }

  return (
    <header className="sticky top-0 z-40" style={{ background: "#FBF9D1", borderBottom: "1px solid #C1856D" }}>
      {offlineQueueCount > 0 && (
        <div className="text-xs font-medium px-4 py-2 flex items-center gap-2" style={{ background: "#C1856D", color: "#FBF9D1" }}>
          <IconWifi />
          <span>{offlineQueueCount} item{offlineQueueCount !== 1 ? "s" : ""} waiting to sync — reconnect to complete</span>
        </div>
      )}

      {/* Top row: menu · brand · centered search · + create · avatar */}
      <div className="max-w-5xl mx-auto px-4 flex items-center gap-3 h-14">
        <button
          onClick={() => setMenuOpen(true)}
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors shrink-0"
          style={{ color: "#2C1414" }}
          aria-label="Open menu"
          title="Menu"
        >
          <IconMenu />
        </button>
        <button onClick={() => setView("catalog")} className="flex items-center gap-2 shrink-0" aria-label="Home">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#9A3F3F" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FBF9D1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <span className="font-semibold text-sm hidden md:block" style={{ color: "#2C1414" }}>FoundIt</span>
        </button>

        {/* Centered search with a filter icon on the right */}
        <div className="relative flex-1 max-w-xl mx-auto">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "#9A7070" }}>
            <IconSearch />
          </span>
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); if (view !== "catalog") setView("catalog"); }}
            placeholder="Search found items…"
            className="w-full pl-9 pr-16 py-2 text-sm rounded-full border focus:outline-none focus:ring-2"
            style={{ background: "#F7EDE6", borderColor: "#C1856D", color: "#2C1414" }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-9 top-1/2 -translate-y-1/2"
              style={{ color: "#9A7070" }}
              aria-label="Clear search"
              title="Clear search"
            >
              <IconX />
            </button>
          )}
          {/* Filter icon (rightmost, inside the field) */}
          <button
            onClick={() => setFilterOpen(o => !o)}
            className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
            style={{ color: categoryFilter !== "All" ? "#9A3F3F" : "#9A7070" }}
            aria-label="Filter by category"
            title="Filter by category"
            aria-expanded={filterOpen}
          >
            <IconFilter />
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
              <div
                className="absolute right-0 mt-2 z-50 w-48 rounded-lg py-1 shadow-xl"
                style={{ background: "#FBF9D1", border: "1px solid #C1856D" }}
              >
                {CATEGORIES.map(c => (
                  <button
                    key={c}
                    onClick={() => { setCategoryFilter(c); setFilterOpen(false); if (view !== "catalog") setView("catalog"); }}
                    className="w-full text-left px-3 py-2 text-sm transition-colors"
                    style={c === categoryFilter
                      ? { background: "#E6CFA9", color: "#9A3F3F", fontWeight: 600 }
                      : { color: "#2C1414" }
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canCreate && (
            <button
              onClick={() => setView("log")}
              className="inline-flex items-center justify-center w-9 h-9 rounded-full transition-colors"
              style={{ background: "#9A3F3F", color: "#FBF9D1" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
              onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
              aria-label="Log a found item"
              title="Log a found item"
            >
              <IconPlus />
            </button>
          )}
          <button
            onClick={() => setView("profile")}
            className="rounded-full transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2"
            style={{ boxShadow: view === "profile" ? "0 0 0 2px #9A3F3F" : "none" }}
            aria-label="Open your profile"
            title="Your profile"
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover block" />
            ) : (
              <span
                className="inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold shrink-0"
                style={{ background: "#9A3F3F", color: "#FBF9D1" }}
                aria-hidden="true"
              >
                {user.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Left sidebar drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <aside
            className="absolute left-0 top-0 bottom-0 w-64 max-w-[80%] p-4 flex flex-col gap-1 shadow-xl"
            style={{ background: "#FBF9D1", borderRight: "1px solid #C1856D" }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-sm" style={{ color: "#2C1414" }}>Menu</span>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu" style={{ color: "#9A7070" }}>
                <IconX />
              </button>
            </div>
            {visible.map(item => (
              <button
                key={item.id}
                onClick={() => go(item.id)}
                className="text-left px-3 py-2.5 text-sm font-medium rounded-lg transition-colors"
                style={view === item.id
                  ? { background: "#E6CFA9", color: "#9A3F3F" }
                  : { color: "#6B3A3A" }
                }
              >
                {item.label}
              </button>
            ))}
          </aside>
        </div>
      )}
    </header>
  );
}

// ─── Sign In ──────────────────────────────────────────────────────────────────

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function SignIn({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      await onSignIn();
    } catch {
      setError("We couldn't sign you in. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#FBF9D1" }}>
      <div className="w-full max-w-sm rounded-2xl p-8 text-center shadow-sm" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: "#9A3F3F" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FBF9D1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "#2C1414" }}>FoundIt</h1>
        <p className="mt-1.5 text-sm" style={{ color: "#6B3A3A" }}>Sign in to log found items and claim what's yours.</p>

        <button
          onClick={handleClick}
          disabled={busy}
          className="mt-6 w-full flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ background: "#FBF9D1", color: "#2C1414", border: "1px solid #C1856D" }}
        >
          {busy ? (
            <>
              <span className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#9A3F3F", borderTopColor: "transparent" }} />
              Signing in…
            </>
          ) : (
            <>
              <GoogleGlyph />
              Continue with Google
            </>
          )}
        </button>

        {error && (
          <p className="mt-3 text-xs font-medium" style={{ color: "#9A3F3F" }}>{error}</p>
        )}

        <p className="mt-6 text-xs" style={{ color: "#9A7070" }}>Only your name and email are used to identify your account.</p>
      </div>
    </div>
  );
}

// ─── My Timeline View ─────────────────────────────────────────────────────────

// ─── My Profile View ──────────────────────────────────────────────────────────

function ProfileView({ user, items, reposts, onRemoveRepost, onSignOut }: {
  user: AuthUser;
  items: Item[];
  reposts: Repost[];
  onRemoveRepost: (itemId: string) => void;
  onSignOut: () => void;
}) {
  const myItems = items
    .filter(i => i.finder_id === user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const myReposts = reposts
    .filter(r => r.user_id === user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const empty = myItems.length === 0 && myReposts.length === 0;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="rounded-xl p-5 mb-6 flex items-center gap-4" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="w-14 h-14 rounded-full object-cover" />
        ) : (
          <span className="inline-flex items-center justify-center w-14 h-14 rounded-full text-lg font-semibold shrink-0" style={{ background: "#9A3F3F", color: "#FBF9D1" }} aria-hidden="true">
            {user.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold" style={{ color: "#2C1414" }}>{user.name}</h1>
          <p className="text-sm truncate" style={{ color: "#6B3A3A" }}>{user.email}</p>
        </div>
        <button onClick={onSignOut} className={btnSecondary}>Sign out</button>
      </div>

      {empty ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>Nothing here yet</p>
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Items you log and posts you repost will show up on your profile.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {myItems.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2" style={{ color: "#2C1414" }}>Your posts</h2>
              <div className="flex flex-col gap-3">
                {myItems.map(item => <ItemCard key={item.id} item={item} role={user.role} />)}
              </div>
            </div>
          )}
          {myReposts.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2" style={{ color: "#2C1414" }}>Your reposts</h2>
              <div className="flex flex-col gap-3">
                {myReposts.map(rp => {
                  const item = items.find(i => i.id === rp.item_id);
                  return item ? <RepostCard key={rp.id} repost={rp} item={item} onRemove={() => onRemoveRepost(rp.item_id)} /> : null;
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [view, setView] = useState<View>("catalog");
  const [items, setItems] = useState<Item[]>(MOCK_ITEMS);
  const [claims, setClaims] = useState<Claim[]>(MOCK_CLAIMS);
  const [notices, setNotices] = useState<MissingNotice[]>(MOCK_MISSING);
  const [claimingItem, setClaimingItem] = useState<Item | null>(null);
  const [upvotedIds, setUpvotedIds] = useState<Set<string>>(new Set());
  const [reposts, setReposts] = useState<Repost[]>([]);
  const [comments, setComments] = useState<Record<string, ItemComment[]>>({});
  const [repostingItem, setRepostingItem] = useState<Item | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [offlineQueueCount] = useState(0);

  // Restore any existing session on load, and subscribe to auth changes.
  useEffect(() => {
    let active = true;
    getSession().then(user => {
      if (!active) return;
      setAuth(user ? { status: "signed_in", user } : { status: "signed_out" });
    });
    const unsubscribe = onAuthChange(setAuth);
    return () => { active = false; unsubscribe(); };
  }, []);

  const user = auth.status === "signed_in" ? auth.user : null;
  const role: Role = user?.role ?? "owner";

  async function handleSignIn() {
    await signInWithGoogle();
  }

  async function handleSignOut() {
    await signOut();
    setView("catalog");
  }

  function handleUpvote(id: string) {
    setUpvotedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function handleAddRepost(itemId: string, caption: string) {
    if (!user) return;
    setReposts(prev => {
      // Replace any existing repost by this user for this item (update caption).
      const others = prev.filter(r => !(r.item_id === itemId && r.user_id === user.id));
      return [
        {
          id: `rp${Date.now()}`,
          item_id: itemId,
          user_id: user.id,
          user_name: user.name,
          caption: caption.trim() || undefined,
          created_at: new Date().toISOString(),
        },
        ...others,
      ];
    });
  }

  function handleRemoveRepost(itemId: string) {
    if (!user) return;
    setReposts(prev => prev.filter(r => !(r.item_id === itemId && r.user_id === user.id)));
  }

  async function handleShare(item: Item): Promise<boolean> {
    const url = `${window.location.origin}/?item=${encodeURIComponent(item.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  function handleAddComment(itemId: string, message: string) {
    if (!user || !message.trim()) return;
    const comment: ItemComment = {
      id: `cm${Date.now()}`,
      author_id: user.id,
      author_name: user.name,
      message: message.trim(),
      created_at: new Date().toISOString(),
      replies: [],
    };
    setComments(prev => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), comment] }));
  }

  function handleAddReply(itemId: string, commentId: string, message: string) {
    if (!user || !message.trim()) return;
    const reply: CommentReply = {
      id: `rp${Date.now()}`,
      author_id: user.id,
      author_name: user.name,
      message: message.trim(),
      created_at: new Date().toISOString(),
    };
    setComments(prev => ({
      ...prev,
      [itemId]: (prev[itemId] ?? []).map(c =>
        c.id === commentId ? { ...c, replies: [...c.replies, reply] } : c,
      ),
    }));
  }

  function handleClaimSubmit(details: string) {
    if (!user) return;
    const newClaim: Claim = {
      id: `c${Date.now()}`,
      item_id: claimingItem!.id,
      owner_id: user.id,
      owner_name: user.name,
      identifying_details: details,
      status: "pending_review",
      created_at: new Date().toISOString(),
      messages: [],
    };
    setClaims(prev => [...prev, newClaim]);
  }

  function handleStatusChange(id: string, newStatus: ItemStatus) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i));
  }

  function handleClaimAction(id: string, action: "approved" | "rejected") {
    setClaims(prev => prev.map(c => {
      if (c.id !== id) return c;
      if (action === "approved") {
        const item = items.find(i => i.id === c.item_id);
        if (item) handleStatusChange(item.id, "approved_for_pickup");
      }
      return { ...c, status: action };
    }));
  }

  function handleStaffReply(claimId: string, message: string) {
    setClaims(prev => prev.map(c => c.id !== claimId ? c : {
      ...c, messages: [...c.messages, { id: `m${Date.now()}`, sender_id: "staff1", sender_role: "staff", message, created_at: new Date().toISOString() }],
    }));
  }

  function handleOwnerReply(claimId: string, message: string) {
    setClaims(prev => prev.map(c => c.id !== claimId ? c : {
      ...c, messages: [...c.messages, { id: `m${Date.now()}`, sender_id: user?.id ?? "owner", sender_role: "owner", message, created_at: new Date().toISOString() }],
    }));
  }

  function handleFinderSubmit(partial: Partial<Item>) {
    setItems(prev => [{
      id: `i${Date.now()}`, finder_id: user?.id ?? "u_current", finder_name: user?.name,
      title: partial.title || "Untitled found item",
      category: partial.category || "Other", location_found: partial.location_found || "",
      time_found: partial.time_found || new Date().toISOString(), description: partial.description || "",
      private_note: partial.private_note, status: "pending_intake", upvotes: 0, created_at: new Date().toISOString(),
    }, ...prev]);
  }

  function handleNoticePost(partial: Partial<MissingNotice>) {
    setNotices(prev => [{
      id: `mn${Date.now()}`, owner_id: user?.id ?? "u1",
      description: partial.description || "", location_lost: partial.location_lost || "",
      time_lost: partial.time_lost || new Date().toISOString(), created_at: new Date().toISOString(),
    }, ...prev]);
  }

  const ownerClaims = user ? claims.filter(c => c.owner_id === user.id) : [];
  const repostCounts: Record<string, number> = {};
  for (const r of reposts) repostCounts[r.item_id] = (repostCounts[r.item_id] ?? 0) + 1;
  const myRepostItemIds = new Set(user ? reposts.filter(r => r.user_id === user.id).map(r => r.item_id) : []);

  // Auth gate: loader while restoring, sign-in screen when signed out.
  if (auth.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#FBF9D1" }}>
        <span className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#9A3F3F", borderTopColor: "transparent" }} />
      </div>
    );
  }
  if (auth.status === "signed_out" || !user) {
    return <SignIn onSignIn={handleSignIn} />;
  }

  return (
    <div className="min-h-screen" style={{ background: "#FBF9D1" }}>
      <Nav view={view} setView={setView} role={role} user={user} search={search} setSearch={setSearch} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} offlineQueueCount={offlineQueueCount} />
      <main>
        {view === "catalog" && <CatalogView items={items} role={role} user={user} search={search} categoryFilter={categoryFilter} onClaim={setClaimingItem} onUpvote={handleUpvote} upvotedIds={upvotedIds} onRepost={setRepostingItem} repostCounts={repostCounts} myRepostItemIds={myRepostItemIds} reposts={reposts} onShare={handleShare} comments={comments} onAddComment={handleAddComment} onAddReply={handleAddReply} />}
        {view === "log" && <FinderForm onSubmit={handleFinderSubmit} />}
        {view === "missing" && <MissingNotices notices={notices} onPost={handleNoticePost} />}
        {view === "claims" && <OwnerClaimsView claims={ownerClaims} items={items} onReply={handleOwnerReply} />}
        {view === "profile" && <ProfileView user={user} items={items} reposts={reposts} onRemoveRepost={handleRemoveRepost} onSignOut={handleSignOut} />}
        {view === "staff" && <StaffDashboard items={items} claims={claims} allItems={items} onStatusChange={handleStatusChange} onClaimAction={handleClaimAction} onStaffReply={handleStaffReply} />}
      </main>

      {claimingItem && (
        <ClaimModal item={claimingItem} onClose={() => setClaimingItem(null)} onSubmit={(details) => { handleClaimSubmit(details); }} />
      )}
      {repostingItem && (
        <RepostDialog
          item={repostingItem}
          alreadyReposted={myRepostItemIds.has(repostingItem.id)}
          onClose={() => setRepostingItem(null)}
          onRepost={handleAddRepost}
          onRemove={handleRemoveRepost}
        />
      )}
    </div>
  );
}
