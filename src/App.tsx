import { useState, useRef, useEffect } from "react";
import type { ReactElement } from "react";
import type { AuthState, AuthUser, Role } from "./lib/auth";
import { getSession, signInWithGoogle, signOut, onAuthChange } from "./lib/auth";
import { createContext, useContext } from "react";
import { parseCaption } from "./lib/captionImport";
import { verifyStudent } from "./lib/studentVerify";
import {
  isDbEnabled, listItems, createItem, subscribeItems,
  listComments, insertComment, subscribeComments,
  listReposts, upsertRepost, removeRepost, subscribeReposts,
  listChallengeResponses, insertChallengeResponse, updateChallengeResponseStatus, updateChallengeResponseAnswers, subscribeChallengeResponses,
  listVerifications, upsertVerification, subscribeVerifications,
  listNotifications, insertNotification, markNotificationsReadDb, subscribeNotifications,
} from "./lib/db";

// ─── Client-side persistence (Requirement 14) ───────────────────────────────────
//
// Persists prototype state to localStorage under versioned `foundit:v1:` keys so
// items/claims/notices/etc. survive a page reload, until the Supabase data layer
// lands. Auth/session state is NOT persisted here — it stays owned by lib/auth.

const STORAGE_PREFIX = "foundit:v1:";

interface Serializer<T> {
  serialize: (value: T) => unknown;
  deserialize: (raw: unknown) => T;
}

function usePersistentState<T>(
  key: string,
  defaultValue: T,
  serializer?: Serializer<T>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const storageKey = STORAGE_PREFIX + key;

  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw == null) return defaultValue;
      const parsed = JSON.parse(raw);
      return serializer ? serializer.deserialize(parsed) : (parsed as T);
    } catch {
      // Malformed/unreadable data — fall back to the default without crashing.
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const toStore = serializer ? serializer.serialize(value) : value;
      window.localStorage.setItem(storageKey, JSON.stringify(toStore));
    } catch {
      // Ignore quota/serialization errors — persistence is best-effort here.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, value]);

  return [value, setValue];
}

// (De)serialize a Set as a plain array for JSON storage.
const setSerializer: Serializer<Set<string>> = {
  serialize: (s) => Array.from(s),
  deserialize: (raw) => new Set(Array.isArray(raw) ? (raw as string[]) : []),
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ItemStatus = "pending_intake" | "in_office" | "approved_for_pickup" | "released";
type ClaimStatus = "pending_review" | "approved" | "rejected";

interface Item {
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
}

type ShareResult = "shared" | "copied" | "failed" | "cancelled";

// ─── Ownership Challenge (Requirement 16) ───────────────────────────────────────

interface ChallengeQuestion {
  id: string;
  prompt: string; // short-text question authored by the finder
}

interface ChallengeAnswer {
  question_id: string;
  prompt: string;
  answer: string;
}

// "found" flow: someone claims a found item (responder answers finder's Qs).
// "lost" flow: someone found a lost-post item (finder authors Qs, owner answers).
type ChallengeResponseStatus = "pending" | "approved" | "rejected" | "escalated" | "awaiting_owner" | "answered";

interface ChallengeResponse {
  id: string;
  kind?: "found" | "lost"; // which flow; defaults to "found"
  item_id: string;
  responder_id: string;   // found: the claimant; lost: the finder who reported
  responder_name: string;
  owner_id?: string;      // lost flow: the lost post's owner (who must answer)
  answers: ChallengeAnswer[];
  note?: string;
  status: ChallengeResponseStatus;
  created_at: string;
}

// ─── Notifications (Requirement 18) ─────────────────────────────────────────────

interface AppNotification {
  id: string;
  recipient_id: string;
  message: string;
  item_id?: string;       // post to open when clicked
  response_id?: string;   // related found/challenge report
  read: boolean;
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

// A single recursive node type powers branching (nested) replies: every comment
// and every reply can itself be replied to, at arbitrary depth.
interface CommentNode {
  id: string;
  author_id: string;
  author_name: string;
  message: string;
  created_at: string;
  replies: CommentNode[];
}

// Back-compat alias: the rest of the app refers to top-level nodes as ItemComment.
type ItemComment = CommentNode;

// ─── Student verification (Requirement 15) ──────────────────────────────────────

type VerificationStatus = "unverified" | "verified" | "rejected"; // AI-only, no "pending"
type DocType = "student_id" | "cor" | "class_schedule";

interface StudentVerification {
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
// Total number of nodes in a branching comment tree (comments + all nested replies).
// Defensive against legacy/malformed persisted data where `replies` may be missing.
function countCommentNodes(nodes: CommentNode[] | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce((n, node) => n + 1 + countCommentNodes(node?.replies), 0);
}
// Current local date/time formatted for a <input type="datetime-local"> value
// (YYYY-MM-DDTHH:mm, in the user's local timezone).
function nowForDateTimeLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function relativeDate(iso: string) {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
// Relative label up to 7 days, then falls back to the full date (e.g. "Sep 14, 2026").
// Uses the real current time so timestamps stay accurate.
function postedLabel(iso: string) {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
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

// "Verified student" badge — shown next to a verified user's name.
function VerificationBadge({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ color: "#9A3F3F" }}
      title="Verified student"
      aria-label="Verified student"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 1.5l2.6 1.9 3.2-.2 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.2L12 22.5l-2.6-1.9-3.2.2-1-3.1L2.6 15.8l1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.2z"/>
        <path d="M10.6 15.2l-2.4-2.4 1.1-1.1 1.3 1.3 3.4-3.4 1.1 1.1z" fill="#FBF9D1"/>
      </svg>
    </span>
  );
}

// Read-only context of verified student ids, so any component (item cards,
// comment threads) can show the badge without prop-drilling.
const VerifiedContext = createContext<Set<string>>(new Set());
function useIsVerified(userId: string): boolean {
  return useContext(VerifiedContext).has(userId);
}

// Opens the full-screen post detail view (Reddit-style) for an item, without
// prop-drilling through the catalog → card → actions chain.
const OpenDetailContext = createContext<(item: Item) => void>(() => {});
function useOpenDetail(): (item: Item) => void {
  return useContext(OpenDetailContext);
}

// Lost-flow ("I found this") context: current user id + opener, to avoid drilling.
const LostFlowContext = createContext<{ currentUserId: string | null; onFoundThis: (item: Item) => void }>({
  currentUserId: null,
  onFoundThis: () => {},
});
function useLostFlow() {
  return useContext(LostFlowContext);
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

function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5"/>
      <path d="m12 19-7-7 7-7"/>
    </svg>
  );
}

function IconSparkles() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l1.6 4.4a4 4 0 0 0 2.4 2.4l4.4 1.6-4.4 1.6a4 4 0 0 0-2.4 2.4L12 19.3l-1.6-4.4a4 4 0 0 0-2.4-2.4L3.6 10.9l4.4-1.6a4 4 0 0 0 2.4-2.4z"/>
      <path d="M5 3.5l.7 1.9a1.6 1.6 0 0 0 1 1l1.9.7-1.9.7a1.6 1.6 0 0 0-1 1L5 10.6l-.7-1.9a1.6 1.6 0 0 0-1-1L1.4 7l1.9-.7a1.6 1.6 0 0 0 1-1z"/>
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

function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
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
  onShare?: (item: Item) => Promise<ShareResult>;
  extra?: ReactElement | null;
}) {
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const commentCount = countCommentNodes(comments);
  const openDetail = useOpenDetail();

  async function handleShareClick() {
    const result = onShare ? await onShare(repostItem) : "failed";
    if (result === "cancelled") return; // user dismissed the share sheet
    const msg =
      result === "shared" ? "Shared" :
      result === "copied" ? "Link copied" :
      "Couldn't share — try again";
    setShareMsg(msg);
    setTimeout(() => setShareMsg(null), 2000);
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
          onClick={() => openDetail(repostItem)}
          className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full transition-colors"
          style={{ background: "#F5ECEC", color: "#6B3A3A" }}
          aria-label="Comments"
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
    </>
  );
}

// ─── Post Detail (full-screen, Reddit-style) ───────────────────────────────────

function PostDetail({ item, comments, onBack, onAddComment, onAddReply }: {
  item: Item;
  comments: ItemComment[];
  onBack: () => void;
  onAddComment: (message: string) => void;
  onAddReply: (commentId: string, message: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState("");
  const count = countCommentNodes(comments);

  // Close on Escape (back to the list).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onBack(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentDraft.trim()) return;
    onAddComment(commentDraft);
    setCommentDraft("");
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#FBF9D1" }}>
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14 shrink-0" style={{ background: "#FBF9D1", borderBottom: "1px solid #C1856D" }}>
        <button onClick={onBack} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B3A3A" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm truncate" style={{ color: "#2C1414" }}>Post</span>
      </header>

      {/* Scrollable: full post, then comment thread */}
      <div className="flex-1 overflow-y-auto scroll-area">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {/* The post */}
          <div className="pb-4 mb-4" style={{ borderBottom: "1px solid #C1856D" }}>
            <div className="flex items-center gap-2">
              <Avatar id={item.finder_id} name={item.finder_name} size={32} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold" style={{ color: "#2C1414" }}>{item.finder_name || userName(item.finder_id)}</span>
                  {useIsVerified(item.finder_id) && <VerificationBadge size={13} />}
                  <span
                    className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                    style={item.kind === "lost" ? { background: "#F5ECEC", color: "#9A3F3F" } : { background: "#E6CFA9", color: "#5C2020" }}
                  >
                    {item.kind === "lost" ? "Lost" : "Found"}
                  </span>
                  <StatusBadge status={item.status} />
                </div>
                <span className="text-xs" style={{ color: "#9A7070" }}>{postedLabel(item.created_at)}</span>
              </div>
            </div>
            <h1 className="mt-3 font-semibold text-xl leading-snug" style={{ color: "#2C1414" }}>{item.title}</h1>
            {item.description && <p className="mt-2 text-sm leading-relaxed" style={{ color: "#2C1414" }}>{item.description}</p>}
            {item.image_url && (
              <img src={item.image_url} alt={item.title} className="mt-3 w-full max-h-[28rem] object-cover rounded-xl" />
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              {item.location_found && <span className="flex items-center gap-1 text-xs" style={{ color: "#6B3A3A" }}><IconMapPin />{item.location_found}</span>}
              {item.time_found && <span className="flex items-center gap-1 text-xs" style={{ color: "#6B3A3A" }}><IconClock />{formatDate(item.time_found)}</span>}
            </div>
          </div>

          <p className="text-sm font-semibold mb-3" style={{ color: "#2C1414" }}>
            {count} {count === 1 ? "comment" : "comments"}
          </p>

          {comments.length === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: "#9A7070" }}>No comments yet. Be the first to comment.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {comments.map(c => (
                <CommentThread key={c.id} node={c} depth={0} onAddReply={onAddReply} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Sticky composer */}
      <form onSubmit={submitComment} className="flex items-center gap-2 p-4 shrink-0" style={{ borderTop: "1px solid #C1856D", background: "#FBF9D1" }}>
        <div className="max-w-2xl mx-auto w-full flex items-center gap-2">
          <input
            type="text"
            value={commentDraft}
            onChange={e => setCommentDraft(e.target.value)}
            placeholder="Write a comment…"
            className="flex-1 px-4 py-2 text-sm rounded-full border focus:outline-none focus:ring-2"
            style={{ background: "#FBF9D1", borderColor: "#C1856D", color: "#2C1414" }}
          />
          <button type="submit" disabled={!commentDraft.trim()} className="px-4 py-2 text-sm font-semibold rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
            Post
          </button>
        </div>
      </form>
    </div>
  );
}

// Recursive comment node: renders a comment/reply, its own Reply input, and its
// children — enabling arbitrary-depth branching (a reply to a reply to a reply…).
function CommentThread({ node, depth, onAddReply }: {
  node: CommentNode;
  depth: number;
  onAddReply: (parentId: string, message: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const avatarSize = depth === 0 ? 28 : 22;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    onAddReply(node.id, draft);
    setDraft("");
    setReplying(false);
  }

  return (
    <div className="flex gap-2">
      <Avatar id={node.author_id} name={node.author_name} size={avatarSize} />
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl px-3 py-2 inline-block max-w-full" style={{ background: "#E6CFA9" }}>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{node.author_name}</span>
            {useIsVerified(node.author_id) && <VerificationBadge size={12} />}
            <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(node.created_at)}</span>
          </div>
          <p className="text-sm leading-snug mt-0.5 break-words" style={{ color: "#2C1414" }}>{node.message}</p>
        </div>
        <button
          type="button"
          onClick={() => { setReplying(r => !r); setDraft(""); }}
          className="text-xs font-medium mt-1 ml-3 hover:underline"
          style={{ color: "#9A3F3F" }}
        >
          Reply
        </button>

        {replying && (
          <form onSubmit={submit} className="flex items-center gap-2 mt-2">
            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder={`Reply to ${node.author_name}…`}
              autoFocus
              className="flex-1 px-3 py-1.5 text-sm rounded-full border focus:outline-none focus:ring-2"
              style={{ background: "#FBF9D1", borderColor: "#C1856D", color: "#2C1414" }}
            />
            <button type="submit" disabled={!draft.trim()} className="px-3 py-1.5 text-xs font-semibold rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
              Reply
            </button>
          </form>
        )}

        {(node.replies?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-3 mt-3 pl-3" style={{ borderLeft: "2px solid #C1856D" }}>
            {node.replies.map(child => (
              <CommentThread key={child.id} node={child} depth={depth + 1} onAddReply={onAddReply} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Item Card ────────────────────────────────────────────────────────────────

function ItemCard({ item, onClaim, onUpvote, upvoted, onRepost, reposted, repostCount, onShare, comments, onAddComment, onAddReply, role, challengeResponseCount = 0 }: {
  item: Item;
  onClaim?: (item: Item) => void;
  onUpvote?: (id: string) => void;
  upvoted?: boolean;
  onRepost?: (item: Item) => void;
  reposted?: boolean;
  repostCount?: number;
  onShare?: (item: Item) => Promise<ShareResult>;
  comments?: ItemComment[];
  onAddComment?: (itemId: string, message: string) => void;
  onAddReply?: (itemId: string, commentId: string, message: string) => void;
  role: Role;
  challengeResponseCount?: number;
}) {
  const commentList = comments ?? [];
  const openDetail = useOpenDetail();
  const lostFlow = useLostFlow();

  return (
    <div className="flex flex-col gap-3 py-4 transition-colors"
      style={{ borderBottom: "1px solid #C1856D" }}>

      {/* Content — clicking opens the full-screen post detail (Reddit-style) */}
      <div
        className="flex flex-col gap-2 min-w-0 cursor-pointer"
        onClick={() => openDetail(item)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter") openDetail(item); }}
      >
        <div className="flex items-center gap-1.5">
          <Avatar id={item.finder_id} name={item.finder_name} size={20} />
          <span className="text-xs font-semibold" style={{ color: "#2C1414" }}>{item.finder_name || userName(item.finder_id)}</span>
          {useIsVerified(item.finder_id) && <VerificationBadge size={13} />}
          <span className="text-xs" style={{ color: "#9A7070" }}>· {postedLabel(item.created_at)}</span>
          <span
            className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={item.kind === "lost"
              ? { background: "#F5ECEC", color: "#9A3F3F" }
              : { background: "#E6CFA9", color: "#5C2020" }}
          >
            {item.kind === "lost" ? "Lost" : "Found"}
          </span>
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

      {/* Full-width photo below the caption (Reddit-style) — also opens detail */}
      {item.image_url && (
        <div className="rounded-lg overflow-hidden cursor-pointer" style={{ background: "#D4B890" }} onClick={() => openDetail(item)}>
          <img src={item.image_url} alt={item.description} className="w-full max-h-96 object-cover" />
        </div>
      )}

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
          // Lost post → "I found this" (not shown to the owner who posted it).
          item.kind === "lost" && lostFlow.currentUserId && item.finder_id !== lostFlow.currentUserId ? (
            <button
              onClick={() => lostFlow.onFoundThis(item)}
              className="ml-auto px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
              style={{ background: "#9A3F3F", color: "#FBF9D1" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
              onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
            >
              I found this
            </button>
          ) :
          // "Prove it's yours" applies only to FOUND items.
          item.kind !== "lost" && role !== "staff" && onClaim && item.status !== "released" ? (
            <div className="ml-auto flex items-center gap-2">
              <span
                className="flex items-center gap-1 text-xs font-medium"
                style={{ color: "#6B3A3A" }}
                title={`${challengeResponseCount} responded`}
              >
                <IconUsers />
                {challengeResponseCount}
              </span>
              <button
                onClick={() => onClaim(item)}
                className="px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
                style={{ background: "#9A3F3F", color: "#FBF9D1" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#7A2E2E")}
                onMouseLeave={e => (e.currentTarget.style.background = "#9A3F3F")}
              >
                Prove it's yours
              </button>
            </div>
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
          {useIsVerified(item.finder_id) && <VerificationBadge size={12} />}
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
    onShare?: (item: Item) => Promise<ShareResult>;
  };
}) {
  return (
    <div className="py-4 flex flex-col gap-2" style={{ borderBottom: "1px solid #C1856D" }}>
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

// ─── Ownership Challenge: answer page ("Prove it's yours", Requirement 16) ──────

function ChallengeModal({ item, onClose, onSubmit }: {
  item: Item;
  onClose: () => void;
  onSubmit: (answers: ChallengeAnswer[], note: string) => void;
}) {
  const questions = item.challenge ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const hasQuestions = questions.length > 0;
  // With questions: all must be answered. Without questions: the note is required
  // so the response carries something for the finder to review.
  const canSubmit = hasQuestions
    ? questions.every(q => (answers[q.id] ?? "").trim().length > 0)
    : note.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const payload: ChallengeAnswer[] = questions.map(q => ({
      question_id: q.id,
      prompt: q.prompt,
      answer: (answers[q.id] ?? "").trim(),
    }));
    onSubmit(payload, note);
    setSubmitted(true);
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto scroll-area" style={{ background: "#FBF9D1" }}>
      {/* Page header */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14" style={{ background: "#FBF9D1", borderBottom: "1px solid #C1856D" }}>
        <button onClick={onClose} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B3A3A" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm" style={{ color: "#2C1414" }}>Prove it's yours</span>
      </header>

      <div className="max-w-lg mx-auto px-4 py-6">
        {submitted ? (
          <div className="text-center py-16">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 className="text-xl font-semibold" style={{ color: "#2C1414" }}>Answers submitted</h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
              The finder will review your answers and follow up. Pickup is handled in person at the admin office.
            </p>
            <button onClick={onClose} className={btnPrimary + " mt-6"}>Done</button>
          </div>
        ) : (
          <>
            {/* Item context */}
            <div className="rounded-xl p-4 mb-6 flex items-start gap-3" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
              {item.image_url && <img src={item.image_url} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />}
              <div className="min-w-0">
                <p className="font-semibold text-sm" style={{ color: "#2C1414" }}>{item.title}</p>
                <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>{hasQuestions ? "Answer the finder's questions to prove this item is yours." : "Send the finder a note explaining why this item is yours."}</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {questions.map((q, i) => (
                <div key={q.id}>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>
                    {i + 1}. {q.prompt} <span style={{ color: "#9A3F3F" }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={answers[q.id] ?? ""}
                    onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                    className={inputCls}
                    required
                  />
                </div>
              ))}

              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>
                  Note to the finder {hasQuestions ? "(optional)" : <span style={{ color: "#9A3F3F" }}>*</span>}
                </label>
                <textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  rows={3}
                  className={inputCls + " resize-none"}
                  placeholder={hasQuestions ? "Anything else that helps prove it's yours…" : "Explain why this item is yours — details only the owner would know…"}
                  required={!hasQuestions}
                />
              </div>

              <p className="text-xs" style={{ color: "#9A7070" }}>Shared only with the finder (and staff if escalated). Never public.</p>

              <button type="submit" disabled={!canSubmit} className={btnPrimary + " w-full py-3 disabled:opacity-40 disabled:cursor-not-allowed"}>
                {hasQuestions ? "Submit answers" : "Send to finder"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Ownership Challenge: finder responses / analytics (Requirement 16) ─────────

function ChallengeResponsesModal({ item, responses, verifiedIds, onClose, onApprove, onReject, onEscalate }: {
  item: Item;
  responses: ChallengeResponse[];
  verifiedIds: Set<string>;
  onClose: () => void;
  onApprove: (responseId: string) => void;
  onReject: (responseId: string) => void;
  onEscalate: (responseId: string) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusStyle: Record<ChallengeResponseStatus, { label: string; bg: string; color: string }> = {
    pending: { label: "Pending", bg: "#FDF3EC", color: "#7A3A1A" },
    approved: { label: "Approved", bg: "#F2EBE5", color: "#5C2020" },
    rejected: { label: "Rejected", bg: "#F5ECEC", color: "#9A3F3F" },
    escalated: { label: "Sent to staff", bg: "#F5ECEC", color: "#9A3F3F" },
    awaiting_owner: { label: "Awaiting owner", bg: "#FDF3EC", color: "#7A3A1A" },
    answered: { label: "Answered", bg: "#F2EBE5", color: "#5C2020" },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Challenge responses">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[85vh] sm:max-h-[80vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-xl" style={{ background: "#FBF9D1" }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-4" style={{ borderBottom: "1px solid #C1856D" }}>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate" style={{ color: "#2C1414" }}>Responses</h3>
            <p className="text-xs truncate" style={{ color: "#9A7070" }}>{responses.length} on “{item.title}”</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ color: "#9A7070" }}><IconX /></button>
        </div>

        <div className="flex-1 overflow-y-auto scroll-area px-4 py-3">
          {responses.length === 0 ? (
            <p className="text-sm py-8 text-center" style={{ color: "#9A7070" }}>No one has answered your challenge yet.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {responses.map(r => {
                const s = statusStyle[r.status];
                return (
                  <div key={r.id} className="rounded-xl p-4" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar id={r.responder_id} name={r.responder_name} size={26} />
                        <span className="text-sm font-semibold" style={{ color: "#2C1414" }}>{r.responder_name}</span>
                        {verifiedIds.has(r.responder_id) && <VerificationBadge size={12} />}
                      </div>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                    </div>

                    <div className="mt-3 flex flex-col gap-2">
                      {r.answers.map(a => (
                        <div key={a.question_id} className="rounded-lg p-2.5" style={{ background: "#FBF9D1", border: "1px solid #C1856D" }}>
                          <p className="text-xs font-medium" style={{ color: "#6B3A3A" }}>{a.prompt}</p>
                          <p className="text-sm mt-0.5" style={{ color: "#2C1414" }}>{a.answer}</p>
                        </div>
                      ))}
                      {r.note && (
                        <div className="rounded-lg p-2.5" style={{ background: "#F5ECEC", border: "1px solid #C1856D" }}>
                          <p className="text-xs font-medium" style={{ color: "#6B3A3A" }}>Note</p>
                          <p className="text-sm mt-0.5" style={{ color: "#2C1414" }}>{r.note}</p>
                        </div>
                      )}
                    </div>

                    {r.status === "pending" && (
                      <div className="flex flex-wrap gap-2 mt-3 pt-3" style={{ borderTop: "1px solid #C1856D" }}>
                        <button onClick={() => onApprove(r.id)} className="flex-1 min-w-[6rem] py-2 text-xs font-semibold rounded-lg" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>Approve</button>
                        <button onClick={() => onReject(r.id)} className="flex-1 min-w-[6rem] py-2 text-xs font-semibold rounded-lg" style={{ border: "1px solid #C1856D", color: "#9A3F3F", background: "transparent" }}>Reject</button>
                        <button onClick={() => onEscalate(r.id)} className="flex-1 min-w-[6rem] py-2 text-xs font-semibold rounded-lg" style={{ border: "1px solid #C1856D", color: "#6B3A3A", background: "transparent" }}>Send to staff</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── "I found this" flow (lost posts, Requirement 17) ───────────────────────────
// Full-screen. Three modes derived from the current user + existing report:
//   author        — finder writes questions + note (no report yet)
//   owner-answer   — the lost post's owner fills the finder's questions
//   finder-review  — finder reads the owner's answers, approves/rejects
function LostFlowModal({ item, currentUserId, report, onClose, onSubmitReport, onOwnerAnswer, onApprove, onReject }: {
  item: Item;
  currentUserId: string;
  report?: ChallengeResponse; // existing report for (this item, this finder) if any
  onClose: () => void;
  onSubmitReport: (item: Item, questions: ChallengeQuestion[], note: string) => void;
  onOwnerAnswer: (responseId: string, answers: ChallengeAnswer[]) => void;
  onApprove: (responseId: string) => void;
  onReject: (responseId: string) => void;
}) {
  const isOwner = currentUserId === item.finder_id;
  const mode: "author" | "owner-answer" | "finder-review" =
    !report ? "author" : (isOwner && report.status === "awaiting_owner") ? "owner-answer" : "finder-review";

  // author state
  const [qs, setQs] = useState<ChallengeQuestion[]>([]);
  const [note, setNote] = useState("");
  // owner-answer state
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function addQ() { setQs(v => [...v, { id: `q${Date.now()}${v.length}`, prompt: "" }]); }
  function updateQ(id: string, prompt: string) { setQs(v => v.map(q => q.id === id ? { ...q, prompt } : q)); }
  function removeQ(id: string) { setQs(v => v.filter(q => q.id !== id)); }

  function submitAuthor(e: React.FormEvent) {
    e.preventDefault();
    onSubmitReport(item, qs, note);
    setSubmitted(true);
  }
  function submitOwnerAnswers(e: React.FormEvent) {
    e.preventDefault();
    if (!report) return;
    const filled = report.answers.map(a => ({ ...a, answer: (answers[a.question_id] ?? "").trim() }));
    if (filled.some(a => !a.answer)) return;
    onOwnerAnswer(report.id, filled);
    setSubmitted(true);
  }

  const title =
    mode === "author" ? "I found this" :
    mode === "owner-answer" ? "Verify it's yours" :
    "Review answers";

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#FBF9D1" }}>
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14 shrink-0" style={{ background: "#FBF9D1", borderBottom: "1px solid #C1856D" }}>
        <button onClick={onClose} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B3A3A" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm" style={{ color: "#2C1414" }}>{title}</span>
      </header>

      <div className="flex-1 overflow-y-auto scroll-area">
        <div className="max-w-lg mx-auto px-4 py-6">
          {/* Item context */}
          <div className="rounded-xl p-4 mb-6 flex items-start gap-3" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
            {item.image_url && <img src={item.image_url} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />}
            <div className="min-w-0">
              <p className="font-semibold text-sm" style={{ color: "#2C1414" }}>{item.title}</p>
              <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>
                {mode === "author" && "Ask questions only the real owner can answer, then send it to them."}
                {mode === "owner-answer" && "Someone found your item. Answer to prove it's yours."}
                {mode === "finder-review" && "The owner's answers to your questions."}
              </p>
            </div>
          </div>

          {submitted ? (
            <div className="text-center py-12">
              <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <p className="font-semibold" style={{ color: "#2C1414" }}>{mode === "author" ? "Sent to the owner" : "Answers submitted"}</p>
              <p className="mt-2 text-sm" style={{ color: "#6B3A3A" }}>You'll get a notification when there's an update.</p>
              <button onClick={onClose} className={btnPrimary + " mt-6"}>Done</button>
            </div>
          ) : mode === "author" ? (
            <form onSubmit={submitAuthor} className="flex flex-col gap-5">
              <div>
                <label className="block text-sm font-semibold mb-1" style={{ color: "#2C1414" }}>Verification questions</label>
                <p className="text-xs mb-3" style={{ color: "#6B3A3A" }}>Ask something only the owner would know (e.g. "What's the lock-screen photo?", "Any stickers?").</p>
                {qs.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {qs.map((q, i) => (
                      <div key={q.id} className="flex items-center gap-2">
                        <span className="text-xs font-semibold w-4 shrink-0" style={{ color: "#9A3F3F" }}>{i + 1}.</span>
                        <input type="text" value={q.prompt} onChange={e => updateQ(q.id, e.target.value)} placeholder="Type a question…" className={inputCls + " flex-1"} />
                        <button type="button" onClick={() => removeQ(q.id)} aria-label="Remove" className="shrink-0 p-1.5" style={{ color: "#9A7070" }}><IconX /></button>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" onClick={addQ} className={btnSecondary + " inline-flex items-center gap-1.5"}>
                  <span className="text-base leading-none">+</span> Add question
                </button>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Note to the owner (optional)</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} className={inputCls + " resize-none"} placeholder="Where you found it, how to reach you, etc." />
              </div>
              <button type="submit" className={btnPrimary + " w-full py-3"}>Send to owner</button>
            </form>
          ) : mode === "owner-answer" && report ? (
            <form onSubmit={submitOwnerAnswers} className="flex flex-col gap-5">
              {report.note && (
                <div className="rounded-lg p-3 text-sm" style={{ background: "#F5ECEC", border: "1px solid #C1856D", color: "#2C1414" }}>
                  <span className="font-semibold">Note from {report.responder_name}: </span>{report.note}
                </div>
              )}
              {report.answers.map((a, i) => (
                <div key={a.question_id}>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>{i + 1}. {a.prompt} <span style={{ color: "#9A3F3F" }}>*</span></label>
                  <input type="text" value={answers[a.question_id] ?? ""} onChange={e => setAnswers(v => ({ ...v, [a.question_id]: e.target.value }))} className={inputCls} required />
                </div>
              ))}
              <button type="submit" className={btnPrimary + " w-full py-3"}>Submit answers</button>
            </form>
          ) : report ? (
            <div className="flex flex-col gap-4">
              {report.note && (
                <div className="rounded-lg p-3 text-sm" style={{ background: "#F5ECEC", border: "1px solid #C1856D", color: "#2C1414" }}>
                  <span className="font-semibold">Your note: </span>{report.note}
                </div>
              )}
              {report.status === "awaiting_owner" ? (
                <p className="text-sm py-8 text-center" style={{ color: "#9A7070" }}>Waiting for the owner to answer your questions…</p>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    {report.answers.map(a => (
                      <div key={a.question_id} className="rounded-lg p-3" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                        <p className="text-xs font-medium" style={{ color: "#6B3A3A" }}>{a.prompt}</p>
                        <p className="text-sm mt-0.5" style={{ color: "#2C1414" }}>{a.answer || "—"}</p>
                      </div>
                    ))}
                  </div>
                  {report.status === "answered" ? (
                    <div className="flex gap-3 pt-2">
                      <button onClick={() => { onApprove(report.id); onClose(); }} className="flex-1 py-2.5 text-sm font-semibold rounded-lg" style={{ background: "#9A3F3F", color: "#FBF9D1" }}>Approve — it's them</button>
                      <button onClick={() => { onReject(report.id); onClose(); }} className="flex-1 py-2.5 text-sm font-semibold rounded-lg" style={{ border: "1px solid #C1856D", color: "#9A3F3F", background: "transparent" }}>Reject</button>
                    </div>
                  ) : (
                    <p className="text-sm font-semibold text-center py-2" style={{ color: "#9A3F3F" }}>
                      {report.status === "approved" ? "You approved this owner." : "You rejected this."}
                    </p>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Catalog View ─────────────────────────────────────────────────────────────

function CatalogView({ items, role, user, search, categoryFilter, onClaim, onUpvote, upvotedIds, onRepost, repostCounts, myRepostItemIds, reposts, onShare, comments, onAddComment, onAddReply, challengeResponseCounts }: {
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
  onShare: (item: Item) => Promise<ShareResult>;
  comments: Record<string, ItemComment[]>;
  onAddComment: (itemId: string, message: string) => void;
  onAddReply: (itemId: string, commentId: string, message: string) => void;
  challengeResponseCounts: Record<string, number>;
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
      {filtered.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>No items match your search</p>
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Try a different category or search term from the header</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {filtered.map(item => {
            const itemReposts = reposts.filter(r => r.item_id === item.id);
            return (
              <div key={item.id} className="flex flex-col">
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
                  challengeResponseCount={challengeResponseCounts[item.id] ?? 0}
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

function FinderForm({ onSubmit }: {
  onSubmit: (item: Partial<Item>) => void;
}) {
  const [mode, setMode] = useState<"found" | "lost">("found");
  const [form, setForm] = useState({ title: "", category: "", location_found: "", time_found: "", description: "", private_note: "" });
  // Lost-mode fields (map to the missing-notice model). Same shape as the found
  // form minus the ownership challenge.
  const [lostForm, setLostForm] = useState({ title: "", category: "", description: "", location_lost: "", time_lost: "", note: "" });
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoData, setPhotoData] = useState<string | null>(null); // data URL of the selected image
  const [submitted, setSubmitted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [caption, setCaption] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [showCaptionImport, setShowCaptionImport] = useState(false);
  // Ownership Challenge (optional): finder-authored short-text questions.
  const [challengeQs, setChallengeQs] = useState<ChallengeQuestion[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  }

  function addChallengeQ() {
    setChallengeQs(qs => [...qs, { id: `q${Date.now()}${qs.length}`, prompt: "" }]);
  }
  function updateChallengeQ(id: string, prompt: string) {
    setChallengeQs(qs => qs.map(q => q.id === id ? { ...q, prompt } : q));
  }
  function removeChallengeQ(id: string) {
    setChallengeQs(qs => qs.filter(q => q.id !== id));
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
      } else if (mode === "lost") {
        // Lost mode: map the parsed fields onto the lost form (location → where lost).
        setLostForm(f => ({
          ...f,
          title: parsed.title || f.title,
          category: parsed.category || f.category,
          location_lost: parsed.location_found || f.location_lost,
          description: parsed.description || f.description,
          time_lost: f.time_lost || nowForDateTimeLocal(),
        }));
        setImportMsg("Filled from caption. Review the fields before posting.");
      } else {
        setForm(f => ({
          ...f,
          title: parsed.title || f.title,
          category: parsed.category || f.category,
          location_found: parsed.location_found || f.location_found,
          description: parsed.description || f.description,
          // Caption text doesn't specify a time found — default to now (today),
          // but keep it editable so the finder can correct it before logging.
          time_found: f.time_found || nowForDateTimeLocal(),
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
    const reader = new FileReader();
    reader.onload = () => {
      setPhotoData(String(reader.result));
      setPhotoName(file.name);
      setProcessing(false);
    };
    reader.onerror = () => { setProcessing(false); };
    reader.readAsDataURL(file);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (mode === "lost") {
      // Lost posts are items with kind="lost" so they appear in the shared
      // catalog for everyone (location_lost/time_lost map to location/time).
      onSubmit({
        kind: "lost",
        title: lostForm.title,
        category: lostForm.category,
        location_found: lostForm.location_lost,
        time_found: lostForm.time_lost,
        description: lostForm.description,
        private_note: lostForm.note.trim() || undefined,
        status: "in_office",
        upvotes: 0,
        ...(photoData ? { image_url: photoData } : {}),
      });
      return;
    }
    const challenge = challengeQs
      .map(q => ({ ...q, prompt: q.prompt.trim() }))
      .filter(q => q.prompt.length > 0);
    onSubmit({
      ...form,
      status: "pending_intake",
      upvotes: 0,
      ...(photoData ? { image_url: photoData } : {}),
      ...(challenge.length > 0 ? { challenge } : {}),
    });
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 className="text-xl font-semibold" style={{ color: "#2C1414" }}>{mode === "lost" ? "Lost item posted" : "Item logged"}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
          {mode === "lost"
            ? "Your lost-item post is now in the catalog for everyone to see. If someone finds it, they can respond there."
            : "Drop it off at the admin office (Room 101, Main Hall) to complete intake. The item won't appear in the public catalog until staff confirm physical custody."}
        </p>
        <button
          onClick={() => { setSubmitted(false); setForm({ title: "", category: "", location_found: "", time_found: "", description: "", private_note: "" }); setLostForm({ title: "", category: "", description: "", location_lost: "", time_lost: "", note: "" }); setPhotoName(null); setPhotoData(null); setChallengeQs([]); }}
          className={btnPrimary + " mt-6"}
        >
          {mode === "lost" ? "Post another" : "Log another item"}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "#2C1414" }}>Log a Found/Lost Item</h1>
          <p className="mt-1 text-sm" style={{ color: "#6B3A3A" }}>
            {mode === "found"
              ? "Found something? Enter the details and drop it off at the admin office."
              : "Lost something? Post a notice so it's on record if it's turned in."}
          </p>
        </div>
        {!showCaptionImport && (
          <button
            type="button"
            onClick={() => setShowCaptionImport(true)}
            className="inline-flex items-center justify-center w-10 h-10 rounded-lg border shrink-0 transition-colors"
            style={{ borderColor: "#C1856D", color: "#9A3F3F", background: "#F5ECEC" }}
            aria-label="Generate from caption"
            title="Generate from caption"
          >
            <IconSparkles />
          </button>
        )}
      </div>

      {/* Found / Lost mode toggle */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg w-full sm:w-fit" style={{ background: "#E6CFA9" }}>
        {([
          { id: "found" as const, label: "I found something" },
          { id: "lost" as const, label: "I lost something" },
        ]).map(m => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className="flex-1 sm:flex-none px-4 py-2 text-sm font-medium rounded-md transition-colors"
            style={mode === m.id ? { background: "#FBF9D1", color: "#2C1414" } : { color: "#6B3A3A" }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "lost" && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Title <span style={{ color: "#9A3F3F" }}>*</span></label>
            <input
              type="text"
              value={lostForm.title}
              onChange={e => setLostForm(f => ({ ...f, title: e.target.value }))}
              required
              placeholder="A short headline, e.g. 'Lost: black earbuds near the library'"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Category <span style={{ color: "#9A3F3F" }}>*</span></label>
            <select
              value={lostForm.category}
              onChange={e => setLostForm(f => ({ ...f, category: e.target.value }))}
              required
              className={inputCls}
            >
              <option value="">Select a category</option>
              {CATEGORIES.slice(1).map(c => <option key={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Where did you lose it? <span style={{ color: "#9A3F3F" }}>*</span></label>
            <input
              type="text"
              value={lostForm.location_lost}
              onChange={e => setLostForm(f => ({ ...f, location_lost: e.target.value }))}
              required
              placeholder="Building, room, or outdoor area"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>When did you lose it? <span style={{ color: "#9A3F3F" }}>*</span></label>
            <input
              type="datetime-local"
              value={lostForm.time_lost}
              onChange={e => setLostForm(f => ({ ...f, time_lost: e.target.value }))}
              required
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Description <span style={{ color: "#9A3F3F" }}>*</span></label>
            <textarea
              value={lostForm.description}
              onChange={e => setLostForm(f => ({ ...f, description: e.target.value }))}
              required
              rows={3}
              placeholder="Color, brand, notable markings, contents..."
              className={inputCls + " resize-none"}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Private note to staff</label>
            <textarea
              value={lostForm.note}
              onChange={e => setLostForm(f => ({ ...f, note: e.target.value }))}
              rows={2}
              placeholder="Context the catalog shouldn't show — condition, exact location, etc."
              className={inputCls + " resize-none"}
            />
            <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Staff only — not visible publicly.</p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: "#2C1414" }}>Photo</label>
            <div
              className="rounded-lg p-5 text-center cursor-pointer transition-colors"
              style={{ border: "2px dashed #C1856D", background: "#F5ECEC" }}
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
              {photoData ? (
                <div className="flex flex-col items-center gap-2">
                  <img src={photoData} alt="Selected preview" className="w-24 h-24 object-cover rounded-lg" />
                  <p className="text-xs" style={{ color: "#9A7070" }}>Tap to change photo</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2" style={{ color: "#9A7070" }}>
                  <IconCamera />
                  <p className="text-sm">Tap to add a photo</p>
                </div>
              )}
            </div>
          </div>

          <p className="text-xs" style={{ color: "#9A7070" }}>This posts a passive missing notice — it doesn't enter the office's held-item flow.</p>
          <button type="submit" className={btnPrimary + " w-full py-3"}>Post missing notice</button>
        </form>
      )}

      {mode === "found" && (
      <>
      {/* found-mode content follows */}

      {/* AI caption import — collapsed by default to keep the form clean */}
      {showCaptionImport && (
        <div className="rounded-lg p-4 mb-5" style={{ background: "#F5ECEC", border: "1px dashed #C1856D" }}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <label className="block text-sm font-semibold mb-1.5" style={{ color: "#2C1414" }}>Fill from a post caption</label>
              <p className="text-xs mb-2" style={{ color: "#6B3A3A" }}>Paste a post caption to auto-fill the form.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowCaptionImport(false)}
              aria-label="Hide caption import"
              style={{ color: "#9A7070" }}
            >
              <IconX />
            </button>
          </div>
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value)}
            rows={3}
            placeholder="Paste caption here…"
            className={inputCls + " resize-none"}
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={handleFillFromCaption}
              disabled={!caption.trim() || importing}
              className={btnPrimary + " inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"}
            >
              <IconSparkles />
              {importing ? "Generating…" : "Generate"}
            </button>
            {importMsg && <span className="text-xs" style={{ color: "#6B3A3A" }}>{importMsg}</span>}
          </div>
        </div>
      )}

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
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Staff only — not visible publicly.</p>
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
              <div className="flex flex-col items-center gap-2">
                {photoData && <img src={photoData} alt="Selected preview" className="w-24 h-24 object-cover rounded-lg" />}
                <p className="text-sm font-medium" style={{ color: "#9A3F3F" }}>{photoName}</p>
                <p className="text-xs" style={{ color: "#9A7070" }}>Tap to change photo</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2" style={{ color: "#9A7070" }}>
                <IconCamera />
                <p className="text-sm">Tap to add a photo</p>
                <p className="text-xs">Location data is removed automatically.</p>
              </div>
            )}
          </div>
        </div>

        {/* Ownership Challenge (optional) — questions only the real owner can answer */}
        <div className="rounded-lg p-4" style={{ background: "#F5ECEC", border: "1px dashed #C1856D" }}>
          <label className="block text-sm font-semibold mb-1" style={{ color: "#2C1414" }}>Ownership challenge (optional)</label>
          <p className="text-xs mb-3" style={{ color: "#6B3A3A" }}>
            Add questions only the real owner could answer (e.g. "What's the serial number?", "What's inside?"). Claimants answer these when they tap "Prove it's yours".
          </p>
          {challengeQs.length > 0 && (
            <div className="flex flex-col gap-2 mb-2">
              {challengeQs.map((q, i) => (
                <div key={q.id} className="flex items-center gap-2">
                  <span className="text-xs font-semibold w-4 shrink-0" style={{ color: "#9A3F3F" }}>{i + 1}.</span>
                  <input
                    type="text"
                    value={q.prompt}
                    onChange={e => updateChallengeQ(q.id, e.target.value)}
                    placeholder="Type a question…"
                    className={inputCls + " flex-1"}
                  />
                  <button
                    type="button"
                    onClick={() => removeChallengeQ(q.id)}
                    aria-label="Remove question"
                    className="shrink-0 p-1.5 rounded-lg transition-colors"
                    style={{ color: "#9A7070" }}
                  >
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={addChallengeQ} className={btnSecondary + " inline-flex items-center gap-1.5"}>
            <span className="text-base leading-none">+</span> Add question
          </button>
        </div>

        <button type="submit" className={btnPrimary + " w-full py-3"}>Log found item</button>
      </form>
      </>
      )}
    </div>
  );
}

// ─── Missing Notices ──────────────────────────────────────────────────────────

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

type View = "catalog" | "log" | "claims" | "profile" | "staff" | "notifications";

function Nav({ view, setView, role, user, search, setSearch, categoryFilter, setCategoryFilter, offlineQueueCount, unreadCount }: {
  view: View;
  setView: (v: View) => void;
  role: Role;
  user: AuthUser;
  search: string;
  setSearch: (s: string) => void;
  categoryFilter: string;
  setCategoryFilter: (c: string) => void;
  offlineQueueCount: number;
  unreadCount: number;
}) {
  const navItems: { id: View; label: string; roles: Role[] }[] = [
    { id: "catalog", label: "Catalog", roles: ["finder", "owner", "staff"] },
    { id: "log", label: "Log Item", roles: ["finder", "owner"] },
    { id: "claims", label: "My Claims", roles: ["owner"] },
    { id: "notifications", label: "Notifications", roles: ["finder", "owner", "staff"] },
    { id: "staff", label: "Staff", roles: ["staff"] },
  ];

  const visible = navItems.filter(n => n.roles.includes(role));
  const canCreate = role !== "staff";
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  // On mobile, focusing the search hides the wordmark so the field gets full width.
  const [searchFocused, setSearchFocused] = useState(false);

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
        <button
          onClick={() => setView("catalog")}
          className={(searchFocused ? "hidden sm:flex" : "flex") + " items-center gap-2 shrink-0"}
          aria-label="Home"
        >
          <span className="font-semibold text-2xl block" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
          </span>
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
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search"
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
            onClick={() => setView("notifications")}
            className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg transition-colors shrink-0"
            style={{ color: view === "notifications" ? "#9A3F3F" : "#2C1414" }}
            aria-label="Notifications"
            title="Notifications"
          >
            <IconBell />
            {unreadCount > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                style={{ background: "#9A3F3F", color: "#FBF9D1" }}
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
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
      <div className={"fixed inset-0 z-50 " + (menuOpen ? "" : "pointer-events-none")} aria-hidden={!menuOpen}>
        <div
          className={"absolute inset-0 bg-black/40 transition-opacity duration-300 " + (menuOpen ? "opacity-100" : "opacity-0")}
          onClick={() => setMenuOpen(false)}
        />
        <aside
          className={"absolute left-0 top-0 bottom-0 w-64 max-w-[80%] p-4 flex flex-col gap-1 shadow-xl transition-transform duration-300 ease-out " + (menuOpen ? "translate-x-0" : "-translate-x-full")}
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

function LandingPage({ onGetStarted }: { onGetStarted: () => void }) {
  const steps = [
    { n: "1", title: "Log it", body: "Found something? Log the details in seconds — works even offline." },
    { n: "2", title: "Staff verify custody", body: "The admin office confirms it physically has the item before it goes public." },
    { n: "3", title: "Claim it privately", body: "Owners prove ownership in a private thread with staff. No stranger messages." },
    { n: "4", title: "Pick it up", body: "Once verified, staff approve release and you collect your item at the office." },
  ];
  return (
    <div className="min-h-[100dvh]" style={{ background: "#FBF9D1", color: "#2C1414" }}>
      {/* Nav — single line, slim */}
      <header className="sticky top-0 z-40 backdrop-blur" style={{ background: "rgba(251,249,209,0.85)", borderBottom: "1px solid #E6CFA9" }}>
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <span className="font-semibold text-2xl" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
          </span>
          <button
            onClick={onGetStarted}
            className="px-4 py-2 text-sm font-semibold rounded-lg transition-all active:scale-[0.98]"
            style={{ background: "#9A3F3F", color: "#FBF9D1", boxShadow: "0 1px 2px rgba(154,63,63,0.2)" }}
          >
            Sign in
          </button>
        </div>
      </header>

      {/* Hero — asymmetric split */}
      <section className="max-w-6xl mx-auto px-5 pt-16 pb-20 grid lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-7">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
            style={{ background: "#F5ECEC", color: "#9A3F3F", border: "1px solid #E8C4AD" }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#9A3F3F" }} />
            Campus admin office · verified
          </span>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight">
            Lost it on campus?{" "}
            <span style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
              <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
            </span>{" "}
            probably has it.
          </h1>
          <p className="mt-5 text-lg leading-relaxed max-w-[52ch]" style={{ color: "#6B3A3A" }}>
            The office's real lost-and-found, online. Finders log items, staff verify custody, and you claim what's yours — privately.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              onClick={onGetStarted}
              className="inline-flex items-center gap-2 px-6 py-3 text-base font-semibold rounded-xl transition-all active:scale-[0.98]"
              style={{ background: "#9A3F3F", color: "#FBF9D1", boxShadow: "0 4px 14px rgba(154,63,63,0.25)" }}
            >
              Get started
              <IconArrowRight />
            </button>
            <span className="text-sm" style={{ color: "#9A7070" }}>Free · sign in with Google</span>
          </div>
        </div>

        {/* Hero visual — a branded "found item" ticket, not a fake screenshot */}
        <div className="lg:col-span-5">
          <div className="relative">
            <div className="absolute -inset-4 rounded-3xl opacity-60" aria-hidden="true"
              style={{ background: "radial-gradient(300px circle at 70% 20%, rgba(193,133,109,0.35), transparent 60%)" }} />
            <div className="relative rounded-2xl p-5 rotate-1 hover:rotate-0 transition-transform duration-300"
              style={{ background: "#FBF9D1", border: "1px solid #C1856D", boxShadow: "0 10px 30px rgba(154,63,63,0.15)" }}>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: "#F2EBE5", color: "#5C2020", border: "1px solid #D4A896" }}>In office</span>
                <span className="text-xs" style={{ color: "#9A7070" }}>#FND-2043</span>
              </div>
              <div className="w-full h-28 rounded-xl mb-4 flex items-center justify-center" style={{ background: "#E6CFA9" }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </div>
              <h3 className="font-semibold" style={{ color: "#2C1414" }}>Black wireless earbuds</h3>
              <p className="text-sm mt-1" style={{ color: "#6B3A3A" }}>Found near the Library entrance</p>
              <div className="mt-4 pt-4 flex items-center justify-between" style={{ borderTop: "1px solid #E6CFA9" }}>
                <span className="text-xs" style={{ color: "#9A7070" }}>Verified by staff</span>
                <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "#9A3F3F" }}>
                  Claim
                  <IconArrowRight />
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust strip — divided, not cards */}
      <section style={{ background: "#9A3F3F", color: "#FBF9D1" }}>
        <div className="max-w-6xl mx-auto px-5 py-10 grid grid-cols-1 sm:grid-cols-3 sm:divide-x" style={{ borderColor: "rgba(255,255,255,0.15)" }}>
          {[
            { k: "Verified", v: "Every item confirmed in-office before it's public" },
            { k: "Private", v: "Claims happen in a staff-reviewed thread only" },
            { k: "Minimal", v: "We use just your name and email — nothing more" },
          ].map((s, i) => (
            <div key={s.k} className={i === 0 ? "sm:pr-8" : "sm:px-8 pt-6 sm:pt-0"}>
              <p className="text-lg font-semibold">{s.k}</p>
              <p className="mt-1 text-sm leading-relaxed" style={{ color: "#F5ECEC" }}>{s.v}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — stepped rail, distinct layout family */}
      <section className="max-w-4xl mx-auto px-5 py-20">
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">How it works</h2>
        <p className="mt-3 text-base max-w-[55ch]" style={{ color: "#6B3A3A" }}>
          A strict, auditable flow — not a social feed. Four steps from found to reunited.
        </p>
        <ol className="mt-10 flex flex-col gap-6">
          {steps.map((s, i) => (
            <li key={s.n} className="flex gap-5">
              <div className="flex flex-col items-center">
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-full text-base font-bold shrink-0"
                  style={{ background: "#9A3F3F", color: "#FBF9D1" }}>{s.n}</span>
                {i < steps.length - 1 && <span className="w-px flex-1 mt-2" style={{ background: "#E6CFA9" }} />}
              </div>
              <div className="pb-2">
                <h3 className="text-lg font-semibold" style={{ color: "#2C1414" }}>{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed max-w-[50ch]" style={{ color: "#6B3A3A" }}>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Closing CTA band */}
      <section className="px-5 pb-20">
        <div className="max-w-6xl mx-auto rounded-3xl px-8 py-14 text-center relative overflow-hidden"
          style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
          <div className="pointer-events-none absolute inset-0" aria-hidden="true"
            style={{ background: "radial-gradient(500px circle at 50% 0%, rgba(154,63,63,0.12), transparent 60%)" }} />
          <h2 className="relative text-3xl md:text-4xl font-bold tracking-tight">Lost something? Let's find it.</h2>
          <p className="relative mt-3 text-base max-w-[46ch] mx-auto" style={{ color: "#6B3A3A" }}>
            Sign in to browse verified found items or log something you picked up.
          </p>
          <button
            onClick={onGetStarted}
            className="relative mt-8 inline-flex items-center gap-2 px-7 py-3.5 text-base font-semibold rounded-xl transition-all active:scale-[0.98]"
            style={{ background: "#9A3F3F", color: "#FBF9D1", boxShadow: "0 4px 14px rgba(154,63,63,0.25)" }}
          >
            Get started
            <IconArrowRight />
          </button>
        </div>
      </section>

      <footer className="px-5 py-8 text-center text-xs" style={{ color: "#9A7070", borderTop: "1px solid #E6CFA9" }}>
        No public chat. No peer-to-peer contact. Every item verified by the office.
      </footer>
    </div>
  );
}

function SignIn({ onSignIn, onBack }: { onSignIn: () => Promise<void>; onBack?: () => void }) {
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

  const trustPoints = [
    "Every item verified by the admin office",
    "Claims stay private — no stranger messages",
    "Your account is just your name and email",
  ];

  return (
    <div className="min-h-[100dvh] grid lg:grid-cols-2" style={{ background: "#FBF9D1" }}>
      {/* Brand panel — carries the trust story */}
      <div
        className="relative hidden lg:flex flex-col justify-between p-10 overflow-hidden"
        style={{ background: "#9A3F3F", color: "#FBF9D1" }}
      >
        {/* soft layered glows, tinted to the panel hue (no AI-purple) */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true"
          style={{ background: "radial-gradient(600px circle at 15% 10%, rgba(255,255,255,0.10), transparent 45%), radial-gradient(500px circle at 90% 90%, rgba(193,133,109,0.35), transparent 50%)" }} />
        <div className="relative">
          <span className="text-3xl font-semibold" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#FBF9D1" }}>Found</span><span style={{ color: "#E8B89E" }}>it</span>
          </span>
        </div>
        <div className="relative">
          <h2 className="text-3xl font-bold leading-tight tracking-tight max-w-sm">
            The campus lost-and-found you can actually trust.
          </h2>
          <ul className="mt-8 flex flex-col gap-4">
            {trustPoints.map(p => (
              <li key={p} className="flex items-start gap-3 text-sm" style={{ color: "#F5ECEC" }}>
                <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0"
                  style={{ background: "rgba(255,255,255,0.16)" }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FBF9D1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs" style={{ color: "#E8B89E" }}>
          No public chat. No peer-to-peer contact. Custody verified before pickup.
        </p>
      </div>

      {/* Sign-in card */}
      <div className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          {onBack && (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-sm font-medium mb-8 transition-colors hover:opacity-70"
              style={{ color: "#6B3A3A" }}
            >
              <IconArrowLeft />
              Back
            </button>
          )}

          {/* brand shown on mobile where the panel is hidden */}
          <span className="lg:hidden text-2xl font-semibold block mb-6" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
          </span>

          <h1 className="text-3xl font-bold tracking-tight" style={{ color: "#2C1414" }}>Welcome back</h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
            Sign in to log found items and claim what's yours.
          </p>

          <button
            onClick={handleClick}
            disabled={busy}
            className="mt-8 w-full flex items-center justify-center gap-3 px-4 py-3 text-sm font-semibold rounded-xl transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: "#FBF9D1", color: "#2C1414", border: "1.5px solid #C1856D", boxShadow: "0 1px 2px rgba(154,63,63,0.08)" }}
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
            <p className="mt-3 text-sm font-medium flex items-center gap-1.5" style={{ color: "#9A3F3F" }}>
              <span aria-hidden="true">⚠</span>{error}
            </p>
          )}

          <div className="mt-8 flex items-center gap-3">
            <span className="h-px flex-1" style={{ background: "#E6CFA9" }} />
            <span className="text-xs" style={{ color: "#9A7070" }}>secured by Google</span>
            <span className="h-px flex-1" style={{ background: "#E6CFA9" }} />
          </div>

          <p className="mt-6 text-xs leading-relaxed" style={{ color: "#9A7070" }}>
            By continuing you agree that only your name and email are used to identify your account. We never post on your behalf.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── My Timeline View ─────────────────────────────────────────────────────────

// ─── My Profile View ──────────────────────────────────────────────────────────

function ProfileView({ user, items, reposts, onRemoveRepost, onSignOut, verification, onSubmitVerification, verifiedIds, responseCounts, onViewResponses }: {
  user: AuthUser;
  items: Item[];
  reposts: Repost[];
  onRemoveRepost: (itemId: string) => void;
  onSignOut: () => void;
  verification?: StudentVerification;
  onSubmitVerification: (docType: DocType, file: File) => Promise<string>;
  verifiedIds: Set<string>;
  responseCounts: Record<string, number>;
  onViewResponses: (item: Item) => void;
}) {
  // Merge the user's posts and reposts into one chronological feed (newest first).
  type FeedEntry =
    | { kind: "post"; created_at: string; item: Item }
    | { kind: "repost"; created_at: string; repost: Repost; item?: Item };
  const feed: FeedEntry[] = [
    ...items
      .filter(i => i.finder_id === user.id)
      .map(i => ({ kind: "post" as const, created_at: i.created_at, item: i })),
    ...reposts
      .filter(r => r.user_id === user.id)
      .map(r => ({ kind: "repost" as const, created_at: r.created_at, repost: r, item: items.find(i => i.id === r.item_id) })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const empty = feed.length === 0;
  const postCount = feed.filter(e => e.kind === "post").length;
  const repostCount = feed.filter(e => e.kind === "repost").length;
  const isVerified = verifiedIds.has(user.id);

  const [docType, setDocType] = useState<DocType>("student_id");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const verifyFileRef = useRef<HTMLInputElement>(null);
  const status = verification?.status ?? "unverified";

  async function handleVerifyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setVerifyBusy(true);
    setVerifyMsg(null);
    try {
      const msg = await onSubmitVerification(docType, file);
      setVerifyMsg(msg);
    } catch {
      setVerifyMsg("Something went wrong reading that file. Please try again.");
    } finally {
      setVerifyBusy(false);
      if (verifyFileRef.current) verifyFileRef.current.value = "";
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Header — Reddit-style profile */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" className="w-20 h-20 rounded-full object-cover" />
          ) : (
            <span className="inline-flex items-center justify-center w-20 h-20 rounded-full text-2xl font-semibold shrink-0" style={{ background: "#9A3F3F", color: "#FBF9D1" }} aria-hidden="true">
              {user.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}
            </span>
          )}
          <button onClick={onSignOut} className={btnSecondary + " shrink-0"}>Sign out</button>
        </div>

        <h1 className="mt-4 text-2xl font-bold flex items-center gap-2" style={{ color: "#2C1414" }}>
          {user.name}
          {isVerified && <VerificationBadge size={20} />}
        </h1>
        <p className="mt-0.5 text-sm truncate" style={{ color: "#6B3A3A" }}>{user.email}</p>

        {/* Stats row */}
        <div className="mt-4 flex items-stretch rounded-xl overflow-hidden" style={{ border: "1px solid #C1856D", background: "#E6CFA9" }}>
          <div className="flex-1 px-4 py-3 text-center">
            <p className="text-lg font-bold" style={{ color: "#2C1414" }}>{postCount}</p>
            <p className="text-xs" style={{ color: "#6B3A3A" }}>{postCount === 1 ? "Post" : "Posts"}</p>
          </div>
          <div className="flex-1 px-4 py-3 text-center" style={{ borderLeft: "1px solid #C1856D" }}>
            <p className="text-lg font-bold" style={{ color: "#2C1414" }}>{repostCount}</p>
            <p className="text-xs" style={{ color: "#6B3A3A" }}>{repostCount === 1 ? "Repost" : "Reposts"}</p>
          </div>
          <div className="flex-1 px-4 py-3 text-center" style={{ borderLeft: "1px solid #C1856D" }}>
            <p className="text-lg font-bold" style={{ color: isVerified ? "#9A3F3F" : "#9A7070" }}>{isVerified ? "Yes" : "No"}</p>
            <p className="text-xs" style={{ color: "#6B3A3A" }}>Verified</p>
          </div>
        </div>
      </div>

      {/* Student verification (Requirement 15) — hidden once verified */}
      {status !== "verified" && (
      <div className="rounded-xl p-5 mb-6" style={{ background: "#F5ECEC", border: "1px solid #C1856D" }}>
        <div className="flex items-center gap-2 mb-1">
          <VerificationBadge size={16} />
          <h2 className="text-sm font-semibold" style={{ color: "#2C1414" }}>Student verification</h2>
        </div>

        <p className="text-sm mb-3" style={{ color: "#6B3A3A" }}>
              {status === "rejected"
                ? "That document wasn't confirmed. You can submit a clearer photo and try again."
                : "Prove you're a student to get a verified badge. Submit your Student ID, Certificate of Registration, or class schedule — we check it automatically in seconds."}
            </p>
            <label className="block text-xs font-medium mb-1" style={{ color: "#2C1414" }}>Document type</label>
            <select
              value={docType}
              onChange={e => setDocType(e.target.value as DocType)}
              className={inputCls + " mb-3"}
            >
              <option value="student_id">Student ID</option>
              <option value="cor">Certificate of Registration (COR)</option>
              <option value="class_schedule">Class schedule</option>
            </select>
            <input ref={verifyFileRef} type="file" accept="image/*" className="hidden" onChange={handleVerifyFile} />
            <button
              type="button"
              onClick={() => verifyFileRef.current?.click()}
              disabled={verifyBusy}
              className={btnPrimary + " inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"}
            >
              {verifyBusy ? "Checking…" : "Get verified"}
            </button>
        <p className="text-xs mt-2" style={{ color: "#9A7070" }}>
          Your document image isn't stored — only the result. Photo/biometric matching isn't used.
        </p>
        {verifyMsg && <p className="text-xs mt-2" style={{ color: "#6B3A3A" }}>{verifyMsg}</p>}
      </div>
      )}

      {empty ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>Nothing here yet</p>
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Items you log and posts you repost will show up on your profile.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {feed.map(entry => (
            entry.kind === "post" ? (
              <div key={entry.item.id} className="flex flex-col gap-2">
                <ItemCard item={entry.item} role={user.role} />
                {entry.item.challenge && entry.item.challenge.length > 0 && (
                  <button
                    onClick={() => onViewResponses(entry.item)}
                    className={btnSecondary + " inline-flex items-center gap-1.5 self-start"}
                  >
                    <IconShield />
                    Responses ({responseCounts[entry.item.id] ?? 0})
                  </button>
                )}
              </div>
            ) : entry.item ? (
              <RepostCard key={entry.repost.id} repost={entry.repost} item={entry.item} onRemove={() => onRemoveRepost(entry.repost.item_id)} />
            ) : null
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Notifications View (Requirement 18) ────────────────────────────────────────

function NotificationsView({ notifications, onOpen }: {
  notifications: AppNotification[];
  onOpen: (n: AppNotification) => void;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-semibold mb-4" style={{ color: "#2C1414" }}>Notifications</h1>
      {notifications.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>Nothing yet</p>
          <p className="text-xs mt-1" style={{ color: "#9A7070" }}>Updates about your posts and found reports will show up here.</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {notifications.map(n => (
            <button
              key={n.id}
              onClick={() => onOpen(n)}
              className="text-left py-4 flex items-start gap-3 transition-colors"
              style={{ borderBottom: "1px solid #C1856D" }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: n.read ? "#9A7070" : "#9A3F3F" }}><IconBell /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug" style={{ color: "#2C1414", fontWeight: n.read ? 400 : 600 }}>{n.message}</p>
                <p className="text-xs mt-0.5" style={{ color: "#9A7070" }}>{postedLabel(n.created_at)}</p>
              </div>
              {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: "#9A3F3F" }} aria-label="Unread" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [view, setView] = useState<View>("catalog");
  const [items, setItems] = usePersistentState<Item[]>("items", MOCK_ITEMS);
  const [claims, setClaims] = usePersistentState<Claim[]>("claims", MOCK_CLAIMS);
  const [claimingItem, setClaimingItem] = useState<Item | null>(null);
  const [upvotedIds, setUpvotedIds] = usePersistentState<Set<string>>("upvotedIds", new Set(), setSerializer);
  const [reposts, setReposts] = usePersistentState<Repost[]>("reposts", []);
  const [comments, setComments] = usePersistentState<Record<string, ItemComment[]>>("comments", {});
  const [verifications, setVerifications] = usePersistentState<Record<string, StudentVerification>>("verifications", {});
  const [challengeResponses, setChallengeResponses] = usePersistentState<ChallengeResponse[]>("challengeResponses", []);
  const [notifications, setNotifications] = usePersistentState<AppNotification[]>("notifications", []);
  const [repostingItem, setRepostingItem] = useState<Item | null>(null);
  const [challengeItem, setChallengeItem] = useState<Item | null>(null); // item whose challenge is being answered
  const [responsesItem, setResponsesItem] = useState<Item | null>(null); // finder viewing responses
  const [detailItem, setDetailItem] = useState<Item | null>(null); // full-screen post detail
  const [foundThisItem, setFoundThisItem] = useState<Item | null>(null); // lost-post "I found this" flow
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [offlineQueueCount] = useState(0);
  // Signed-out routing: show the landing page first, then the sign-in screen.
  const [authView, setAuthView] = useState<"landing" | "login">("landing");

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

  // Phase 3: when Supabase is configured, items come from the shared database
  // (so all users see each other's posts) with realtime updates. This overrides
  // the localStorage `items` slice. When the db is disabled, we keep localStorage.
  useEffect(() => {
    if (!isDbEnabled || !user) return;
    let active = true;
    // Initial load of every shared slice.
    listItems().then(rows => { if (active) setItems(rows as Item[]); });
    listComments().then(map => { if (active) setComments(map as Record<string, ItemComment[]>); });
    listReposts().then(rows => { if (active) setReposts(rows as Repost[]); });
    listChallengeResponses().then(rows => { if (active) setChallengeResponses(rows as ChallengeResponse[]); });
    listVerifications().then(map => { if (active) setVerifications(map as Record<string, StudentVerification>); });
    listNotifications().then(rows => { if (active) setNotifications(rows as AppNotification[]); });
    // Realtime subscriptions keep everyone in sync.
    const unsubItems = subscribeItems(rows => setItems(rows as Item[]));
    const unsubComments = subscribeComments(map => setComments(map as Record<string, ItemComment[]>));
    const unsubReposts = subscribeReposts(rows => setReposts(rows as Repost[]));
    const unsubCR = subscribeChallengeResponses(rows => setChallengeResponses(rows as ChallengeResponse[]));
    const unsubVer = subscribeVerifications(map => setVerifications(map as Record<string, StudentVerification>));
    const unsubNotif = subscribeNotifications(rows => setNotifications(rows as AppNotification[]));
    return () => {
      active = false;
      unsubItems(); unsubComments(); unsubReposts(); unsubCR(); unsubVer(); unsubNotif();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Set of user ids that are verified students — passed to cards/threads so the
  // "Verified student" badge shows next to their names.
  const verifiedIds = new Set(
    Object.values(verifications).filter(v => v.status === "verified").map(v => v.user_id),
  );
  const myVerification = user ? verifications[user.id] : undefined;

  // Count of challenge responses per item (for the finder's "Responses (N)" control).
  const responseCounts = challengeResponses.reduce<Record<string, number>>((acc, r) => {
    acc[r.item_id] = (acc[r.item_id] ?? 0) + 1;
    return acc;
  }, {});

  const myNotifications = user ? notifications.filter(n => n.recipient_id === user.id) : [];
  const unreadCount = myNotifications.filter(n => !n.read).length;

  // Mark notifications read when the Notifications view is open.
  useEffect(() => {
    if (view === "notifications") markNotificationsRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function handleSignIn() {
    await signInWithGoogle();
  }

  async function handleSignOut() {
    await signOut();
    setView("catalog");
    setAuthView("landing");
  }

  function handleUpvote(id: string) {
    setUpvotedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  // Submit a student document for AI-assisted verification (Requirement 15).
  // Reads the image, calls verifyStudent (AI-only), and stores ONLY the decision
  // + extracted fields (never the raw image). Verified on a high-confidence,
  // name-matched pass; otherwise rejected. If the AI is unavailable, nothing is
  // stored and a message is returned for the UI. Returns a user-facing message.
  async function handleSubmitVerification(docType: DocType, file: File): Promise<string> {
    if (!user) return "Please sign in first.";
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    const result = await verifyStudent({
      imageBase64: base64,
      mimeType: file.type || "image/jpeg",
      accountName: user.name,
      docType,
    });

    // AI unavailable → don't store any status; just surface the message.
    if (result.decision === "unavailable") {
      return result.message ?? "Verification is temporarily unavailable.";
    }
    const status: VerificationStatus = result.decision; // "verified" | "rejected"

    const now = new Date().toISOString();
    const record: StudentVerification = {
      user_id: user.id,
      user_name: user.name,
      status,
      doc_type: docType,
      extracted: result.extracted,
      confidence: result.confidence,
      ai_verdict: result.ai_verdict,
      submitted_at: now,
      decided_at: now,
      decided_by: "ai",
    };
    setVerifications(prev => ({ ...prev, [user.id]: record }));
    if (isDbEnabled) upsertVerification(record as unknown as import("./lib/db").DbVerification);
    return result.message ?? (result.decision === "verified" ? "Verified." : "Not confirmed.");
  }

  function handleAddRepost(itemId: string, caption: string) {
    if (!user) return;
    const repost: Repost = {
      id: `rp${Date.now()}`,
      item_id: itemId,
      user_id: user.id,
      user_name: user.name,
      caption: caption.trim() || undefined,
      created_at: new Date().toISOString(),
    };
    setReposts(prev => [repost, ...prev.filter(r => !(r.item_id === itemId && r.user_id === user.id))]);
    if (isDbEnabled) upsertRepost(repost as unknown as import("./lib/db").DbRepost);
  }

  function handleRemoveRepost(itemId: string) {
    if (!user) return;
    setReposts(prev => prev.filter(r => !(r.item_id === itemId && r.user_id === user.id)));
    if (isDbEnabled) removeRepost(itemId, user.id);
  }

  // Share via the native share sheet (Messenger, WhatsApp, Messages, etc.) when
  // available; otherwise copy the link. Returns a status for the UI message.
  async function handleShare(item: Item): Promise<"shared" | "copied" | "failed" | "cancelled"> {
    const url = `${window.location.origin}/?item=${encodeURIComponent(item.id)}`;
    const label = item.kind === "lost" ? "Lost" : "Found";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `Foundit — ${item.title}`,
          text: `${label} on campus: ${item.title}`,
          url,
        });
        return "shared";
      } catch (err) {
        // User dismissed the share sheet — not an error.
        if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
        // Fall through to clipboard on other failures.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      return "copied";
    } catch {
      return "failed";
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
    if (isDbEnabled) insertComment({
      id: comment.id, post_id: itemId, parent_id: null,
      author_id: comment.author_id, author_name: comment.author_name,
      message: comment.message, created_at: comment.created_at,
    });
  }

  function handleAddReply(itemId: string, parentId: string, message: string) {
    if (!user || !message.trim()) return;
    const reply: CommentNode = {
      id: `rp${Date.now()}`,
      author_id: user.id,
      author_name: user.name,
      message: message.trim(),
      created_at: new Date().toISOString(),
      replies: [],
    };
    // Immutably append `reply` under the node whose id === parentId, at any depth.
    const addInto = (nodes: CommentNode[]): CommentNode[] =>
      nodes.map(n =>
        n.id === parentId
          ? { ...n, replies: [...(n.replies ?? []), reply] }
          : { ...n, replies: addInto(n.replies ?? []) },
      );
    setComments(prev => ({ ...prev, [itemId]: addInto(prev[itemId] ?? []) }));
    if (isDbEnabled) insertComment({
      id: reply.id, post_id: itemId, parent_id: parentId,
      author_id: reply.author_id, author_name: reply.author_name,
      message: reply.message, created_at: reply.created_at,
    });
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

  // ─── Notifications (Requirement 18) ────────────────────────────────────────
  function pushNotification(recipientId: string, message: string, itemId?: string, responseId?: string) {
    if (!recipientId) return;
    const notif: AppNotification = {
      id: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      recipient_id: recipientId,
      message,
      item_id: itemId,
      response_id: responseId,
      read: false,
      created_at: new Date().toISOString(),
    };
    setNotifications(prev => [notif, ...prev]);
    if (isDbEnabled) insertNotification(notif as unknown as import("./lib/db").DbNotification);
  }
  function markNotificationsRead() {
    if (!user) return;
    setNotifications(prev => prev.map(n => n.recipient_id === user.id ? { ...n, read: true } : n));
    if (isDbEnabled) markNotificationsReadDb(user.id);
  }

  // ─── Ownership Challenge handlers (Requirement 16) ─────────────────────────
  // "Prove it's yours" always opens the prove-ownership form. With a challenge it
  // shows the questions; without, it collects only the optional note.
  function handleClaimClick(item: Item) {
    setChallengeItem(item);
  }

  // ─── "I found this" on a lost post (Requirement 17) ────────────────────────
  // Finder authors questions (+ note); the lost post's owner must answer.
  function handleSubmitFoundReport(item: Item, questions: ChallengeQuestion[], note: string) {
    if (!user) return;
    const response: ChallengeResponse = {
      id: `cr${Date.now()}`,
      kind: "lost",
      item_id: item.id,
      responder_id: user.id,       // the finder reporting
      responder_name: user.name,
      owner_id: item.finder_id,    // lost post's owner (poster)
      // Questions become answer slots with empty `answer` for the owner to fill.
      answers: questions.filter(q => q.prompt.trim()).map(q => ({ question_id: q.id, prompt: q.prompt.trim(), answer: "" })),
      note: note.trim() || undefined,
      status: "awaiting_owner",
      created_at: new Date().toISOString(),
    };
    setChallengeResponses(prev => [response, ...prev]);
    if (isDbEnabled) insertChallengeResponse(response as unknown as import("./lib/db").DbChallengeResponse);
    pushNotification(item.finder_id, `${user.name} found your "${item.title}" — answer their questions to verify.`, item.id, response.id);
  }

  // Owner fills in the answers to a found report's questions.
  function handleOwnerAnswer(responseId: string, answers: ChallengeAnswer[]) {
    setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, answers, status: "answered" } : r));
    if (isDbEnabled) updateChallengeResponseAnswers(responseId, answers, "answered");
    const r = challengeResponses.find(x => x.id === responseId);
    if (r) pushNotification(r.responder_id, `The owner answered your questions on "${itemTitle(r.item_id)}". Review to confirm.`, r.item_id, r.id);
  }

  function itemTitle(itemId: string): string {
    return items.find(i => i.id === itemId)?.title ?? "an item";
  }

  function handleSubmitChallengeResponse(itemId: string, answers: ChallengeAnswer[], note: string) {
    if (!user) return;
    const response: ChallengeResponse = {
      id: `cr${Date.now()}`,
      item_id: itemId,
      responder_id: user.id,
      responder_name: user.name,
      answers,
      note: note.trim() || undefined,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    setChallengeResponses(prev => [response, ...prev]);
    if (isDbEnabled) {
      const finderId = items.find(i => i.id === itemId)?.finder_id ?? "";
      insertChallengeResponse({ ...response, finder_id: finderId } as unknown as import("./lib/db").DbChallengeResponse);
    }
  }

  function handleChallengeDecision(responseId: string, decision: "approved" | "rejected") {
    setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, status: decision } : r));
    if (isDbEnabled) updateChallengeResponseStatus(responseId, decision);
    // On a lost-flow decision, notify the owner who answered.
    const r = challengeResponses.find(x => x.id === responseId);
    if (r?.kind === "lost" && r.owner_id) {
      pushNotification(r.owner_id, `Your answer on "${itemTitle(r.item_id)}" was ${decision === "approved" ? "approved — the finder will arrange return" : "not approved"}.`, r.item_id, r.id);
    }
  }

  // Finder escalates a response to staff: mark it escalated and create a Claim
  // carrying the answers (and note) as identifying details for staff review.
  function handleEscalateChallengeResponse(responseId: string) {
    const response = challengeResponses.find(r => r.id === responseId);
    if (!response) return;
    const details = [
      ...response.answers.map(a => `${a.prompt}: ${a.answer}`),
      ...(response.note ? [`Note: ${response.note}`] : []),
    ].join("\n");
    const newClaim: Claim = {
      id: `c${Date.now()}`,
      item_id: response.item_id,
      owner_id: response.responder_id,
      owner_name: response.responder_name,
      identifying_details: details,
      status: "pending_review",
      created_at: new Date().toISOString(),
      messages: [],
    };
    setClaims(prev => [...prev, newClaim]);
    setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, status: "escalated" } : r));
    if (isDbEnabled) updateChallengeResponseStatus(responseId, "escalated");
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
    const kind = partial.kind ?? "found";
    const newItem: Item = {
      id: `i${Date.now()}`, kind, finder_id: user?.id ?? "u_current", finder_name: user?.name,
      title: partial.title || (kind === "lost" ? "Lost item" : "Untitled found item"),
      category: partial.category || "Other", location_found: partial.location_found || "",
      time_found: partial.time_found || new Date().toISOString(), description: partial.description || "",
      private_note: partial.private_note, image_url: partial.image_url, challenge: partial.challenge,
      // Shared catalog: lost posts and (when db-backed) found posts are public
      // immediately so everyone sees them.
      status: (kind === "lost" || isDbEnabled) ? "in_office" : "pending_intake",
      upvotes: 0, created_at: new Date().toISOString(),
    };
    if (isDbEnabled) {
      // Optimistic insert; realtime will reconcile with the stored row.
      setItems(prev => [newItem, ...prev]);
      createItem(newItem as unknown as import("./lib/db").DbItem);
    } else {
      setItems(prev => [newItem, ...prev]);
    }
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
    if (authView === "login") {
      return <SignIn onSignIn={handleSignIn} onBack={() => setAuthView("landing")} />;
    }
    return <LandingPage onGetStarted={() => setAuthView("login")} />;
  }

  // Keep the open detail item in sync with live data (realtime/comment updates).
  const activeDetailItem = detailItem ? (items.find(i => i.id === detailItem.id) ?? detailItem) : null;

  return (
    <VerifiedContext.Provider value={verifiedIds}>
    <OpenDetailContext.Provider value={setDetailItem}>
    <LostFlowContext.Provider value={{ currentUserId: user?.id ?? null, onFoundThis: setFoundThisItem }}>
    <div className="min-h-screen" style={{ background: "#FBF9D1" }}>
      <Nav view={view} setView={setView} role={role} user={user} search={search} setSearch={setSearch} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} offlineQueueCount={offlineQueueCount} unreadCount={unreadCount} />
      <main>
        {view === "catalog" && <CatalogView items={items} role={role} user={user} search={search} categoryFilter={categoryFilter} onClaim={handleClaimClick} onUpvote={handleUpvote} upvotedIds={upvotedIds} onRepost={setRepostingItem} repostCounts={repostCounts} myRepostItemIds={myRepostItemIds} reposts={reposts} onShare={handleShare} comments={comments} onAddComment={handleAddComment} onAddReply={handleAddReply} challengeResponseCounts={responseCounts} />}
        {view === "log" && <FinderForm onSubmit={handleFinderSubmit} />}
        {view === "claims" && <OwnerClaimsView claims={ownerClaims} items={items} onReply={handleOwnerReply} />}
        {view === "profile" && <ProfileView user={user} items={items} reposts={reposts} onRemoveRepost={handleRemoveRepost} onSignOut={handleSignOut} verification={myVerification} onSubmitVerification={handleSubmitVerification} verifiedIds={verifiedIds} responseCounts={responseCounts} onViewResponses={setResponsesItem} />}
        {view === "staff" && <StaffDashboard items={items} claims={claims} allItems={items} onStatusChange={handleStatusChange} onClaimAction={handleClaimAction} onStaffReply={handleStaffReply} />}
        {view === "notifications" && (
          <NotificationsView
            notifications={myNotifications}
            onOpen={n => {
              const it = items.find(i => i.id === n.item_id);
              if (it) { if (it.kind === "lost") setFoundThisItem(it); else setDetailItem(it); }
            }}
          />
        )}
      </main>

      {claimingItem && (
        <ClaimModal item={claimingItem} onClose={() => setClaimingItem(null)} onSubmit={(details) => { handleClaimSubmit(details); }} />
      )}
      {challengeItem && (
        <ChallengeModal
          item={challengeItem}
          onClose={() => setChallengeItem(null)}
          onSubmit={(answers, note) => handleSubmitChallengeResponse(challengeItem.id, answers, note)}
        />
      )}
      {responsesItem && (
        <ChallengeResponsesModal
          item={responsesItem}
          responses={challengeResponses.filter(r => r.item_id === responsesItem.id)}
          verifiedIds={verifiedIds}
          onClose={() => setResponsesItem(null)}
          onApprove={id => handleChallengeDecision(id, "approved")}
          onReject={id => handleChallengeDecision(id, "rejected")}
          onEscalate={handleEscalateChallengeResponse}
        />
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
      {activeDetailItem && (
        <PostDetail
          item={activeDetailItem}
          comments={comments[activeDetailItem.id] ?? []}
          onBack={() => setDetailItem(null)}
          onAddComment={msg => handleAddComment(activeDetailItem.id, msg)}
          onAddReply={(commentId, msg) => handleAddReply(activeDetailItem.id, commentId, msg)}
        />
      )}
      {foundThisItem && user && (
        <LostFlowModal
          item={foundThisItem}
          currentUserId={user.id}
          report={challengeResponses.find(r =>
            r.item_id === foundThisItem.id && r.kind === "lost" &&
            (r.responder_id === user.id || r.owner_id === user.id),
          )}
          onClose={() => setFoundThisItem(null)}
          onSubmitReport={handleSubmitFoundReport}
          onOwnerAnswer={handleOwnerAnswer}
          onApprove={id => handleChallengeDecision(id, "approved")}
          onReject={id => handleChallengeDecision(id, "rejected")}
        />
      )}
    </div>
    </LostFlowContext.Provider>
    </OpenDetailContext.Provider>
    </VerifiedContext.Provider>
  );
}
