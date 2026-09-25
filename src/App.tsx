import { useState, useRef, useEffect } from "react";
import type { ReactElement } from "react";
import type { AuthState, AuthUser, Role } from "./lib/auth";
import { getSession, signInWithGoogle, signOut, onAuthChange } from "./lib/auth";
import { createContext, useContext } from "react";
import { parseCaption } from "./lib/captionImport";
import { splitCaption, joinCaption } from "./lib/captionHeuristic";
import { verifyStudent } from "./lib/studentVerify";
import {
  isDbEnabled, listItems, createItem, subscribeItems,
  listComments, insertComment, subscribeComments,
  listReposts, upsertRepost, removeRepost, subscribeReposts,
  listChallengeResponses, insertChallengeResponse, updateChallengeResponseStatus, updateChallengeResponseAnswers, subscribeChallengeResponses,
  listVerifications, upsertVerification, subscribeVerifications,
  listNotifications, insertNotification, markNotificationsReadDb, subscribeNotifications,
  updateItemStatus,
  listClaims, createClaim, updateClaimStatus, insertClaimMessage, escalateChallengeResponse, subscribeClaims,
  listUpvotes, setUpvote, subscribeUpvotes,
  upsertProfile, listProfiles,
} from "./lib/db";
import type { DbUpvote, DbProfile } from "./lib/db";
import { reencodeImage } from "./lib/image";
import { formatDate, relativeDate, postedLabel } from "./lib/time";
import { countCommentNodes, nodeContains, addReply, visibleThreads } from "./lib/comments";
import { claimBlockedUntil as computeClaimBlockedUntil } from "./lib/claimLimit";
import { readQueue, enqueue, replayQueue } from "./lib/offlineQueue";
import { matchPlaces } from "./lib/campusPlaces";
import type {
  ItemStatus, ClaimStatus, Item, ChallengeQuestion, ChallengeAnswer, ChallengeResponseStatus, ChallengeResponse, AppNotification, Claim, ClaimMessage, CommentNode, ItemComment, VerificationStatus, DocType, StudentVerification, Repost,
} from "./types";


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

type ShareResult = "shared" | "copied" | "failed" | "cancelled";

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
// Known profile photos by user id (Requirement 5c.3a).
const ProfilesContext = createContext<Record<string, { name: string; avatar_url?: string }>>({});

function Avatar({ id, name: nameProp, size = 32 }: { id: string; name?: string; size?: number }) {
  const name = nameProp || userName(id);
  const photo = useContext(ProfilesContext)[id]?.avatar_url;
  const [broken, setBroken] = useState(false);
  if (photo && !broken) {
    return (
      <img
        src={photo}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="rounded-full shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full shrink-0 font-semibold"
      style={{ width: size, height: size, background: avatarColor(id), color: "#FFFFFF", fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="5" rx="2"/>
      <path d="M5 9v9a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V9"/>
      <path d="M10 13h4"/>
    </svg>
  );
}
function IconOffice() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 20.5h17"/>
      <path d="M5.5 20.5V6A2.5 2.5 0 0 1 8 3.5h5A2.5 2.5 0 0 1 15.5 6v14.5"/>
      <path d="M15.5 9.5H17a2 2 0 0 1 2 2v9"/>
      <path d="M9 8h2.5M9 12h2.5M9 16h2.5"/>
    </svg>
  );
}
function IconBag() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 8.5A1.5 1.5 0 0 1 6.5 7h11A1.5 1.5 0 0 1 19 8.5l-.8 10.2a2 2 0 0 1-2 1.8H7.8a2 2 0 0 1-2-1.8Z"/>
      <path d="M9 10V7a3 3 0 0 1 6 0v3"/>
    </svg>
  );
}
function IconCheckCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/>
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>
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
function SyncChip() {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: "#F5ECEC", color: "#9A3F3F", border: "1px dashed #C1856D" }}>
      Waiting to sync
    </span>
  );
}

function VerificationBadge({ size = 14, color = "#9A3F3F" }: { size?: number; color?: string }) {
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ color }}
      title="Verified student"
      aria-label="Verified student"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 1.5l2.6 1.9 3.2-.2 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.2L12 22.5l-2.6-1.9-3.2.2-1-3.1L2.6 15.8l1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.2z"/>
        <path d="M10.6 15.2l-2.4-2.4 1.1-1.1 1.3 1.3 3.4-3.4 1.1 1.1z" fill="#FFFFFF"/>
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
const OpenDetailContext = createContext<(item: Item, actionOpen?: boolean) => void>(() => {});
function useOpenDetail(): (item: Item, actionOpen?: boolean) => void {
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

// Opens a public author profile by user id, without prop-drilling.
const OpenAuthorContext = createContext<(userId: string, name: string) => void>(() => {});
function useOpenAuthor(): (userId: string, name: string) => void {
  return useContext(OpenAuthorContext);
}

// Number of OTHER users' upvotes on a post (shared db). 0 when running locally.
const UpvoteOthersContext = createContext<(postId: string) => number>(() => 0);

// Clickable avatar + name that opens the author's public profile (Requirement 5c).
function AuthorLink({ id, name, size, textClass }: { id: string; name: string; size: number; textClass: string }) {
  const openAuthor = useOpenAuthor();
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); openAuthor(id, name); }}
      className="flex items-center gap-1.5 min-w-0 hover:opacity-80"
    >
      <Avatar id={id} name={name} size={size} />
      <span className={textClass + " hover:underline truncate"} style={{ color: "#3A3A3A" }}>{name}</span>
    </button>
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9a2.5 2.5 0 0 1 2.5-2.5h1.7l1.3-2h7l1.3 2h1.7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>
      <circle cx="12" cy="13" r="3.5"/>
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5"/>
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>
      <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4"/>
      <path d="M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/>
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12h15"/>
      <path d="m13 5.5 6.5 6.5-6.5 6.5"/>
    </svg>
  );
}

function IconArrowLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.5 12h-15"/>
      <path d="M11 18.5 4.5 12 11 5.5"/>
    </svg>
  );
}

function IconSparkles() {
  const star = (x: number, y: number, r: number) =>
    `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d={star(9.5, 13.5, 7)} />
      <path d={star(18.5, 5, 3.5)} />
      <path d={star(18.5, 19, 2.5)} />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="7"/>
      <path d="m15.6 15.6 4.9 4.9"/>
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 16.2V11a6 6 0 1 0-12 0v5.2l-1.4 1.9a.6.6 0 0 0 .5 1h13.8a.6.6 0 0 0 .5-1Z"/>
      <path d="M9.8 21.5a2.5 2.5 0 0 0 4.4 0"/>
    </svg>
  );
}

function IconDocument() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8Z"/>
      <path d="M14 3v3.5A1.5 1.5 0 0 0 15.5 8H19"/>
      <path d="M9 13h6M9 17h4"/>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.5v15M4.5 12h15"/>
    </svg>
  );
}


function IconFilter() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M7 12h10M10 18h4"/>
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s7.5-3.4 7.5-9.5V6.2L12 3.5 4.5 6.2v5.3C4.5 17.6 12 21 12 21Z"/>
      <path d="m9 12 2.2 2.2L15.2 10"/>
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 7.5V12l3 2"/>
    </svg>
  );
}

function IconMapPin() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21.5s7-6.1 7-11.5a7 7 0 1 0-14 0c0 5.4 7 11.5 7 11.5Z"/>
      <circle cx="12" cy="10" r="2.5"/>
    </svg>
  );
}

function IconChevronUp({ filled }: { filled?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5.5 19 16H5Z"/>
    </svg>
  );
}

function IconComment() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.6 16.8A9 9 0 1 0 16.8 20.6L21.5 21.5Z"/>
    </svg>
  );
}

function IconRepost({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m17 2.5 3 3-3 3"/>
      <path d="M20 5.5H9A4.5 4.5 0 0 0 4.5 10v1.5"/>
      <path d="m7 21.5-3-3 3-3"/>
      <path d="M4 18.5h11a4.5 4.5 0 0 0 4.5-4.5v-1.5"/>
    </svg>
  );
}

function IconShare() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.5 2.5 10.7 13.3"/>
      <path d="M21.5 2.5 15 20.8a.6.6 0 0 1-1.1.1l-3.2-7.6-7.6-3.2a.6.6 0 0 1 .1-1.1Z"/>
    </svg>
  );
}

function IconPen() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/>
      <path d="m14.5 7.5 3 3"/>
    </svg>
  );
}

function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18"/>
    </svg>
  );
}


function IconWifi() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 3 18 18"/>
      <path d="M2.5 9.2a14 14 0 0 1 4-2.5M10.5 5.1A14 14 0 0 1 21.5 9.2"/>
      <path d="M5.5 12.6a9 9 0 0 1 4.4-2.4M16.2 11a9 9 0 0 1 2.3 1.6"/>
      <path d="M9 16a4.5 4.5 0 0 1 6 0"/>
      <path d="M12 19.5h.01"/>
    </svg>
  );
}

// ─── Input styles (shared) ────────────────────────────────────────────────────

const inputCls = "w-full px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:ring-2 border"
  + " bg-[#FFFFFF] border-[#C1856D] text-[#3A3A3A] placeholder:text-[#9A7070]"
  + " focus:ring-[#9A3F3F] focus:border-[#9A3F3F]";

const btnPrimary = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors text-[#FFFFFF] bg-[#9A3F3F] hover:bg-[#7A2E2E]";
const btnSecondary = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors border border-[#C1856D] text-[#9A3F3F] hover:bg-[#F5ECEC]";

// Neutral form-card style: verification forms, reports, claims, caption pop-up.
const formInputCls = "w-full px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:ring-2 border"
  + " bg-[#FFFFFF] border-[#E5E5E5] text-[#3A3A3A] placeholder:text-[#9CA3AF]"
  + " focus:ring-[#3A3A3A]/15 focus:border-[#9CA3AF]";
const btnDark = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors text-[#FFFFFF] bg-[#3A3A3A] hover:bg-[#525252]";
const btnGrey = "px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors border border-[#E5E5E5] text-[#3A3A3A] bg-[#FFFFFF] hover:bg-[#F2F2F2]";
const FORM_CARD_BG = "#F7F7F8";

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
  const othersUpvotes = useContext(UpvoteOthersContext)(postId);
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
      <div className="flex items-center gap-3">
        <button
          onClick={() => onUpvote?.(postId)}
          className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-1 rounded-md transition-opacity hover:opacity-70"
          style={{ color: upvoted ? "#3A3A3A" : "#6B7280" }}
        >
          <IconChevronUp filled={upvoted} />
          <span>{baseUpvotes + othersUpvotes + (upvoted ? 1 : 0)}</span>
        </button>

        <button
          onClick={() => openDetail(repostItem)}
          className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-1 rounded-md transition-opacity hover:opacity-70"
          style={{ color: "#6B7280" }}
          aria-label="Comments"
        >
          <IconComment />
          <span>{commentCount}</span>
        </button>

        <button
          onClick={() => onRepost?.(repostItem)}
          className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-1 rounded-md transition-opacity hover:opacity-70"
          style={{ color: reposted ? "#3A3A3A" : "#6B7280" }}
          aria-label="Repost"
          aria-pressed={reposted}
          title={reposted ? "You reposted this" : "Repost"}
        >
          <IconRepost />
          <span>{(repostItem.reposts ?? 0) + (repostCount ?? 0)}</span>
        </button>

        <button
          onClick={handleShareClick}
          className="flex items-center gap-1.5 text-xs font-medium px-1.5 py-1 rounded-md transition-opacity hover:opacity-70"
          style={{ color: "#6B7280" }}
          aria-label="Share"
          title="Share"
        >
          <IconShare />
        </button>

        {shareMsg && <span className="text-xs font-medium" style={{ color: "#3A3A3A" }}>{shareMsg}</span>}

        {extra}
      </div>
    </>
  );
}

// ─── Inline Ownership Action Section (inside PostDetail) ────────────────────────

// ─── Verification-form question builder (Requirements 16.1, 17.2) ─────────────

function sampleQuestion(): ChallengeQuestion {
  return { id: `q${Date.now()}`, prompt: "What is the color of the item?" };
}
/** Questions worth sending: trimmed, blanks dropped. */
function cleanQuestions(qs: ChallengeQuestion[]): ChallengeQuestion[] {
  return qs.map(q => ({ ...q, prompt: q.prompt.trim() })).filter(q => q.prompt);
}

// Numbered questions as text + pen (edit in place, no box) + answer preview + ✕,
// and "+ Add question". Edits update the parent list as you type.
function QuestionBuilder({ questions, onChange }: {
  questions: ChallengeQuestion[];
  onChange: (qs: ChallengeQuestion[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [before, setBefore] = useState(""); // text before editing; "" for a new question
  const [isNew, setIsNew] = useState(false);

  function startEdit(q: ChallengeQuestion) { setEditingId(q.id); setBefore(q.prompt); setIsNew(false); }
  function setPrompt(id: string, prompt: string) { onChange(questions.map(q => q.id === id ? { ...q, prompt } : q)); }
  function remove(id: string) { onChange(questions.filter(q => q.id !== id)); }
  // Empty text restores the previous question, or drops a just-added one.
  function finish(restore: boolean) {
    const q = questions.find(x => x.id === editingId);
    if (q && (restore || !q.prompt.trim())) {
      if (isNew) remove(q.id); else setPrompt(q.id, before);
    } else if (q) {
      setPrompt(q.id, q.prompt.trim());
    }
    setEditingId(null);
  }
  function add() {
    const id = `q${Date.now()}`;
    // Finish any open edit in the same update so the list isn't overwritten.
    const base = questions
      .filter(q => !(q.id === editingId && isNew && !q.prompt.trim()))
      .map(q => q.id === editingId && !q.prompt.trim() ? { ...q, prompt: before } : q);
    onChange([...base, { id, prompt: "" }]);
    setEditingId(id); setBefore(""); setIsNew(true);
  }

  return (
    <>
      {questions.map((q, i) => (
        <div key={q.id} className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            {editingId === q.id ? (
              <div className="flex items-baseline gap-1 flex-1 min-w-0 text-sm font-medium" style={{ color: "#3A3A3A" }}>
                <span className="shrink-0">{i + 1}.</span>
                {/* Edit in place: no box, just the caret. */}
                <input
                  type="text"
                  autoFocus
                  value={q.prompt}
                  onChange={ev => setPrompt(q.id, ev.target.value)}
                  onBlur={() => finish(false)}
                  onKeyDown={ev => {
                    if (ev.key === "Enter") { ev.preventDefault(); finish(false); }
                    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(true); }
                  }}
                  placeholder="Type your question"
                  aria-label={`Edit question ${i + 1}`}
                  className="flex-1 min-w-0 p-0 border-0 bg-transparent outline-none text-sm font-medium"
                  style={{ color: "#3A3A3A", caretColor: "#3A3A3A" }}
                />
              </div>
            ) : (
              <p className="text-sm font-medium flex items-center gap-1.5 min-w-0" style={{ color: "#3A3A3A" }}>
                <span className="break-words">{i + 1}. {q.prompt}</span>
                <button type="button" onClick={() => startEdit(q)} aria-label={`Edit question ${i + 1}`} className="shrink-0 hover:opacity-70" style={{ color: "#6B7280" }}>
                  <IconPen />
                </button>
              </p>
            )}
            <button type="button" onMouseDown={ev => ev.preventDefault()} onClick={() => { if (editingId === q.id) setEditingId(null); remove(q.id); }} aria-label={`Remove question ${i + 1}`} className="shrink-0 hover:opacity-70" style={{ color: "#6B7280" }}>
              <IconX />
            </button>
          </div>
          {/* Preview of where the owner will answer */}
          <input
            type="text"
            disabled
            aria-label={`Owner's answer to question ${i + 1} (preview)`}
            placeholder="Owner's answer"
            className="w-full sm:w-2/3 h-9 px-3 text-sm rounded-lg border"
            style={{ borderColor: "#E5E5E5", background: "#FFFFFF", color: "#9CA3AF" }}
          />
        </div>
      ))}
      <button
        type="button"
        onMouseDown={ev => ev.preventDefault()}
        onClick={add}
        className="inline-flex items-center gap-1 self-start text-sm font-semibold hover:opacity-70"
        style={{ color: "#3A3A3A" }}
      >
        + Add question
      </button>
    </>
  );
}

// Dashed "Create verification form" card that opens the builder.
function CreateFormCard({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={"w-full px-4 py-4 rounded-xl flex items-center gap-3 text-left transition-colors hover:bg-[#F7F7F8] " + className}
      style={{ border: "1.5px dashed #D1D5DB", color: "#3A3A3A" }}
    >
      <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "#ECECEE", color: "#6B7280" }}>
        <IconPlus />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">Create verification form</span>
        <span className="block text-xs" style={{ color: "#6B7280" }}>Ask questions only the real owner can answer.</span>
      </span>
    </button>
  );
}

// Read-only record of a submitted report/claim: questions with answers, plus notes.
function SubmittedAnswers({ answers, emptyAnswerText, note, noteLabel, ownerNote }: {
  answers: ChallengeAnswer[];
  emptyAnswerText: string;
  note?: string;
  noteLabel: string;
  ownerNote?: string;
}) {
  if (answers.length === 0 && !note && !ownerNote) return null;
  return (
    <div className="flex flex-col gap-4">
      {answers.map((a, i) => (
        <div key={a.question_id} className="flex flex-col gap-1.5">
          <p className="text-sm font-medium" style={{ color: "#3A3A3A" }}>{i + 1}. {a.prompt}</p>
          {/* Read-only answer box, same shape as the form's answer field. */}
          <div
            className="w-full sm:w-2/3 min-h-9 px-3 py-2 text-sm rounded-lg border break-words"
            style={{ borderColor: "#E5E5E5", background: "#FFFFFF", color: a.answer ? "#3A3A3A" : "#6B7280" }}
          >
            {a.answer || emptyAnswerText}
          </div>
        </div>
      ))}
      {note && (
        <p className="text-sm" style={{ color: "#6B7280" }}>
          <span className="font-medium" style={{ color: "#3A3A3A" }}>{noteLabel}:</span> {note}
        </p>
      )}
      {ownerNote && (
        <p className="text-sm" style={{ color: "#6B7280" }}>
          <span className="font-medium" style={{ color: "#3A3A3A" }}>Owner's reply:</span> {ownerNote}
        </p>
      )}
    </div>
  );
}

function OwnershipActionSection({
  item,
  currentUserId,
  responses = [],
  onSubmitChallengeResponse,
  onSubmitFoundReport,
  onOwnerAnswer,
  onApprove,
  onReject,
  onEscalate,
  initialOpen = false,
  initialReportId = null,
}: {
  item: Item;
  currentUserId: string;
  responses?: ChallengeResponse[];
  onSubmitChallengeResponse?: (itemId: string, answers: ChallengeAnswer[], note: string) => void;
  onSubmitFoundReport?: (item: Item, questions: ChallengeQuestion[], note: string) => void;
  onOwnerAnswer?: (responseId: string, answers: ChallengeAnswer[], ownerNote: string) => void;
  onApprove?: (responseId: string) => void;
  onReject?: (responseId: string) => void;
  onEscalate?: (responseId: string) => void;
  initialOpen?: boolean;
  initialReportId?: string | null; // owner: open this form directly (e.g. from a notification)
}) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [qs, setQs] = useState<ChallengeQuestion[]>([]);
  const [note, setNote] = useState("");
  const [challengeAnswers, setChallengeAnswers] = useState<Record<string, string>>({});
  const [claimantNote, setClaimantNote] = useState("");
  const [ownerAnswers, setOwnerAnswers] = useState<Record<string, string>>({});
  const [openReportId, setOpenReportId] = useState<string | null>(initialReportId ?? null);
  const openAuthor = useOpenAuthor();
  const [submitted, setSubmitted] = useState(false);

  const isPoster = currentUserId === item.finder_id;
  const isLost = item.kind === "lost";

  const myResponse = responses.find(r => r.item_id === item.id && r.responder_id === currentUserId);
  const reportsForOwner = isLost && isPoster
    ? responses.filter(r => r.item_id === item.id && r.kind === "lost")
    : [];

  if (item.status === "released") return null;

  // Case 1: Lost post
  if (isLost) {
    if (isPoster) {
      if (reportsForOwner.length === 0) return null;
      const openReport = reportsForOwner.find(r => r.id === openReportId);

      // One opened form: questions as text with answer fields (or read-only once answered).
      if (openReport) {
        const report = openReport;
        return (
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => setOpenReportId(null)} className="inline-flex items-center gap-1.5 self-start text-xs font-medium hover:opacity-70" style={{ color: "#6B7280" }}>
              <IconArrowLeft /> All forms
            </button>
            <div className="flex flex-col gap-4 rounded-xl p-4 sm:p-5" style={{ background: FORM_CARD_BG }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => openAuthor(report.responder_id, report.responder_name)}
                  aria-label={`Open ${report.responder_name}'s profile`}
                  className="shrink-0 hover:opacity-80"
                >
                  <Avatar id={report.responder_id} name={report.responder_name} size={32} />
                </button>
                <p className="text-sm font-semibold min-w-0" style={{ color: "#3A3A3A" }}>
                  <button type="button" onClick={() => openAuthor(report.responder_id, report.responder_name)} className="hover:underline">
                    {report.responder_name}
                  </button>
                  's verification form
                </p>
              </div>
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded shrink-0" style={{ background: "#ECECEE", color: "#6B7280" }}>
                {report.status.replace("_", " ")}
              </span>
            </div>
            {report.note && (
              <p className="text-sm" style={{ color: "#6B7280" }}>
                <span className="font-medium" style={{ color: "#3A3A3A" }}>Finder's note:</span> {report.note}
              </p>
            )}
            {report.status === "awaiting_owner" ? (
              <form
                onSubmit={e => {
                  e.preventDefault();
                  const filled = report.answers.map(a => ({ ...a, answer: (ownerAnswers[`${report.id}:${a.question_id}`] ?? "").trim() }));
                  if (filled.some(a => !a.answer)) return;
                  const reply = ownerAnswers[`${report.id}:note`] ?? "";
                  // No questions (older reports): the reply answers the finder's note, so it's required.
                  if (filled.length === 0 && !reply.trim()) return;
                  onOwnerAnswer?.(report.id, filled, reply);
                }}
                className="flex flex-col gap-4"
              >
                {report.answers.map((a, i) => (
                  <div key={a.question_id} className="flex flex-col gap-1.5">
                    <p className="text-sm font-medium" style={{ color: "#3A3A3A" }}>{i + 1}. {a.prompt}</p>
                    <input
                      type="text"
                      required
                      aria-label={`Answer to question ${i + 1}`}
                      value={ownerAnswers[`${report.id}:${a.question_id}`] ?? ""}
                      onChange={ev => setOwnerAnswers(prev => ({ ...prev, [`${report.id}:${a.question_id}`]: ev.target.value }))}
                      placeholder="Your answer"
                      className={formInputCls + " sm:w-2/3"}
                    />
                  </div>
                ))}
                <div className="flex flex-col gap-1.5">
                  <p className="text-sm font-medium" style={{ color: "#3A3A3A" }}>
                    {report.answers.length === 0 ? "Your answer" : "Note to finder (optional)"}
                  </p>
                  <input
                    type="text"
                    required={report.answers.length === 0}
                    aria-label={report.answers.length === 0 ? "Your answer" : "Note to finder"}
                    value={ownerAnswers[`${report.id}:note`] ?? ""}
                    onChange={ev => setOwnerAnswers(prev => ({ ...prev, [`${report.id}:note`]: ev.target.value }))}
                    placeholder={report.answers.length === 0 ? "Answer the finder's question" : "e.g. Thanks! When can I pick it up?"}
                    className={formInputCls + " sm:w-2/3"}
                  />
                </div>
                <button type="submit" className={btnDark + " self-start"}>Submit</button>
              </form>
            ) : (
              <>
                <p className="text-xs" style={{ color: "#6B7280" }}>
                  {report.status === "answered" ? `Answers submitted. Waiting for ${report.responder_name} to review.`
                    : report.status === "approved" ? `${report.responder_name} approved you.`
                    : `${report.responder_name} didn't approve these answers.`}
                </p>
                <SubmittedAnswers answers={report.answers} emptyAnswerText="(no answer)" noteLabel="" ownerNote={report.owner_note} />
              </>
            )}
            </div>
          </div>
        );
      }

      // The list: one rectangular card per verification form received.
      return (
        <div className="flex flex-col gap-3">
          {reportsForOwner.map(report => {
            const waiting = report.status === "awaiting_owner";
            const n = report.answers.length;
            return (
              <button
                key={report.id}
                type="button"
                onClick={() => setOpenReportId(report.id)}
                className="w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-colors hover:bg-[#F2F2F2]"
                
              >
                <Avatar id={report.responder_id} name={report.responder_name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold truncate" style={{ color: "#3A3A3A" }}>{report.responder_name}</span>
                  <span className="block text-xs" style={{ color: "#6B7280" }}>
                    {n === 0 ? "Note only" : `${n} ${n === 1 ? "question" : "questions"}`}
                  </span>
                </span>
                <span className="text-xs shrink-0" style={{ color: "#6B7280" }}>
                  {postedLabel(report.created_at)}
                </span>
              </button>
            );
          })}
        </div>
      );
    }

    if (myResponse) {
      return (
        <div className="flex flex-col gap-3 rounded-xl p-4 sm:p-5" style={{ background: FORM_CARD_BG }}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Your found report</p>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded" style={{ background: "#ECECEE", color: "#6B7280" }}>
              {myResponse.status.replace("_", " ")}
            </span>
          </div>
          <p className="text-xs" style={{ color: "#6B7280" }}>
            {myResponse.status === "awaiting_owner" ? "Waiting for the owner to answer your verification questions…"
              : myResponse.status === "answered" ? "The owner answered. Check their answers, then approve or reject."
              : myResponse.status === "approved" ? "You approved this owner."
              : "You rejected this claim."}
          </p>
          <SubmittedAnswers
            answers={myResponse.answers}
            emptyAnswerText="Waiting for the owner's answer"
            note={myResponse.note}
            noteLabel="Your note"
            ownerNote={myResponse.owner_note}
          />
          {myResponse.status === "answered" && (
            <div className="flex flex-col gap-2 mt-1">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onApprove?.(myResponse.id)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg"
                  style={{ background: "#3A3A3A", color: "#FFFFFF" }}
                >
                  Approve owner
                </button>
                <button
                  type="button"
                  onClick={() => onReject?.(myResponse.id)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#E5E5E5]"
                  style={{ color: "#3A3A3A", background: "transparent" }}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mt-4 p-4 rounded-xl" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
        {!isOpen ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sm" style={{ color: "#3A3A3A" }}>Did you find this item?</h3>
              <p className="text-xs mt-0.5" style={{ color: "#6B7280" }}>Ask questions to verify the real owner.</p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
              style={{ background: "#3A3A3A", color: "#FFFFFF" }}
            >
              I found it
            </button>
          </div>
        ) : (
          <form
            onSubmit={e => {
              e.preventDefault();
              onSubmitFoundReport?.(item, qs, note);
              setSubmitted(true);
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm" style={{ color: "#3A3A3A" }}>I found it — challenge owner</h3>
              <button type="button" onClick={() => setIsOpen(false)} className="text-xs text-[#9A7070] hover:underline">Cancel</button>
            </div>
            {submitted ? (
              <p className="text-xs font-medium text-[#9A3F3F] py-2">Report submitted! The owner will be notified to answer.</p>
            ) : (
              <>
                <p className="text-xs" style={{ color: "#6B7280" }}>Add questions only the real owner can answer:</p>
                {qs.map((q, i) => (
                  <div key={q.id} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder={`Question ${i + 1} (e.g. What color is the keychain?)`}
                      value={q.prompt}
                      onChange={ev => setQs(list => list.map(x => x.id === q.id ? { ...x, prompt: ev.target.value } : x))}
                      className={formInputCls + " text-xs"}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setQs(list => list.filter(x => x.id !== q.id))}
                      className="text-xs text-[#9A3F3F] p-1"
                    >
                      <IconX />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setQs(list => [...list, { id: `q${Date.now()}${list.length}`, prompt: "" }])}
                  className="text-xs font-semibold self-start hover:underline"
                  style={{ color: "#3A3A3A" }}
                >
                  + Add question
                </button>
                <textarea
                  rows={2}
                  placeholder="Note to owner (e.g. I turned it in to Room 101)..."
                  value={note}
                  onChange={ev => setNote(ev.target.value)}
                  className={formInputCls + " text-xs resize-none"}
                />
                <button type="submit" className={btnDark + " self-start text-xs py-2"}>
                  Send report to owner
                </button>
              </>
            )}
          </form>
        )}
      </div>
    );
  }

  // Case 2: Found post
  if (!isPoster) {
    if (myResponse) {
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold text-sm" style={{ color: "#3A3A3A" }}>Your ownership claim</h3>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded" style={{ background: "#ECECEE", color: "#6B7280" }}>
              {myResponse.status}
            </span>
          </div>
          <p className="text-xs" style={{ color: "#6B7280" }}>
            {myResponse.status === "approved" ? "The finder approved your claim! Pick up at the admin office."
              : myResponse.status === "rejected" ? "The finder didn't approve this claim."
              : myResponse.status === "escalated" ? "The finder sent your claim to the admin office for review."
              : "Your claim was submitted and is under review."}
          </p>
          <div className="mt-2">
            <SubmittedAnswers
              answers={myResponse.answers}
              emptyAnswerText="(no answer)"
              note={myResponse.note}
              noteLabel="Your note"
            />
          </div>
        </div>
      );
    }

    const questions = item.challenge ?? [];
    const hasQuestions = questions.length > 0;

    return (
      <div className="mt-4 pt-4 flex flex-col gap-4" style={{ borderTop: "1px solid #C1856D" }}>
        {!isOpen ? null : (
          <form
            onSubmit={e => {
              e.preventDefault();
              const payload: ChallengeAnswer[] = questions.map(q => ({
                question_id: q.id,
                prompt: q.prompt,
                answer: (challengeAnswers[q.id] ?? "").trim(),
              }));
              onSubmitChallengeResponse?.(item.id, payload, claimantNote);
              setSubmitted(true);
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>I lost it — prove ownership</p>
              <button type="button" onClick={() => setIsOpen(false)} className="text-xs hover:underline" style={{ color: "#6B7280" }}>Cancel</button>
            </div>
            {submitted ? (
              <p className="text-sm font-medium" style={{ color: "#3A3A3A" }}>Claim submitted! The finder will review your answers.</p>
            ) : (
              <>
                {questions.map((q, i) => (
                  <div key={q.id}>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>{i + 1}. {q.prompt} <span style={{ color: "#3A3A3A" }}>*</span></label>
                    <input
                      type="text"
                      required
                      placeholder="Your answer"
                      value={challengeAnswers[q.id] ?? ""}
                      onChange={ev => setChallengeAnswers(prev => ({ ...prev, [q.id]: ev.target.value }))}
                      className={formInputCls}
                    />
                  </div>
                ))}
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>
                    {hasQuestions ? "Note to finder (optional)" : "Describe identifying details *"}
                  </label>
                  <textarea
                    rows={3}
                    required={!hasQuestions}
                    placeholder="Describe unique scratches, serials, contents, or where you lost it..."
                    value={claimantNote}
                    onChange={ev => setClaimantNote(ev.target.value)}
                    className={formInputCls + " resize-none"}
                  />
                </div>
                <button type="submit" className={btnDark + " self-start"}>
                  Submit claim
                </button>
              </>
            )}
          </form>
        )}
      </div>
    );
  }

  // Case 3: Found post, poster — claims as cards, open one to review (Requirement 16.4).
  const claims = responses.filter(r => r.item_id === item.id && r.kind !== "lost");
  if (isPoster && claims.length > 0) {
    const open = claims.find(r => r.id === openReportId);
    const statusLabel = (st: ChallengeResponseStatus) => st === "escalated" ? "sent to staff" : st.replace("_", " ");
    if (open) {
      return (
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => setOpenReportId(null)} className="inline-flex items-center gap-1.5 self-start text-xs font-medium hover:opacity-70" style={{ color: "#6B7280" }}>
            <IconArrowLeft /> All claims
          </button>
          <div className="flex flex-col gap-4 rounded-xl p-4 sm:p-5" style={{ background: FORM_CARD_BG }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button type="button" onClick={() => openAuthor(open.responder_id, open.responder_name)} aria-label={`Open ${open.responder_name}'s profile`} className="shrink-0 hover:opacity-80">
                  <Avatar id={open.responder_id} name={open.responder_name} size={32} />
                </button>
                <p className="text-sm font-semibold min-w-0" style={{ color: "#3A3A3A" }}>
                  <button type="button" onClick={() => openAuthor(open.responder_id, open.responder_name)} className="hover:underline">
                    {open.responder_name}
                  </button>
                  's claim
                </p>
              </div>
              <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded shrink-0" style={{ background: "#ECECEE", color: "#6B7280" }}>
                {statusLabel(open.status)}
              </span>
            </div>
            <SubmittedAnswers answers={open.answers} emptyAnswerText="(no answer)" note={open.note} noteLabel="Their note" />
            {open.status === "pending" ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => onApprove?.(open.id)} className={btnDark}>Approve</button>
                <button type="button" onClick={() => onReject?.(open.id)} className={btnGrey}>Reject</button>
                <button type="button" onClick={() => onEscalate?.(open.id)} className={btnGrey}>Send to staff</button>
              </div>
            ) : (
              <p className="text-xs" style={{ color: "#6B7280" }}>
                {open.status === "approved" ? "You approved this claim. Pickup happens at the admin office."
                  : open.status === "rejected" ? "You rejected this claim."
                  : "You sent this claim to the admin office for review."}
              </p>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Claims ({claims.length})</p>
        {claims.map(r => {
          const waiting = r.status === "pending";
          const n = r.answers.length;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpenReportId(r.id)}
              className="w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-colors hover:bg-[#F2F2F2]"
              
            >
              <Avatar id={r.responder_id} name={r.responder_name} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold truncate" style={{ color: "#3A3A3A" }}>{r.responder_name}</span>
                <span className="block text-xs" style={{ color: "#6B7280" }}>
                  {n === 0 ? "Note only" : `${n} ${n === 1 ? "answer" : "answers"}`}
                </span>
              </span>
              <span className="text-xs shrink-0" style={{ color: "#6B7280" }}>
                {postedLabel(r.created_at)}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return null;
}

// ─── Post Detail (full-screen, Reddit-style) ───────────────────────────────────

function PostDetail({
  item, comments, currentUserId, onBack, onAddComment, onAddReply, onClaim,
  onUpvote, upvoted, onRepost, reposted, repostCount, onShare,
  challengeResponses = [], onSubmitChallengeResponse, onSubmitFoundReport,
  onOwnerAnswer, onApprove, onReject, initialActionOpen = false, claimBlockedUntil = null, isStaff = false, initialReportId = null, onEscalate,
}: {
  item: Item;
  comments: ItemComment[];
  currentUserId: string;
  onBack: () => void;
  onAddComment: (message: string, visibility: "public" | "private") => void;
  onAddReply: (commentId: string, message: string) => void;
  onClaim?: (item: Item) => void;
  onUpvote?: (id: string) => void;
  upvoted?: boolean;
  onRepost?: (item: Item) => void;
  reposted?: boolean;
  repostCount?: number;
  onShare?: (item: Item) => Promise<ShareResult>;
  challengeResponses?: ChallengeResponse[];
  onSubmitChallengeResponse?: (itemId: string, answers: ChallengeAnswer[], note: string) => void;
  onSubmitFoundReport?: (item: Item, questions: ChallengeQuestion[], note: string) => void;
  onOwnerAnswer?: (responseId: string, answers: ChallengeAnswer[], ownerNote: string) => void;
  onApprove?: (responseId: string) => void;
  onReject?: (responseId: string) => void;
  initialActionOpen?: boolean;
  claimBlockedUntil?: string | null; // set when the 3-claims-per-24h limit is reached
  isStaff?: boolean; // staff don't claim found items (Requirement 16.2)
  initialReportId?: string | null;
  onEscalate?: (responseId: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  // What shows under the "N comments" row: the thread or the ownership form.
  // Something in the ownership panel waiting on this user (Requirement 5.19b).
  const needsAction = item.status !== "released" && (item.kind === "lost"
    ? (currentUserId === item.finder_id
        ? challengeResponses.some(r => r.kind === "lost" && r.status === "awaiting_owner")
        : challengeResponses.some(r => r.kind === "lost" && r.responder_id === currentUserId && r.status === "answered"))
    : currentUserId === item.finder_id && challengeResponses.some(r => r.kind !== "lost" && r.status === "pending"));
  const [panel, setPanel] = useState<"comments" | "action">(initialActionOpen || needsAction ? "action" : "comments");
  const [claimAnswers, setClaimAnswers] = useState<Record<string, string>>({});
  // Lost-post "I found it": two-step verification-form builder (Requirement 17.2).
  const [builderOpen, setBuilderOpen] = useState(false);
  const [reportQuestions, setReportQuestions] = useState<ChallengeQuestion[]>([]);
  function openBuilder() {
    setReportQuestions([sampleQuestion()]);
    setBuilderOpen(true);
  }
  const finalQuestions = cleanQuestions(reportQuestions);
  function cancelBuilder() {
    setBuilderOpen(false);
    setReportQuestions([]);
    setClaimNote("");
  }
  const [claimNote, setClaimNote] = useState("");
  const [claimSubmitted, setClaimSubmitted] = useState(false);
  const openAuthor = useOpenAuthor();

  // An existing response/report (or reports on the user's own lost post) is
  // reviewed inline via OwnershipActionSection instead of a new blank form.
  const myResponse = challengeResponses.find(r => r.responder_id === currentUserId);
  const hasOwnerReports = item.kind === "lost" && currentUserId === item.finder_id &&
    challengeResponses.some(r => r.kind === "lost");
  // Found post, poster: claims to review (Requirement 16.4).
  const hasClaims = item.kind !== "lost" && currentUserId === item.finder_id &&
    challengeResponses.some(r => r.kind !== "lost");
  const canStartAction = item.status !== "released" && currentUserId !== item.finder_id && !myResponse &&
    !(isStaff && item.kind !== "lost");
  // The document icon's panel: a new claim/report form, or the status/review of
  // an existing one (Requirement 5.19a).
  const hasFlow = item.status !== "released" && (!!myResponse || hasOwnerReports || hasClaims);
  const showForm = panel === "action" && canStartAction;
  const showFlow = panel === "action" && !canStartAction && hasFlow;
  const showComments = !showForm && !showFlow;
  const actionLabel = hasClaims ? "Claims" : hasOwnerReports ? "Reports from finders"
    : myResponse ? (item.kind === "lost" ? "Your found report" : "Your ownership claim")
    : item.kind === "lost" ? "I found it" : "I lost it";

  // A private comment thread is visible only to the post's author and the
  // thread's author.
  const visibleComments = visibleThreads(comments, currentUserId, item.finder_id);
  const count = countCommentNodes(visibleComments);

  // Close on Escape (back to the list).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onBack(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentDraft.trim()) return;
    onAddComment(commentDraft, visibility);
    setCommentDraft("");
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#FFFFFF" }}>
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14 shrink-0" style={{ background: "#FFFFFF", borderBottom: "1px solid #E5E5E5" }}>
        <button onClick={onBack} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B7280" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm truncate" style={{ color: "#3A3A3A" }}>Post</span>
      </header>

      {/* Scrollable: full post, action row, ownership action section, then comment thread */}
      <div className="flex-1 overflow-y-auto scroll-area">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {/* The post */}
          <div className="pb-4 mb-4" style={{ borderBottom: "1px solid #E5E5E5" }}>
            <div className="flex items-center gap-2">
              <div
                className="flex items-center gap-2 cursor-pointer hover:opacity-80"
                onClick={() => openAuthor(item.finder_id, item.finder_name || userName(item.finder_id))}
              >
                <Avatar id={item.finder_id} name={item.finder_name} size={32} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold hover:underline" style={{ color: "#3A3A3A" }}>
                      {item.finder_name || userName(item.finder_id)}
                    </span>
                    {useIsVerified(item.finder_id) && <VerificationBadge size={13} />}
                    <span
                      className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={item.kind === "lost" ? { background: "#F5ECEC", color: "#9A3F3F" } : { background: "#E6CFA9", color: "#5C2020" }}
                    >
                      {item.kind === "lost" ? "Lost" : "Found"}
                    </span>
                    {item.pending_sync && <SyncChip />}
                  </div>
                  <span className="text-xs" style={{ color: "#6B7280" }}>{postedLabel(item.created_at)}</span>
                </div>
              </div>
            </div>

            <h1 className="mt-3 font-semibold text-xl leading-snug" style={{ color: "#3A3A3A" }}>{item.title}</h1>
            {item.description && <p className="mt-2 text-sm leading-relaxed whitespace-pre-line" style={{ color: "#3A3A3A" }}>{item.description}</p>}
            {item.image_url && (
              <img src={item.image_url} alt={item.title} className="mt-3 w-full max-h-[28rem] object-cover rounded-xl" />
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              {item.location_found && <span className="flex items-center gap-1 text-xs" style={{ color: "#6B7280" }}><IconMapPin />{item.location_found}</span>}
              {item.time_found && <span className="flex items-center gap-1 text-xs" style={{ color: "#6B7280" }}><IconClock />{formatDate(item.time_found)}</span>}
            </div>

            {/* Post actions (Upvote, Comment count, Repost, Share) + claim button rightmost */}
            <div className="mt-4">
              <PostActions
                postId={item.id}
                baseUpvotes={item.upvotes}
                upvoted={upvoted}
                onUpvote={onUpvote}
                comments={comments}
                onAddComment={(postId, message) => onAddComment(message, "public")}
                onAddReply={onAddReply}
                repostItem={item}
                onRepost={onRepost}
                reposted={reposted}
                repostCount={repostCount}
                onShare={onShare}
                extra={
                  canStartAction ? (
                    item.kind === "lost" ? (
                      <button
                        onClick={() => setPanel("action")}
                        className="ml-auto px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
                        style={{ background: "transparent", border: "1px solid #C1856D", color: "#9A3F3F" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#F5ECEC"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                      >
                        I found it
                      </button>
                    ) : (
                      <button
                        onClick={() => setPanel("action")}
                        className="ml-auto px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
                        style={{ background: "transparent", border: "1px solid #C1856D", color: "#9A3F3F" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#F5ECEC"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                      >
                        I lost it
                      </button>
                    )
                  ) : null
                }
              />
            </div>

          </div>{/* end post block */}

          <div className="flex items-center justify-between mb-3">
            {/* Comment count shows the thread; the document icon shows the ownership form. */}
            <button
              type="button"
              onClick={() => setPanel("comments")}
              aria-pressed={showComments}
              className="text-sm font-semibold hover:opacity-70 transition-opacity"
              style={{ color: showComments ? "#3A3A3A" : "#6B7280" }}
            >
              {count} {count === 1 ? "comment" : "comments"}
            </button>
            {(canStartAction || hasFlow) && (
              <button
                type="button"
                onClick={() => setPanel(p => p === "action" ? "comments" : "action")}
                aria-pressed={!showComments}
                className="inline-flex items-center justify-center w-9 h-9 -mr-2 rounded-md hover:opacity-70 transition-opacity"
                style={{ color: showComments ? "#6B7280" : "#3A3A3A" }}
                aria-label={needsAction ? `${actionLabel} (needs your response)` : actionLabel}
                title={actionLabel}
              >
                <span className="relative inline-flex">
                  <IconDocument />
                  {needsAction && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full" style={{ background: "#3A3A3A", boxShadow: "0 0 0 2px #FFFFFF" }} aria-hidden="true" />
                  )}
                </span>
              </button>
            )}
          </div>

          {/* Plain ownership form (no card) shown when doc icon is clicked */}
          {showForm && !claimSubmitted && item.kind !== "lost" && claimBlockedUntil && (
            <p className="text-sm mb-4 pb-4" style={{ color: "#3A3A3A", borderBottom: "1px solid #E5E5E5" }}>
              You've made 3 claims in the last 24 hours. You can claim again after {new Date(claimBlockedUntil).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.
            </p>
          )}
          {showForm && !claimSubmitted && item.kind === "lost" && !builderOpen && (
            <CreateFormCard onOpen={openBuilder} className="mb-4" />
          )}
          {showForm && !claimSubmitted && !(item.kind !== "lost" && claimBlockedUntil) && (item.kind !== "lost" || builderOpen) && (
            <form
              onSubmit={e => {
                e.preventDefault();
                if (item.kind === "lost") {
                  if (finalQuestions.length === 0) return;
                  onSubmitFoundReport?.(item, finalQuestions, claimNote);
                } else {
                  const payload = (item.challenge ?? []).map(q => ({ question_id: q.id, prompt: q.prompt, answer: (claimAnswers[q.id] ?? "").trim() }));
                  onSubmitChallengeResponse?.(item.id, payload, claimNote);
                }
                setClaimSubmitted(true);
              }}
              className={item.kind === "lost" ? "flex flex-col gap-4 mb-4 rounded-xl p-4 sm:p-5" : "flex flex-col gap-4 mb-4 pb-4"}
              style={item.kind === "lost" ? { background: FORM_CARD_BG } : { borderBottom: "1px solid #E5E5E5" }}
            >
              {item.kind !== "lost" && (item.challenge ?? []).map((q, i) => (
                <div key={q.id}>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>{i + 1}. {q.prompt} <span style={{ color: "#3A3A3A" }}>*</span></label>
                  <input type="text" required className={formInputCls} value={claimAnswers[q.id] ?? ""} onChange={ev => setClaimAnswers(v => ({ ...v, [q.id]: ev.target.value }))} />
                </div>
              ))}
              {item.kind === "lost" && (
                <div className="flex flex-col gap-4">
                  <p className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Verification form</p>
                  <QuestionBuilder questions={reportQuestions} onChange={setReportQuestions} />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>
                  {item.kind === "lost" ? "Note to the owner (optional)" : "Note to finder (optional)"}
                </label>
                <textarea rows={3} className={formInputCls + " resize-none"} value={claimNote} onChange={ev => setClaimNote(ev.target.value)} placeholder={item.kind === "lost" ? "Where you found it, where it is now…" : "Any additional details…"} />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={item.kind === "lost" && finalQuestions.length === 0}
                  className={btnDark + " disabled:opacity-40 disabled:cursor-not-allowed"}
                >
                  {item.kind === "lost" ? "Send to owner" : "Submit claim"}
                </button>
                <button type="button" onClick={() => item.kind === "lost" ? cancelBuilder() : setPanel("comments")} className={btnGrey}>Cancel</button>
              </div>
            </form>
          )}
          {showForm && claimSubmitted && !myResponse && (
            <p className="text-sm font-medium mb-4 pb-4" style={{ color: "#3A3A3A", borderBottom: "1px solid #E5E5E5" }}>
              {item.kind === "lost" ? "Sent to the owner — you'll be notified when they respond." : "Claim submitted!"}
            </p>
          )}

          {showFlow && (
            <div className="mb-4">
              <OwnershipActionSection
                item={item}
                currentUserId={currentUserId}
                responses={challengeResponses}
                initialReportId={initialReportId}
                onEscalate={onEscalate}
                onOwnerAnswer={onOwnerAnswer}
                onApprove={onApprove}
                onReject={onReject}
              />
            </div>
          )}

          {showComments && (visibleComments.length === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: "#6B7280" }}>No comments yet</p>
          ) : (
            <div className="flex flex-col gap-3">
              {visibleComments.map(c => (
                <CommentThread key={c.id} node={c} depth={0} onAddReply={onAddReply} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Sticky composer with a Public/Private toggle */}
      <form onSubmit={submitComment} className="flex flex-col gap-2 p-4 shrink-0" style={{ borderTop: "1px solid #E5E5E5", background: "#FFFFFF" }}>
        <div className="max-w-2xl mx-auto w-full flex flex-col gap-2">
          <div className="flex gap-1">
            {(["public", "private"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className="px-3 py-1 text-xs font-semibold rounded-full transition-colors"
                style={visibility === v
                  ? { background: "#3A3A3A", color: "#FFFFFF" }
                  : { background: "#F2F2F2", color: "#6B7280" }}
              >
                {v === "public" ? "Public" : "Private to author"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={commentDraft}
              onChange={e => setCommentDraft(e.target.value)}
              placeholder={visibility === "private" ? "Private note to the author…" : "Write a comment…"}
              className="flex-1 px-4 py-2 text-sm rounded-full border focus:outline-none focus:ring-2"
              style={{ background: "#FFFFFF", borderColor: "#E5E5E5", color: "#3A3A3A" }}
            />
            <button type="submit" disabled={!commentDraft.trim()} className="px-4 py-2 text-sm font-semibold rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#3A3A3A", color: "#FFFFFF" }}>
              Post
            </button>
          </div>
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
  const openAuthor = useOpenAuthor();
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
      <button type="button" onClick={() => openAuthor(node.author_id, node.author_name)} className="self-start hover:opacity-80" aria-label={`Open ${node.author_name}'s profile`}>
        <Avatar id={node.author_id} name={node.author_name} size={avatarSize} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl px-3 py-2 inline-block max-w-full" style={{ background: "#F0F2F5" }}>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => openAuthor(node.author_id, node.author_name)} className="text-xs font-semibold hover:underline" style={{ color: "#3A3A3A" }}>{node.author_name}</button>
            {useIsVerified(node.author_id) && <VerificationBadge size={12} />}
            {node.visibility === "private" && (
              <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: "#E4E6EB", color: "#6B7280" }}>Private</span>
            )}
            <span className="text-xs" style={{ color: "#6B7280" }}>· {postedLabel(node.created_at)}</span>
          </div>
          <p className="text-sm leading-snug mt-0.5 break-words" style={{ color: "#3A3A3A" }}>{node.message}</p>
        </div>
        <button
          type="button"
          onClick={() => { setReplying(r => !r); setDraft(""); }}
          className="text-xs font-medium mt-1 ml-3 hover:underline"
          style={{ color: "#6B7280" }}
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
              style={{ background: "#FFFFFF", borderColor: "#E5E5E5", color: "#3A3A3A" }}
            />
            <button type="submit" disabled={!draft.trim()} className="px-3 py-1.5 text-xs font-semibold rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: "#3A3A3A", color: "#FFFFFF" }}>
              Reply
            </button>
          </form>
        )}

        {(node.replies?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-3 mt-3 pl-3" style={{ borderLeft: "2px solid #E5E5E5" }}>
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
      style={{ borderBottom: "1px solid #E5E5E5" }}>

      {/* Content — clicking opens the full-screen post detail (Reddit-style) */}
      <div
        className="flex flex-col gap-2 min-w-0 cursor-pointer"
        onClick={() => openDetail(item)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter") openDetail(item); }}
      >
        <div className="flex items-center gap-1.5">
          <AuthorLink id={item.finder_id} name={item.finder_name || userName(item.finder_id)} size={20} textClass="text-xs font-semibold" />
          {useIsVerified(item.finder_id) && <VerificationBadge size={13} />}
          <span className="text-xs" style={{ color: "#6B7280" }}>· {postedLabel(item.created_at)}</span>
          <span
            className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={item.kind === "lost"
              ? { background: "#F5ECEC", color: "#9A3F3F" }
              : { background: "#E6CFA9", color: "#5C2020" }}
          >
            {item.kind === "lost" ? "Lost" : "Found"}
          </span>
          {item.pending_sync && <SyncChip />}
        </div>

        <h3 className="text-xl font-semibold leading-snug" style={{ color: "#3A3A3A" }}>{item.title}</h3>
        {item.description && <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: "#4B5563" }}>{item.description}</p>}

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "#6B7280" }}>
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
          item.kind === "lost" && lostFlow.currentUserId && item.status !== "released" ? (
            <div className="ml-auto flex items-center gap-2">
              <span
                className="flex items-center gap-1 text-xs font-medium"
                style={{ color: "#6B7280" }}
                title={`${challengeResponseCount} people responded`}
              >
                <IconUsers />
                {challengeResponseCount}
              </span>
              <button
                onClick={() => lostFlow.onFoundThis(item)}
                className="px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
                style={{ background: "#3A3A3A", color: "#FFFFFF" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#525252")}
                onMouseLeave={e => (e.currentTarget.style.background = "#3A3A3A")}
              >
                I found it
              </button>
            </div>
          ) :
          // "Prove it's yours" applies only to FOUND items.
          item.kind !== "lost" && role !== "staff" && onClaim && item.status !== "released" ? (
            <div className="ml-auto flex items-center gap-2">
              <span
                className="flex items-center gap-1 text-xs font-medium"
                style={{ color: "#6B7280" }}
                title={`${challengeResponseCount} responded`}
              >
                <IconUsers />
                {challengeResponseCount}
              </span>
              <button
                onClick={() => onClaim(item)}
                className="px-2.5 py-1 text-xs font-semibold rounded-md transition-colors"
                style={{ background: "#3A3A3A", color: "#FFFFFF" }}
                onMouseEnter={e => (e.currentTarget.style.background = "#525252")}
                onMouseLeave={e => (e.currentTarget.style.background = "#3A3A3A")}
              >
                I lost it
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

// Compact quoted version of an item, shown inside a repost. Clicking it opens
// the original post's detail view.
function QuotedItem({ item }: { item: Item }) {
  const openDetail = useOpenDetail();
  return (
    <button
      type="button"
      onClick={() => openDetail(item)}
      className="w-full text-left rounded-lg p-3 flex gap-3 transition-shadow hover:shadow-md"
      style={{ background: "#FFFFFF", border: "1px solid #E5E5E5" }}
    >
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Avatar id={item.finder_id} name={item.finder_name} size={18} />
          <span className="text-xs font-semibold" style={{ color: "#3A3A3A" }}>{item.finder_name || userName(item.finder_id)}</span>
          {useIsVerified(item.finder_id) && <VerificationBadge size={12} />}
          <span className="text-xs" style={{ color: "#6B7280" }}>· {postedLabel(item.created_at)}</span>
        </div>
        <p className="text-sm font-semibold leading-snug" style={{ color: "#3A3A3A" }}>{item.title}</p>
        <p className="text-xs leading-snug line-clamp-2" style={{ color: "#6B7280" }}>{item.description}</p>
        <span className="flex items-center gap-1 text-xs" style={{ color: "#6B7280" }}><IconMapPin />{item.location_found}</span>
      </div>
      {item.image_url && (
        <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden" style={{ background: "#D4B890" }}>
          <img src={item.image_url} alt={item.description} className="w-full h-full object-cover" />
        </div>
      )}
    </button>
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
    <div className="py-4 flex flex-col gap-2" style={{ borderBottom: "1px solid #E5E5E5" }}>
      <div className="flex items-center gap-1.5">
        <span style={{ color: "#6B7280" }}><IconRepost size={14} /></span>
        <AuthorLink id={repost.user_id} name={repost.user_name} size={20} textClass="text-xs font-semibold" />
        <span className="text-xs whitespace-nowrap" style={{ color: "#6B7280" }}>reposted · {postedLabel(repost.created_at)}</span>
        {onRemove && (
          <button onClick={onRemove} className="ml-auto text-xs font-medium hover:underline" style={{ color: "#6B7280" }}>
            Remove
          </button>
        )}
      </div>
      {repost.caption && (
        <p className="text-sm leading-relaxed" style={{ color: "#3A3A3A" }}>{repost.caption}</p>
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
      <div className="relative rounded-2xl shadow-xl w-full max-w-md flex flex-col" style={{ background: "#FFFFFF" }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: "1px solid #C1856D" }}>
          <h2 className="text-base font-semibold" style={{ color: "#3A3A3A" }}>{alreadyReposted ? "Edit your repost" : "Repost to your timeline"}</h2>
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

// ─── Ownership Challenge: answer page ("Prove it's yours", Requirement 16) ──────

function ChallengeModal({ item, onClose, onSubmit }: {
  item: Item;
  onClose: () => void;
  onSubmit: (answers: ChallengeAnswer[], note: string) => void;
}) {
  const openDetail = useOpenDetail();
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
    <div className="fixed inset-0 z-50 overflow-y-auto scroll-area" style={{ background: "#FFFFFF" }}>
      {/* Page header */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14" style={{ background: "#FFFFFF", borderBottom: "1px solid #C1856D" }}>
        <button onClick={onClose} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B7280" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm" style={{ color: "#3A3A3A" }}>I lost it</span>
      </header>

      <div className="max-w-lg mx-auto px-4 py-6">
        {submitted ? (
          <div className="text-center py-16">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 className="text-xl font-semibold" style={{ color: "#3A3A3A" }}>Answers submitted</h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
              The finder will review your answers and follow up. Pickup is handled in person at the admin office.
            </p>
            <button onClick={onClose} className={btnPrimary + " mt-6"}>Done</button>
          </div>
        ) : (
          <>
            {/* Item context — click to open actual post */}
            <button
              type="button"
              onClick={() => { onClose(); openDetail(item); }}
              className="w-full text-left rounded-xl p-4 mb-6 flex items-start gap-3 transition-shadow hover:shadow-md"
              style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}
            >
              {item.image_url && <img src={item.image_url} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />}
              <div className="min-w-0">
                <p className="font-semibold text-sm" style={{ color: "#3A3A3A" }}>{item.title}</p>
                <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>{hasQuestions ? "Answer the finder's questions to prove this item is yours." : "Send the finder a note explaining why this item is yours."}</p>
              </div>
            </button>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {questions.map((q, i) => (
                <div key={q.id}>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>
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
                <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>
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


// ─── Catalog View ─────────────────────────────────────────────────────────────

function CatalogView({ items, role, user, search, categoryFilter, onClearFilters, onClaim, onUpvote, upvotedIds, onRepost, repostCounts, myRepostItemIds, reposts, onShare, comments, onAddComment, onAddReply, challengeResponseCounts }: {
  items: Item[];
  role: Role;
  user: AuthUser;
  search: string;
  categoryFilter: string;
  onClearFilters: () => void;
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
  const hasFilters = search !== "" || categoryFilter !== "All";

  return (
    <div className="max-w-2xl mx-auto px-4 pt-1 pb-6">
      {filtered.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
          <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>{hasFilters ? "No items match your search" : "Nothing posted yet"}</p>
          {hasFilters && (
            <button type="button" onClick={onClearFilters} className={btnSecondary + " mt-3"}>Clear filters</button>
          )}
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

// ─── Gallery View (photo-centric masonry grid, Requirement 19) ────────────────────

function GalleryView({ items, user }: { items: Item[]; user: AuthUser }) {
  // Same visibility rules as the catalog.
  const visible = items.filter(i =>
    i.status === "in_office" || i.status === "approved_for_pickup" ||
    (i.status === "pending_intake" && i.finder_id === user.id),
  );
  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4">
      <PhotoGrid items={visible} emptyText="Posts with photos will appear here." />
    </div>
  );
}

// Responsive masonry photo grid (Requirement 19.2): CSS columns re-flow live as
// the window resizes — 2 on phones, 3 ≥640px, 4 ≥1024px, 5 ≥1280px.
// Items without photos are skipped.
function PhotoTile({ item }: { item: Item }) {
  const openDetail = useOpenDetail();
  return (
    <button
      onClick={() => openDetail(item)}
      className="relative w-full text-left overflow-hidden rounded-xl mb-2 block break-inside-avoid"
    >
      <img src={item.image_url} alt={item.title} loading="lazy" className="w-full h-auto object-cover block" />
      {/* Minimal overlay — Found/Lost tag + title */}
      <div
        className="absolute bottom-0 left-0 right-0 px-2 py-2"
        style={{ background: "linear-gradient(to top, rgba(44,20,20,0.72) 0%, transparent 100%)" }}
      >
        <span
          className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded mb-1 inline-block"
          style={item.kind === "lost"
            ? { background: "rgba(154,63,63,0.85)", color: "#FFFFFF" }
            : { background: "rgba(193,133,109,0.85)", color: "#FFFFFF" }}
        >
          {item.kind === "lost" ? "Lost" : "Found"}
        </span>
        <p className="text-xs font-semibold leading-tight line-clamp-2" style={{ color: "#FFFFFF" }}>{item.title}</p>
      </div>
    </button>
  );
}

function PhotoGrid({ items, emptyText }: { items: Item[]; emptyText: string }) {
  const photoItems = items.filter(i => i.image_url);
  if (photoItems.length === 0) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>No posts with photos yet</p>
        <p className="text-xs mt-1" style={{ color: "#9A7070" }}>{emptyText}</p>
      </div>
    );
  }
  return (
    <div className="columns-2 sm:columns-3 lg:columns-4 xl:columns-5 gap-2">
      {photoItems.map(item => <PhotoTile key={item.id} item={item} />)}
    </div>
  );
}

// ─── Finder Form ──────────────────────────────────────────────────────────────

// Location field: pick a PUP campus place or type your own (Requirement 1.1b).
function LocationCombobox({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = matchPlaces(value, 50);
  const listId = "campus-place-list";

  function pick(place: string) {
    onChange(place);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className="relative flex-1 min-w-0">
      <input
        type="text"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={placeholder}
        value={value}
        required
        placeholder={placeholder}
        autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && active >= 0 && options[active]) { e.preventDefault(); pick(options[active]); }
          else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        }}
        className="w-full min-w-0 p-0 border-0 bg-transparent outline-none text-sm placeholder:text-[#B8A0A0]"
        style={{ color: "#3A3A3A" }}
      />
      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-2 z-20 max-h-60 overflow-y-auto rounded-lg py-1 shadow-lg"
          style={{ background: "#FFFFFF", border: "1px solid #E5E5E5" }}
        >
          {options.map((place, i) => (
            <li
              key={place}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so the input's blur doesn't close the list first
              onMouseDown={e => { e.preventDefault(); pick(place); }}
              onMouseEnter={() => setActive(i)}
              className="px-3 py-2 text-sm cursor-pointer flex items-center gap-2"
              style={{ background: i === active ? "#F5ECEC" : "transparent", color: "#3A3A3A" }}
            >
              <span style={{ color: "#9A7070" }}><IconMapPin /></span>
              {place}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Caption editor: one caption string, first line bold as the post title while
// typing (Requirement 1.1a). Two seamless textareas behave like one field.
function CaptionEditor({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const nl = value.indexOf("\n");
  const title = nl === -1 ? value : value.slice(0, nl);
  const body = nl === -1 ? "" : value.slice(nl + 1);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [bodyShown, setBodyShown] = useState(false); // show the body line after Enter even while empty

  const join = (t: string, b: string) => (b || bodyShown ? `${t}\n${b}` : t);
  // Auto-grow both areas to fit their text.
  useEffect(() => {
    for (const el of [titleRef.current, bodyRef.current]) {
      if (!el) continue;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title, body, bodyShown]);

  // Move the caret after React renders (the body area may not exist yet).
  const [pendingFocus, setPendingFocus] = useState<{ to: "title" | "body"; pos: number } | null>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    const el = pendingFocus.to === "body" ? bodyRef.current : titleRef.current;
    if (el) { el.focus(); el.setSelectionRange(pendingFocus.pos, pendingFocus.pos); }
    setPendingFocus(null);
  }, [pendingFocus]);

  return (
    <div className="flex flex-col min-h-[6rem] cursor-text" onClick={e => { if (e.target === e.currentTarget) (bodyRef.current ?? titleRef.current)?.focus(); }}>
      <textarea
        ref={titleRef}
        rows={1}
        required
        aria-label="Caption"
        value={title}
        placeholder={placeholder}
        onChange={e => {
          // Newlines (e.g. from paste) start the body.
          const [first, ...rest] = e.target.value.split("\n");
          if (rest.length) {
            setBodyShown(true);
            onChange(`${first}\n${rest.join("\n")}${body ? `\n${body}` : ""}`);
            setPendingFocus({ to: "body", pos: rest.join("\n").length });
          } else {
            onChange(join(first, body));
          }
        }}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            setBodyShown(true);
            onChange(`${title}\n${body}`);
            setPendingFocus({ to: "body", pos: 0 });
          }
        }}
        className="w-full p-0 border-0 bg-transparent outline-none resize-none overflow-hidden text-base font-semibold leading-snug placeholder:font-normal placeholder:text-[#B8A0A0]"
        style={{ color: "#3A3A3A" }}
      />
      {(body || bodyShown) && (
        <textarea
          ref={bodyRef}
          rows={1}
          aria-label="Caption details"
          value={body}
          onChange={e => onChange(`${title}\n${e.target.value}`)}
          onKeyDown={e => {
            const el = e.currentTarget;
            if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
              // Join the first body line back onto the title line.
              e.preventDefault();
              const [first, ...rest] = body.split("\n");
              const caret = title.length;
              if (!body) setBodyShown(false);
              onChange(rest.length ? `${title}${first}\n${rest.join("\n")}` : `${title}${first}`);
              setPendingFocus({ to: "title", pos: caret });
            }
          }}
          onBlur={() => { if (!body) setBodyShown(false); }}
          className="w-full mt-1 p-0 border-0 bg-transparent outline-none resize-none overflow-hidden text-sm leading-relaxed"
          style={{ color: "#6B3A3A" }}
        />
      )}
    </div>
  );
}

function FinderForm({ onSubmit, user }: {
  onSubmit: (item: Partial<Item>) => "posted" | "queued";
  user: AuthUser;
}) {
  const [queued, setQueued] = useState(false);
  const [mode, setMode] = useState<"found" | "lost">("found");
  // One set of fields for both modes (Requirement 1.0a); submit maps them.
  const emptyFields = () => ({ caption: "", category: "", location: "", note: "" });
  const [fields, setFields] = useState(emptyFields);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoData, setPhotoData] = useState<string | null>(null); // data URL of the selected image
  const [submitted, setSubmitted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [caption, setCaption] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [showCaptionImport, setShowCaptionImport] = useState(false);
  // Ownership Challenge (optional, Found only): finder-authored short-text questions.
  const [challengeQs, setChallengeQs] = useState<ChallengeQuestion[]>([]);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isLost = mode === "lost";

  function setField(name: keyof ReturnType<typeof emptyFields>, value: string) {
    setFields(f => ({ ...f, [name]: value }));
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
        setFields(f => ({
          ...f,
          caption: joinCaption(parsed.title, parsed.description) || f.caption,
          category: parsed.category || f.category,
          location: parsed.location_found || f.location,
        }));
        setImportMsg(null);
        setShowCaptionImport(false); // fields are filled behind the pop-up
      }
    } catch {
      setImportMsg("Something went wrong reading that caption. Please fill the fields manually.");
    } finally {
      setImporting(false);
    }
  }

  // Re-encode through a canvas so EXIF/GPS never leaves the device (Requirement 1.4).
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await processPhoto(file);
  }

  // Drag-and-drop onto the photo area (Requirement 1.4a).
  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!dragging) setDragging(true); },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processPhoto(file);
    },
  };

  async function processPhoto(file: File) {
    setProcessing(true);
    setPhotoError(null);
    try {
      setPhotoData(await reencodeImage(file));
      setPhotoName(file.name);
    } catch {
      setPhotoError("That file isn't an image we can read.");
    } finally {
      setProcessing(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    const { title, description } = splitCaption(fields.caption);
    const common = {
      title,
      description,
      category: fields.category,
      location_found: fields.location,
      time_found: new Date().toISOString(), // recorded as the posting time
      private_note: fields.note.trim() || undefined,
      upvotes: 0,
      ...(photoData ? { image_url: photoData } : {}),
    };
    if (isLost) {
      // Lost posts are items with kind="lost" so they appear in the shared catalog.
      setQueued(onSubmit({ ...common, kind: "lost", status: "in_office" }) === "queued");
      return;
    }
    const challenge = cleanQuestions(challengeQs);
    setQueued(onSubmit({
      ...common,
      status: "pending_intake",
      ...(challenge.length > 0 ? { challenge } : {}),
    }) === "queued");
  }

  function resetAll() {
    setSubmitted(false); setQueued(false); setFields(emptyFields());
    setPhotoName(null); setPhotoData(null); setChallengeQs([]); setChallengeOpen(false);
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: "#F2EBE5" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 className="text-xl font-semibold" style={{ color: "#3A3A3A" }}>{isLost ? "Lost item posted" : "Item logged"}</h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
          {isLost
            ? "Your lost-item post is now in the catalog for everyone to see. If someone finds it, they can respond there."
            : "Drop it off at the admin office (Room 101, Main Hall) to complete intake. The item won't appear in the public catalog until staff confirm physical custody."}
        </p>
        {queued && (
          <p className="mt-3 text-sm font-medium" style={{ color: "#9A3F3F" }}>
            You're offline, so it's saved on this device. It will post when you're back online.
          </p>
        )}
        <button onClick={resetAll} className={btnPrimary + " mt-6"}>
          {isLost ? "Post another" : "Log another item"}
        </button>
      </div>
    );
  }


  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold" style={{ color: "#3A3A3A" }}>Log a Found/Lost Item</h1>
      </div>

      {/* AI caption import — pop-up in the verification-form card style */}
      {showCaptionImport && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="caption-import-title">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCaptionImport(false)} />
          <div className="relative w-full sm:max-w-md flex flex-col gap-4 rounded-t-2xl sm:rounded-xl p-4 sm:p-5 shadow-xl" style={{ background: FORM_CARD_BG }}>
            <div className="flex items-center justify-between gap-2">
              <p id="caption-import-title" className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Fill from a post caption</p>
              <button type="button" onClick={() => setShowCaptionImport(false)} aria-label="Close" className="hover:opacity-70" style={{ color: "#6B7280" }}>
                <IconX />
              </button>
            </div>
            <textarea
              autoFocus
              value={caption}
              onChange={e => setCaption(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); setShowCaptionImport(false); } }}
              rows={5}
              placeholder="Paste caption here…"
              className={formInputCls + " resize-none"}
            />
            {importMsg && <p className="text-xs" style={{ color: "#6B7280" }}>{importMsg}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleFillFromCaption}
                disabled={!caption.trim() || importing}
                className={btnDark + " inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"}
              >
                <IconSparkles />
                {importing ? "Generating…" : "Generate"}
              </button>
              <button type="button" onClick={() => setShowCaptionImport(false)} className={btnGrey}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* The post, as it will appear (Requirement 1.0a) */}
        <article className="rounded-xl p-4 flex flex-col gap-3" style={{ border: "1px solid #E6CFA9", background: "#FFFFFF" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Avatar id={user.id} name={user.name} size={32} />
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-semibold truncate" style={{ color: "#3A3A3A" }}>{user.name}</p>
              <p className="text-xs" style={{ color: "#9A7070" }}>just now</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {/* Found / Lost tag — tap to switch */}
              <div className="inline-flex rounded-md p-0.5" style={{ background: "#F5ECEC" }} role="radiogroup" aria-label="Post type">
                {(["found", "lost"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className="px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide rounded transition-colors"
                    style={mode === m
                      ? (m === "lost" ? { background: "#9A3F3F", color: "#FFFFFF" } : { background: "#E6CFA9", color: "#5C2020" })
                      : { color: "#9A7070" }}
                  >
                    {m === "found" ? "Found" : "Lost"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="relative pr-11">
            <CaptionEditor
              value={fields.caption}
              onChange={v => setField("caption", v)}
              placeholder={isLost ? "What did you lose?" : "What did you find?"}
            />
            {/* Generate from a pasted caption (Requirement 12) */}
            {!showCaptionImport && (
              <button
                type="button"
                onClick={() => { setImportMsg(null); setShowCaptionImport(true); }}
                className="absolute bottom-0 right-0 inline-flex items-center justify-center w-9 h-9 transition-opacity hover:opacity-70"
                style={{ color: "#9A3F3F" }}
                aria-label="Generate from caption"
                title="Generate from caption"
              >
                <IconSparkles />
              </button>
            )}
          </div>

          <div className="flex flex-col gap-2 text-sm" style={{ color: "#6B3A3A" }}>
            <div className="flex items-center gap-2">
              <IconMapPin />
              <LocationCombobox
                value={fields.location}
                onChange={v => setField("location", v)}
                placeholder={isLost ? "Where did you lose it?" : "Where did you find it?"}
              />
            </div>
            <label className="self-start">
              <span className="sr-only">Category</span>
              <select
                value={fields.category}
                onChange={e => setField("category", e.target.value)}
                required
                className="px-3 py-1 text-xs font-semibold rounded-full border bg-transparent outline-none cursor-pointer"
                style={{ borderColor: "#C1856D", color: fields.category ? "#3A3A3A" : "#9A7070" }}
              >
                <option value="">Category</option>
                {CATEGORIES.slice(1).map(c => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>

          {/* Photo — where the post image goes */}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          {photoData && !processing ? (
            <div className="relative rounded-lg overflow-hidden" style={{ background: "#D4B890" }} {...dropProps}>
              <img src={photoData} alt={photoName ?? "Selected photo"} className="w-full max-h-96 object-cover" />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="absolute bottom-2 right-2 px-3 py-1 text-xs font-semibold rounded-full"
                style={{ background: "rgba(44,20,20,0.7)", color: "#FFFFFF" }}
              >
                Change photo
              </button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              className="rounded-lg p-6 text-center cursor-pointer transition-colors"
              style={{ border: `2px dashed ${dragging ? "#9A3F3F" : "#C1856D"}`, background: dragging ? "#EBD9D9" : "#F5ECEC" }}
              {...dropProps}
            >
              {processing ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#9A3F3F", borderTopColor: "transparent" }} />
                  <p className="text-xs" style={{ color: "#6B3A3A" }}>Stripping location metadata…</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2" style={{ color: "#9A7070" }}>
                  <IconCamera />
                  <p className="text-sm">{dragging ? "Drop photo here" : "Tap or drag a photo here"}</p>
                </div>
              )}
            </div>
          )}
          {photoError && <p className="text-xs" style={{ color: "#9A3F3F" }}>{photoError}</p>}
        </article>

        {/* Ownership challenge (optional, Found only) — same verification-form card as the post view */}
        {!isLost && (challengeOpen ? (
          <div className="flex flex-col gap-4 rounded-xl p-4 sm:p-5" style={{ background: FORM_CARD_BG }}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Verification form</p>
              <button
                type="button"
                onClick={() => { setChallengeOpen(false); setChallengeQs([]); }}
                className="text-xs font-medium hover:opacity-70"
                style={{ color: "#6B7280" }}
              >
                Remove
              </button>
            </div>
            <QuestionBuilder questions={challengeQs} onChange={setChallengeQs} />
          </div>
        ) : (
          <CreateFormCard onOpen={() => { setChallengeQs([sampleQuestion()]); setChallengeOpen(true); }} />
        ))}

        <div>
          <label className="block text-sm font-medium mb-1.5" style={{ color: "#3A3A3A" }}>Private note to staff</label>
          <textarea value={fields.note} onChange={e => setField("note", e.target.value)} rows={2} className={inputCls + " resize-none"} />
        </div>

        <button type="submit" className={btnPrimary + " w-full py-3"}>Post</button>
      </form>
    </div>
  );
}

// ─── Missing Notices ──────────────────────────────────────────────────────────


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
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "#9A3F3F", color: "#FFFFFF" }}>
          <IconShield />
        </div>
        <div>
          <h1 className="text-xl font-semibold" style={{ color: "#3A3A3A" }}>Staff Dashboard</h1>
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
              ? { background: "#FFFFFF", color: "#3A3A3A" }
              : { color: "#6B3A3A" }
            }
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full font-semibold" style={{ background: t.countBg, color: "#FFFFFF" }}>{t.count}</span>
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
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "#FFFFFF", color: "#9A3F3F" }}>{item.category}</span>
                        <StatusBadge status={item.status} />
                      </div>
                      <p className="text-sm mb-2" style={{ color: "#3A3A3A" }}>{item.description}</p>
                      {item.private_note && (
                        <div className="p-2.5 rounded-lg mb-2" style={{ background: "#FFFFFF", border: "1px solid #C1856D" }}>
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
                      style={{ background: "#9A3F3F", color: "#FFFFFF" }}
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
                        <p className="text-sm mt-1" style={{ color: "#3A3A3A" }}>{item?.category} · {item?.description?.slice(0, 60)}…</p>
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
                <p className="font-medium text-sm" style={{ color: "#3A3A3A" }}>Claim by {activeClaim.owner_name}</p>
                <p className="text-xs mt-0.5" style={{ color: "#6B3A3A" }}>{allItems.find(i => i.id === activeClaim.item_id)?.description}</p>
              </div>
              <ClaimBadge status={activeClaim.status} />
            </div>

            <div className="p-5 flex flex-col gap-4 max-h-72 overflow-y-auto scroll-area" style={{ background: "#FFFFFF" }}>
              <div className="p-3 rounded-lg" style={{ background: "#E6CFA9", border: "1px solid #C1856D" }}>
                <p className="text-xs font-medium mb-1" style={{ color: "#6B3A3A" }}>Owner's identifying details</p>
                <p className="text-sm" style={{ color: "#3A3A3A" }}>{activeClaim.identifying_details}</p>
              </div>
              {activeClaim.messages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.sender_role === "staff" ? "items-end" : "items-start"}`}>
                  <div className="max-w-xs px-4 py-3 rounded-2xl text-sm leading-relaxed"
                    style={msg.sender_role === "owner"
                      ? { background: "#E6CFA9", color: "#3A3A3A", border: "1px solid #C1856D" }
                      : { background: "#9A3F3F", color: "#FFFFFF" }
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
                <form onSubmit={handleStaffReply} className="p-4 flex gap-3" style={{ borderTop: "1px solid #C1856D", background: "#FFFFFF" }}>
                  <input type="text" value={reply} onChange={e => setReply(e.target.value)} placeholder="Reply to owner..." className={inputCls + " flex-1"} />
                  <button type="submit" disabled={!reply.trim()} className={btnPrimary + " disabled:opacity-40 disabled:cursor-not-allowed"}>Send</button>
                </form>
                <div className="px-5 pb-5 flex gap-3" style={{ background: "#FFFFFF" }}>
                  <button
                    onClick={() => { onClaimAction(activeClaim.id, "approved"); setActiveClaimId(null); }}
                    className="flex-1 py-2.5 text-sm font-semibold rounded-lg transition-colors"
                    style={{ background: "#9A3F3F", color: "#FFFFFF" }}
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

type View = "catalog" | "gallery" | "log" | "profile" | "staff" | "notifications";

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
  const canCreate = role !== "staff";
  const [filterOpen, setFilterOpen] = useState(false);
  // Search starts collapsed (just the icon); clicking the icon expands it.
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  return (
    <header className="sticky top-0 z-40" style={{ background: "#FFFFFF", borderBottom: "1px solid #E5E5E5" }}>
      {offlineQueueCount > 0 && (
        <div className="text-xs font-medium px-4 py-2 flex items-center gap-2" style={{ background: "#C1856D", color: "#FFFFFF" }}>
          <IconWifi />
          <span>{offlineQueueCount} item{offlineQueueCount !== 1 ? "s" : ""} waiting to sync — reconnect to complete</span>
        </div>
      )}

      {/* Top row — two states: collapsed (icon) and expanded (full search) */}
      <div className="max-w-5xl mx-auto px-4 flex items-center gap-2 h-12">

        {!searchFocused && (
          <button
            onClick={() => setView("catalog")}
            className="flex items-center gap-2 shrink-0"
            aria-label="Home"
          >
            <span className="font-semibold text-xl block" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
              <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
            </span>
          </button>
        )}

        {/* Collapsed: magnifier icon only */}
        {!searchFocused ? (
          <button
            onClick={() => { setSearchFocused(true); setTimeout(() => searchInputRef.current?.focus(), 30); }}
            className="ml-auto inline-flex items-center justify-center w-8 h-8 rounded-lg [&_svg]:w-[18px] [&_svg]:h-[18px] transition-colors shrink-0"
            style={{ color: "#3A3A3A" }}
            aria-label="Open search"
            title="Search"
          >
            <IconSearch />
          </button>
        ) : (
          /* Expanded: full-width search input takes the whole row */
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "#9A7070" }}>
                <IconSearch />
              </span>
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); if (view !== "catalog") setView("catalog"); }}
                onBlur={() => { if (!search.trim()) setSearchFocused(false); }}
                placeholder="Search"
                className="w-full pl-9 pr-16 py-2 text-sm rounded-full border focus:outline-none focus:ring-2"
                style={{ background: "transparent", borderColor: "#C1856D", color: "#3A3A3A" }}
              />
              {search && (
                <button
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setSearch("")}
                  className="absolute right-9 top-1/2 -translate-y-1/2"
                  style={{ color: "#9A7070" }}
                  aria-label="Clear search"
                >
                  <IconX />
                </button>
              )}
              <button
                onMouseDown={e => e.preventDefault()} // keep the search open (its blur collapses it)
                onClick={() => setFilterOpen(o => !o)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: categoryFilter !== "All" ? "#9A3F3F" : "#9A7070" }}
                aria-label="Filter by category"
                aria-expanded={filterOpen}
              >
                <IconFilter />
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onMouseDown={e => e.preventDefault()} onClick={() => setFilterOpen(false)} />
                  <div className="absolute right-0 mt-2 z-50 w-48 rounded-lg py-1 shadow-xl" style={{ background: "#FFFFFF", border: "1px solid #C1856D" }}>
                    {CATEGORIES.map(c => (
                      <button
                        key={c}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setCategoryFilter(c); setFilterOpen(false); if (view !== "catalog") setView("catalog"); }}
                        className="w-full text-left px-3 py-2 text-sm transition-colors"
                        style={c === categoryFilter ? { background: "#E6CFA9", color: "#9A3F3F", fontWeight: 600 } : { color: "#3A3A3A" }}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => { setSearchFocused(false); setSearch(""); setFilterOpen(false); }}
              className="text-sm font-medium shrink-0 transition-colors hover:opacity-70"
              style={{ color: "#6B3A3A" }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Right controls — hidden when search is expanded */}
        {!searchFocused && (
          <div className="flex items-center gap-2 shrink-0">
            {canCreate && (
              <button
                onClick={() => setView("log")}
                className="hidden md:inline-flex items-center justify-center w-8 h-8 rounded-lg [&_svg]:w-[18px] [&_svg]:h-[18px] transition-opacity hover:opacity-70"
                style={{ color: view === "log" ? "#9A3F3F" : "#3A3A3A" }}
                aria-label="Log a found item"
                title="Log a found item"
              >
                <IconPlus />
              </button>
            )}
            <button
              onClick={() => setView("gallery")}
              className="hidden md:inline-flex items-center justify-center w-8 h-8 rounded-lg [&_svg]:w-[18px] [&_svg]:h-[18px] transition-opacity hover:opacity-70"
              style={{ color: view === "gallery" ? "#9A3F3F" : "#3A3A3A" }}
              aria-label="Gallery"
              aria-current={view === "gallery" ? "page" : undefined}
              title="Gallery"
            >
              <TabIconCommunity active={view === "gallery"} />
            </button>
            <button
              onClick={() => setView("notifications")}
              className="relative hidden md:inline-flex items-center justify-center w-8 h-8 rounded-lg [&_svg]:w-[18px] [&_svg]:h-[18px] transition-colors shrink-0"
              style={{ color: view === "notifications" ? "#9A3F3F" : "#3A3A3A" }}
              aria-label="Notifications"
              title="Notifications"
            >
              <IconBell />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center" style={{ background: "#9A3F3F", color: "#FFFFFF" }}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
          <button
            onClick={() => setView("profile")}
            className="hidden md:block rounded-full transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2"
            style={{ boxShadow: view === "profile" ? "0 0 0 2px #9A3F3F" : "none" }}
            aria-label="Open your profile"
            title="Your profile"
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover block" />
            ) : (
              <span
                className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-semibold shrink-0"
                style={{ background: "#9A3F3F", color: "#FFFFFF" }}
                aria-hidden="true"
              >
                {user.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}
              </span>
            )}
          </button>
        </div>
        )}
      </div>

    </header>
  );
}

// ─── Mobile bottom tab bar (Requirement 11a.9) ─────────────────────────────────

function TabIconFeed({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M3.5 10.2 12 3l8.5 7.2v9.3a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6.5h-5V21H5a1.5 1.5 0 0 1-1.5-1.5Z"
        fill={active ? "currentColor" : "none"}
      />
    </svg>
  );
}

function TabIconCommunity({ active }: { active: boolean }) {
  const cells = [3.5, 10, 16.5];
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {cells.flatMap(y => cells.map(x => (
        <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx={active ? 1 : 1.3} />
      )))}
    </svg>
  );
}

function TabIconAlerts({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 16.2V11a6 6 0 1 0-12 0v5.2l-1.4 1.9a.6.6 0 0 0 .5 1h13.8a.6.6 0 0 0 .5-1Z" fill={active ? "currentColor" : "none"} />
      <path d="M9.8 21.5a2.5 2.5 0 0 0 4.4 0" />
    </svg>
  );
}

function TabIconProfile({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="10" r="3.2" fill={active ? "currentColor" : "none"} />
      <path d="M6.2 18.6c1.4-2.1 3.4-3.2 5.8-3.2s4.4 1.1 5.8 3.2" />
    </svg>
  );
}

function BottomNav({ view, canCreate, unreadCount, onFeed, onCommunity, onCreate, onAlerts, onProfile }: {
  view: View;
  canCreate: boolean;
  unreadCount: number;
  onFeed: () => void;
  onCommunity: () => void;
  onCreate: () => void;
  onAlerts: () => void;
  onProfile: () => void;
}) {
  const tabs = [
    { key: "feed", label: "Feed", active: view === "catalog", onClick: onFeed, Icon: TabIconFeed },
    { key: "community", label: "Community", active: view === "gallery", onClick: onCommunity, Icon: TabIconCommunity },
    { key: "alerts", label: "Alerts", active: view === "notifications", onClick: onAlerts, Icon: TabIconAlerts },
    { key: "profile", label: "Profile", active: view === "profile", onClick: onProfile, Icon: TabIconProfile },
  ];

  const renderTab = (t: typeof tabs[number]) => (
    <button
      key={t.key}
      type="button"
      onClick={t.onClick}
      aria-current={t.active ? "page" : undefined}
      aria-label={t.key === "alerts" && unreadCount > 0 ? `${t.label}, ${unreadCount} unread` : t.label}
      className="relative flex-1 flex flex-col items-center justify-center h-full min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3A3A3A]/25"
      style={{ color: t.active ? "#3A3A3A" : "#6B7280" }}
    >
      <span className="relative">
        <t.Icon active={t.active} />
        {t.key === "alerts" && unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold leading-4 text-center"
            style={{ background: "#3A3A3A", color: "#FFFFFF", boxShadow: "0 0 0 2px #FFFFFF" }}
            aria-label={`${unreadCount} unread`}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </span>
    </button>
  );

  return (
    <nav
      className="md:hidden fixed inset-x-0 bottom-0 z-40"
      style={{ background: "#FFFFFF", borderTop: "1px solid #E5E5E5", paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="flex items-stretch h-14 max-w-lg mx-auto px-1">
        {tabs.slice(0, 2).map(renderTab)}
        {canCreate && (
          <div className="flex-1 flex justify-center">
            <button
              type="button"
              onClick={onCreate}
              aria-label="Log a found or lost item"
              className="self-center w-14 h-9 rounded-lg flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3A3A3A]/30 focus-visible:ring-offset-2 transition-transform duration-100 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100"
              style={{ background: view === "log" ? "#525252" : "#3A3A3A", color: "#FFFFFF" }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        )}
        {tabs.slice(2).map(renderTab)}
      </div>
    </nav>
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
    <div className="min-h-[100dvh]" style={{ background: "#FFFFFF", color: "#3A3A3A" }}>
      {/* Nav — single line, slim */}
      <header className="sticky top-0 z-40 backdrop-blur" style={{ background: "rgba(251,249,209,0.85)", borderBottom: "1px solid #E6CFA9" }}>
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <span className="font-semibold text-2xl" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#9A3F3F" }}>Found</span><span style={{ color: "#C1856D" }}>it</span>
          </span>
          <button
            onClick={onGetStarted}
            className="px-4 py-2 text-sm font-semibold rounded-lg transition-all active:scale-[0.98]"
            style={{ background: "#9A3F3F", color: "#FFFFFF", boxShadow: "0 1px 2px rgba(154,63,63,0.2)" }}
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
              style={{ background: "#9A3F3F", color: "#FFFFFF", boxShadow: "0 4px 14px rgba(154,63,63,0.25)" }}
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
              style={{ background: "#FFFFFF", border: "1px solid #C1856D", boxShadow: "0 10px 30px rgba(154,63,63,0.15)" }}>
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: "#F2EBE5", color: "#5C2020", border: "1px solid #D4A896" }}>In office</span>
                <span className="text-xs" style={{ color: "#9A7070" }}>#FND-2043</span>
              </div>
              <div className="w-full h-28 rounded-xl mb-4 flex items-center justify-center" style={{ background: "#E6CFA9" }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9A3F3F" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </div>
              <h3 className="font-semibold" style={{ color: "#3A3A3A" }}>Black wireless earbuds</h3>
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
      <section style={{ background: "#9A3F3F", color: "#FFFFFF" }}>
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
                  style={{ background: "#9A3F3F", color: "#FFFFFF" }}>{s.n}</span>
                {i < steps.length - 1 && <span className="w-px flex-1 mt-2" style={{ background: "#E6CFA9" }} />}
              </div>
              <div className="pb-2">
                <h3 className="text-lg font-semibold" style={{ color: "#3A3A3A" }}>{s.title}</h3>
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
            style={{ background: "#9A3F3F", color: "#FFFFFF", boxShadow: "0 4px 14px rgba(154,63,63,0.25)" }}
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
    <div className="min-h-[100dvh] grid lg:grid-cols-2" style={{ background: "#FFFFFF" }}>
      {/* Brand panel — carries the trust story */}
      <div
        className="relative hidden lg:flex flex-col justify-between p-10 overflow-hidden"
        style={{ background: "#9A3F3F", color: "#FFFFFF" }}
      >
        {/* soft layered glows, tinted to the panel hue (no AI-purple) */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true"
          style={{ background: "radial-gradient(600px circle at 15% 10%, rgba(255,255,255,0.10), transparent 45%), radial-gradient(500px circle at 90% 90%, rgba(193,133,109,0.35), transparent 50%)" }} />
        <div className="relative">
          <span className="text-3xl font-semibold" style={{ fontFamily: "'Momo Trust Display', sans-serif" }}>
            <span style={{ color: "#FFFFFF" }}>Found</span><span style={{ color: "#E8B89E" }}>it</span>
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
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
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

          <h1 className="text-3xl font-bold tracking-tight" style={{ color: "#3A3A3A" }}>Welcome back</h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "#6B3A3A" }}>
            Sign in to log found items and claim what's yours.
          </p>

          <button
            onClick={handleClick}
            disabled={busy}
            className="mt-8 w-full flex items-center justify-center gap-3 px-4 py-3 text-sm font-semibold rounded-xl transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: "#FFFFFF", color: "#3A3A3A", border: "1.5px solid #C1856D", boxShadow: "0 1px 2px rgba(154,63,63,0.08)" }}
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

function ProfileView({ user, items, reposts, onRemoveRepost, onSignOut, verification, onSubmitVerification, verifiedIds }: {
  user: AuthUser;
  items: Item[];
  reposts: Repost[];
  onRemoveRepost: (itemId: string) => void;
  onSignOut: () => void;
  verification?: StudentVerification;
  onSubmitVerification: (docType: DocType, file: File) => Promise<string>;
  verifiedIds: Set<string>;
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
            <span className="inline-flex items-center justify-center w-20 h-20 rounded-full text-2xl font-semibold shrink-0" style={{ background: "#9A3F3F", color: "#FFFFFF" }} aria-hidden="true">
              {user.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}
            </span>
          )}
          <button onClick={onSignOut} className={btnGrey + " shrink-0"}>Sign out</button>
        </div>

        <h1 className="mt-4 text-2xl font-bold flex items-center gap-2" style={{ color: "#3A3A3A" }}>
          {user.name}
          {isVerified && <VerificationBadge size={20} />}
        </h1>
        <p className="mt-0.5 text-sm truncate" style={{ color: "#6B7280" }}>{user.email}</p>

        {/* Stats row */}
        <div className="mt-4 flex items-stretch">
          <div className="flex-1 px-4 py-3 text-center">
            <p className="text-lg font-bold" style={{ color: "#3A3A3A" }}>{postCount}</p>
            <p className="text-xs" style={{ color: "#6B7280" }}>{postCount === 1 ? "Post" : "Posts"}</p>
          </div>
          <div className="flex-1 px-4 py-3 text-center">
            <p className="text-lg font-bold" style={{ color: "#3A3A3A" }}>{repostCount}</p>
            <p className="text-xs" style={{ color: "#6B7280" }}>{repostCount === 1 ? "Repost" : "Reposts"}</p>
          </div>
          <div className="flex-1 px-4 py-3 text-center">
            <p className="text-lg font-bold" style={{ color: isVerified ? "#3A3A3A" : "#6B7280" }}>{isVerified ? "Yes" : "No"}</p>
            <p className="text-xs" style={{ color: "#6B7280" }}>Verified</p>
          </div>
        </div>
      </div>

      {/* Student verification (Requirement 15) — hidden once verified */}
      {status !== "verified" && (
      <div className="rounded-xl p-5 mb-6" style={{ background: FORM_CARD_BG }}>
        <div className="flex items-center gap-2 mb-1">
          <VerificationBadge size={16} color="#3A3A3A" />
          <h2 className="text-sm font-semibold" style={{ color: "#3A3A3A" }}>Student verification</h2>
        </div>

        <p className="text-sm mb-3" style={{ color: "#3A3A3A" }}>
              {status === "rejected"
                ? "That document wasn't confirmed. You can submit a clearer photo and try again."
                : "Prove you're a student to get a verified badge."}
            </p>
            <div className="flex items-center gap-2">
              <select
                aria-label="Document type"
                value={docType}
                onChange={e => setDocType(e.target.value as DocType)}
                className={formInputCls + " flex-1 min-w-0"}
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
                className={btnDark + " shrink-0 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"}
              >
                {verifyBusy ? "Checking…" : "Get verified"}
              </button>
            </div>
        {verifyMsg && <p className="text-xs mt-2" style={{ color: "#3A3A3A" }}>{verifyMsg}</p>}
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
              <ItemCard key={entry.item.id} item={entry.item} role={user.role} />
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

// ─── Public author profile (Requirement 5c) ──────────────────────────────────

function PublicProfileView({ authorId, authorName, items, reposts, currentUserId, onBack, onTop = true }: {
  authorId: string;
  authorName: string;
  items: Item[];
  reposts: Repost[];
  currentUserId: string;
  onBack: () => void;
  onTop?: boolean; // above the post detail when opened from it; below when a post is opened from here
}) {
  const verified = useIsVerified(authorId);
  const profile = useContext(ProfilesContext)[authorId];
  // Same visibility rules as the catalog.
  const visible = (i: Item) =>
    i.status === "in_office" || i.status === "approved_for_pickup" ||
    (i.status === "pending_intake" && i.finder_id === currentUserId);
  type FeedEntry =
    | { kind: "post"; created_at: string; item: Item }
    | { kind: "repost"; created_at: string; repost: Repost; item: Item };
  const feed: FeedEntry[] = [
    ...items.filter(i => i.finder_id === authorId && visible(i))
      .map(i => ({ kind: "post" as const, created_at: i.created_at, item: i })),
    ...reposts.filter(r => r.user_id === authorId)
      .flatMap(r => {
        const item = items.find(i => i.id === r.item_id);
        return item && visible(item) ? [{ kind: "repost" as const, created_at: r.created_at, repost: r, item }] : [];
      }),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const postCount = feed.filter(e => e.kind === "post").length;
  const repostCount = feed.length - postCount;
  const name = profile?.name || items.find(i => i.finder_id === authorId)?.finder_name || authorName;

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onBack(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className={`fixed inset-0 ${onTop ? "z-[60]" : "z-[45]"} flex flex-col`} style={{ background: "#FFFFFF" }}>
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14 shrink-0" style={{ background: "#FFFFFF", borderBottom: "1px solid #E5E5E5" }}>
        <button onClick={onBack} aria-label="Back" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: "#6B7280" }}>
          <IconArrowLeft /> Back
        </button>
        <span className="font-semibold text-sm truncate" style={{ color: "#3A3A3A" }}>Profile</span>
      </header>
      <div className="flex-1 overflow-y-auto scroll-area">
        <div className="max-w-2xl mx-auto px-4 py-6">
          {/* Header — same layout as your own profile */}
          <div className="mb-6">
            <Avatar id={authorId} name={name} size={80} />
            <h1 className="mt-4 text-2xl font-bold flex items-center gap-2" style={{ color: "#3A3A3A" }}>
              {name}
              {verified && <VerificationBadge size={20} />}
            </h1>
            <div className="mt-4 flex items-stretch">
              <div className="flex-1 px-4 py-3 text-center">
                <p className="text-lg font-bold" style={{ color: "#3A3A3A" }}>{postCount}</p>
                <p className="text-xs" style={{ color: "#6B7280" }}>{postCount === 1 ? "Post" : "Posts"}</p>
              </div>
              <div className="flex-1 px-4 py-3 text-center">
                <p className="text-lg font-bold" style={{ color: "#3A3A3A" }}>{repostCount}</p>
                <p className="text-xs" style={{ color: "#6B7280" }}>{repostCount === 1 ? "Repost" : "Reposts"}</p>
              </div>
              <div className="flex-1 px-4 py-3 text-center">
                <p className="text-lg font-bold" style={{ color: verified ? "#3A3A3A" : "#6B7280" }}>{verified ? "Yes" : "No"}</p>
                <p className="text-xs" style={{ color: "#6B7280" }}>Verified</p>
              </div>
            </div>
          </div>

          {feed.length === 0 ? (
            <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #C1856D" }}>
              <p className="text-sm font-medium" style={{ color: "#6B3A3A" }}>No posts yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {feed.map(entry => entry.kind === "post"
                ? <ItemCard key={entry.item.id} item={entry.item} role="owner" />
                : <RepostCard key={entry.repost.id} repost={entry.repost} item={entry.item} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotificationsView({ notifications, onOpen }: {
  notifications: AppNotification[];
  onOpen: (n: AppNotification) => void;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-semibold mb-4" style={{ color: "#3A3A3A" }}>Notifications</h1>
      {notifications.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ border: "1px dashed #D1D5DB" }}>
          <p className="text-sm font-medium" style={{ color: "#6B7280" }}>Nothing yet</p>
          <p className="text-xs mt-1" style={{ color: "#6B7280" }}>Updates about your posts and found reports will show up here.</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {notifications.map(n => (
            <button
              key={n.id}
              onClick={() => onOpen(n)}
              className="text-left py-4 flex items-start gap-3 transition-colors"
              style={{ borderBottom: "1px solid #E5E5E5" }}
            >
              <span className="mt-0.5 shrink-0" style={{ color: n.read ? "#6B7280" : "#3A3A3A" }}><IconBell /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug" style={{ color: "#3A3A3A", fontWeight: n.read ? 400 : 600 }}>{n.message}</p>
                <p className="text-xs mt-0.5" style={{ color: "#6B7280" }}>{postedLabel(n.created_at)}</p>
              </div>
              {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: "#3A3A3A" }} aria-label="Unread" />}
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
  const [upvotedIds, setUpvotedIds] = usePersistentState<Set<string>>("upvotedIds", new Set(), setSerializer);
  const [upvoteRows, setUpvoteRows] = useState<DbUpvote[]>([]); // shared upvotes (db mode)
  const [authorProfile, setAuthorProfile] = useState<{ id: string; name: string } | null>(null);
  const [profiles, setProfiles] = useState<Record<string, DbProfile>>({});
  // Whichever full-screen view (profile or post) was opened last sits on top.
  const [profileOnTop, setProfileOnTop] = useState(true);
  const [reposts, setReposts] = usePersistentState<Repost[]>("reposts", []);
  const [comments, setComments] = usePersistentState<Record<string, ItemComment[]>>("comments", {});
  const [verifications, setVerifications] = usePersistentState<Record<string, StudentVerification>>("verifications", {});
  const [challengeResponses, setChallengeResponses] = usePersistentState<ChallengeResponse[]>("challengeResponses", []);
  const [notifications, setNotifications] = usePersistentState<AppNotification[]>("notifications", []);
  const [repostingItem, setRepostingItem] = useState<Item | null>(null);
  const [challengeItem, setChallengeItem] = useState<Item | null>(null); // item whose challenge is being answered
  const [detailItem, setDetailItem] = useState<Item | null>(null); // full-screen post detail
  const [detailInitialAction, setDetailInitialAction] = useState(false); // open action form immediately
  useEffect(() => { if (detailItem) setProfileOnTop(false); }, [detailItem]);
  const [foundThisReportId, setFoundThisReportId] = useState<string | null>(null); // specific report to open (owner picking from list)
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  // Offline intake queue (Requirement 1.7–1.8): posts waiting to be sent.
  const [queuedItems, setQueuedItems] = useState<Item[]>(() => {
    try { return readQueue<Item>(localStorage); } catch { return []; }
  });
  const [syncFailures, setSyncFailures] = useState<string[]>([]); // titles the server rejected
  const offlineQueueCount = queuedItems.length;
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
    listItems().then(rows => { if (active) setItems(rows); });
    listComments().then(map => { if (active) setComments(map); });
    listReposts().then(rows => { if (active) setReposts(rows); });
    listChallengeResponses().then(rows => { if (active) setChallengeResponses(rows); });
    listVerifications().then(map => { if (active) setVerifications(map); });
    listNotifications().then(rows => { if (active) setNotifications(rows); });
    listClaims().then(rows => { if (active) setClaims(rows); });
    listUpvotes().then(rows => { if (active) setUpvoteRows(rows); });
    // Save my name + photo so others see it, then load everyone's.
    upsertProfile({ id: user.id, name: user.name, avatar_url: user.avatar_url })
      .then(() => listProfiles())
      .then(map => { if (active) setProfiles(map); });
    // Realtime subscriptions keep everyone in sync.
    const unsubItems = subscribeItems(rows => setItems(rows));
    const unsubComments = subscribeComments(map => setComments(map));
    const unsubReposts = subscribeReposts(rows => setReposts(rows));
    const unsubCR = subscribeChallengeResponses(rows => setChallengeResponses(rows));
    const unsubVer = subscribeVerifications(map => setVerifications(map));
    const unsubNotif = subscribeNotifications(rows => setNotifications(rows));
    const unsubClaims = subscribeClaims(rows => setClaims(rows));
    const unsubUpvotes = subscribeUpvotes(setUpvoteRows);
    return () => {
      active = false;
      unsubItems(); unsubComments(); unsubReposts(); unsubCR(); unsubVer(); unsubNotif();
      unsubClaims(); unsubUpvotes();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Replay queued offline posts on sign-in, reconnect, and background sync.
  useEffect(() => {
    if (!isDbEnabled || !user) return;
    replayOfflineQueue();
    const onOnline = () => { replayOfflineQueue(); };
    const onMessage = (e: MessageEvent) => { if (e.data?.type === "replay-queue") replayOfflineQueue(); };
    window.addEventListener("online", onOnline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
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

  // Upvotes: shared rows in db mode (one per user per post), a local Set otherwise.
  const myUpvotedIds = isDbEnabled
    ? new Set(upvoteRows.filter(r => r.user_id === user?.id).map(r => r.post_id))
    : upvotedIds;
  const othersUpvotes = (postId: string) =>
    upvoteRows.filter(r => r.post_id === postId && r.user_id !== user?.id).length;

  function handleUpvote(id: string) {
    if (isDbEnabled) {
      if (!user) return;
      const on = !myUpvotedIds.has(id);
      setUpvoteRows(prev => on
        ? [...prev, { post_id: id, user_id: user.id }]
        : prev.filter(r => !(r.post_id === id && r.user_id === user.id)));
      setUpvote(id, user.id, on).then(ok => { if (!ok) listUpvotes().then(setUpvoteRows); });
      return;
    }
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
    if (isDbEnabled) upsertVerification(record);
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
    if (isDbEnabled) upsertRepost(repost);
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

  function handleAddComment(itemId: string, message: string, visibility: "public" | "private" = "public") {
    if (!user || !message.trim()) return;
    const comment: ItemComment = {
      id: `cm${Date.now()}`,
      author_id: user.id,
      author_name: user.name,
      message: message.trim(),
      created_at: new Date().toISOString(),
      visibility,
      replies: [],
    };
    setComments(prev => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), comment] }));
    if (isDbEnabled) insertComment({
      id: comment.id, post_id: itemId, parent_id: null,
      author_id: comment.author_id, author_name: comment.author_name,
      message: comment.message, visibility, created_at: comment.created_at,
    });
  }

  function handleAddReply(itemId: string, parentId: string, message: string) {
    if (!user || !message.trim()) return;
    // A reply inherits the visibility of its top-level thread.
    const threadVisibility = (comments[itemId] ?? []).find(c => c.id === parentId || nodeContains(c, parentId))?.visibility ?? "public";
    const reply: CommentNode = {
      id: `rp${Date.now()}`,
      author_id: user.id,
      author_name: user.name,
      message: message.trim(),
      created_at: new Date().toISOString(),
      visibility: threadVisibility,
      replies: [],
    };
    setComments(prev => ({ ...prev, [itemId]: addReply(prev[itemId] ?? [], parentId, reply) }));
    if (isDbEnabled) insertComment({
      id: reply.id, post_id: itemId, parent_id: parentId,
      author_id: reply.author_id, author_name: reply.author_name,
      message: reply.message, visibility: threadVisibility, created_at: reply.created_at,
    });
  }

  // Claim rate limit (Requirement 6.5): owners claim via "Prove it's yours", so
  // count this user's found-post responses in the last 24h. Returns when the
  // oldest of those drops out of the window, or null when not blocked.
  const claimBlockedUntil = user ? computeClaimBlockedUntil(challengeResponses, user.id) : null;

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
    if (isDbEnabled) insertNotification(notif);
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
    setDetailInitialAction(true);
    setDetailItem(item);
  }

  function handleFoundThisClick(item: Item) {
    setDetailInitialAction(true);
    setDetailItem(item);
  }

  // ─── "I found this" on a lost post (Requirement 17) ────────────────────────
  // Finder authors questions (+ note); the lost post's owner must answer.
  function handleSubmitFoundReport(item: Item, questions: ChallengeQuestion[], note: string) {
    if (!user) return;
    const response: ChallengeResponse = {
      id: `cr${Date.now()}`,
      kind: "lost",
      item_id: item.id,
      // In the lost flow the reporter (the person who has the item) is both the
      // "responder" and the row's finder_id (NOT NULL in the DB). The lost post's
      // owner is owner_id — they read/answer the report.
      finder_id: user.id,
      responder_id: user.id,
      responder_name: user.name,
      owner_id: item.finder_id,
      // Questions become answer slots with empty `answer` for the owner to fill.
      answers: questions.filter(q => q.prompt.trim()).map(q => ({ question_id: q.id, prompt: q.prompt.trim(), answer: "" })),
      note: note.trim() || undefined,
      status: "awaiting_owner",
      created_at: new Date().toISOString(),
    };
    setChallengeResponses(prev => [response, ...prev]);
    if (isDbEnabled) insertChallengeResponse(response);
    pushNotification(item.finder_id, `${user.name} found your "${item.title}" — answer their questions to verify.`, item.id, response.id);
  }

  // Owner fills in the answers to a found report's questions (+ optional note back).
  function handleOwnerAnswer(responseId: string, answers: ChallengeAnswer[], ownerNote: string) {
    const note = ownerNote.trim() || undefined;
    setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, answers, owner_note: note, status: "answered" } : r));
    if (isDbEnabled) updateChallengeResponseAnswers(responseId, answers, "answered", note);
    const r = challengeResponses.find(x => x.id === responseId);
    if (r) pushNotification(r.responder_id, `The owner answered your questions on "${itemTitle(r.item_id)}". Review to confirm.`, r.item_id, r.id);
  }

  function itemTitle(itemId: string): string {
    return items.find(i => i.id === itemId)?.title ?? "an item";
  }

  function handleSubmitChallengeResponse(itemId: string, answers: ChallengeAnswer[], note: string) {
    if (!user || claimBlockedUntil) return;
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
      // A failed insert (e.g. the server's rate limit) drops the optimistic row.
      insertChallengeResponse({ ...response, finder_id: finderId })
        .then(ok => { if (!ok) setChallengeResponses(prev => prev.filter(r => r.id !== response.id)); });
    }
  }

  function handleChallengeDecision(responseId: string, decision: "approved" | "rejected") {
    setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, status: decision } : r));
    if (isDbEnabled) updateChallengeResponseStatus(responseId, decision);
    // On a lost-flow decision, notify the owner who answered.
    const r = challengeResponses.find(x => x.id === responseId);
    if (r?.kind === "lost" && r.owner_id) {
      pushNotification(r.owner_id, `Your answer on "${itemTitle(r.item_id)}" was ${decision === "approved" ? "approved" : "not approved"}.`, r.item_id, r.id);
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
    const claimId = `c${Date.now()}`;
    if (isDbEnabled) {
      // The finder isn't the claim owner, so the server creates the claim (RLS).
      setChallengeResponses(prev => prev.map(r => r.id === responseId ? { ...r, status: "escalated" } : r));
      escalateChallengeResponse(responseId, claimId);
      return;
    }
    const newClaim: Claim = {
      id: claimId,
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
  }

  function handleStatusChange(id: string, newStatus: ItemStatus) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i));
    if (isDbEnabled) updateItemStatus(id, newStatus);
  }

  function handleClaimAction(id: string, action: "approved" | "rejected") {
    const claim = claims.find(c => c.id === id);
    if (!claim) return;
    setClaims(prev => prev.map(c => c.id === id ? { ...c, status: action } : c));
    if (isDbEnabled) updateClaimStatus(id, action);
    if (action === "approved") handleStatusChange(claim.item_id, "approved_for_pickup");
  }

  function addClaimMessage(claimId: string, message: string, senderRole: "owner" | "staff") {
    if (!user) return;
    const msg: ClaimMessage = { id: `m${Date.now()}`, sender_id: user.id, sender_role: senderRole, message, created_at: new Date().toISOString() };
    setClaims(prev => prev.map(c => c.id !== claimId ? c : { ...c, messages: [...c.messages, msg] }));
    if (isDbEnabled) insertClaimMessage(claimId, msg);
  }

  function handleStaffReply(claimId: string, message: string) {
    addClaimMessage(claimId, message, "staff");
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
    if (!isDbEnabled) {
      setItems(prev => [newItem, ...prev]);
      return "posted";
    }
    if (!navigator.onLine) {
      queueOffline(newItem);
      return "queued";
    }
    // Optimistic insert; realtime will reconcile with the stored row.
    setItems(prev => [newItem, ...prev]);
    createItem(newItem).then(result => {
      if (result === "retry") queueOffline(newItem);
      if (result === "failed") {
        setItems(prev => prev.filter(i => i.id !== newItem.id));
        setSyncFailures(prev => [...prev, newItem.title]);
      }
    });
    return "posted";
  }

  // ─── Offline queue (Requirement 1.7–1.8) ────────────────────────────────────
  function queueOffline(item: Item) {
    setQueuedItems(enqueue(localStorage, item));
    // Chromium can wake the service worker when connectivity returns.
    navigator.serviceWorker?.ready
      .then(reg => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register("foundit-replay"))
      .catch(() => {});
  }

  const replaying = useRef(false);
  async function replayOfflineQueue() {
    if (!isDbEnabled || replaying.current || !navigator.onLine) return;
    replaying.current = true;
    try {
      const { failed, remaining } = await replayQueue<Item>(localStorage, createItem);
      setQueuedItems(remaining);
      if (failed.length) setSyncFailures(prev => [...prev, ...failed.map(i => i.title)]);
    } finally {
      replaying.current = false;
    }
  }

  // Queued offline posts show in the poster's views, marked "Waiting to sync".
  const queuedIds = new Set(queuedItems.map(q => q.id));
  const displayItems: Item[] = [
    ...queuedItems.filter(q => !items.some(i => i.id === q.id)).map(q => ({ ...q, pending_sync: true })),
    ...items.map(i => queuedIds.has(i.id) ? { ...i, pending_sync: true } : i),
  ];

  const repostCounts: Record<string, number> = {};
  for (const r of reposts) repostCounts[r.item_id] = (repostCounts[r.item_id] ?? 0) + 1;
  const myRepostItemIds = new Set(user ? reposts.filter(r => r.user_id === user.id).map(r => r.item_id) : []);

  // Auth gate: loader while restoring, sign-in screen when signed out.
  if (auth.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#FFFFFF" }}>
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
  const activeDetailItem = detailItem ? (displayItems.find(i => i.id === detailItem.id) ?? detailItem) : null;

  return (
    <VerifiedContext.Provider value={verifiedIds}>
    <OpenDetailContext.Provider value={setDetailItem}>
    <LostFlowContext.Provider value={{ currentUserId: user?.id ?? null, onFoundThis: handleFoundThisClick }}>
    <OpenAuthorContext.Provider value={(id, name) => { setAuthorProfile({ id, name }); setProfileOnTop(true); }}>
    <UpvoteOthersContext.Provider value={othersUpvotes}>
    <ProfilesContext.Provider value={{ ...profiles, [user.id]: { name: user.name, avatar_url: user.avatar_url } }}>
    <div className="min-h-screen" style={{ background: "#FFFFFF" }}>
      <Nav view={view} setView={setView} role={role} user={user} search={search} setSearch={setSearch} categoryFilter={categoryFilter} setCategoryFilter={setCategoryFilter} offlineQueueCount={offlineQueueCount} unreadCount={unreadCount} />
      {syncFailures.length > 0 && (
        <div className="text-xs font-medium px-4 py-2 flex items-center gap-2" style={{ background: "#F5ECEC", color: "#9A3F3F", borderBottom: "1px solid #C1856D" }}>
          <span className="flex-1">
            Couldn't post {syncFailures.map(t => `"${t}"`).join(", ")}. Please log {syncFailures.length === 1 ? "it" : "them"} again.
          </span>
          <button type="button" onClick={() => setSyncFailures([])} aria-label="Dismiss" style={{ color: "#9A3F3F" }}><IconX /></button>
        </div>
      )}
      <main className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
        {view === "catalog" && <CatalogView items={displayItems} role={role} user={user} search={search} categoryFilter={categoryFilter} onClearFilters={() => { setSearch(""); setCategoryFilter("All"); }} onClaim={handleClaimClick} onUpvote={handleUpvote} upvotedIds={myUpvotedIds} onRepost={setRepostingItem} repostCounts={repostCounts} myRepostItemIds={myRepostItemIds} reposts={reposts} onShare={handleShare} comments={comments} onAddComment={handleAddComment} onAddReply={handleAddReply} challengeResponseCounts={responseCounts} />}
        {view === "gallery" && <GalleryView items={displayItems} user={user} />}
        {view === "log" && <FinderForm onSubmit={handleFinderSubmit} user={user} />}
        {view === "profile" && <ProfileView user={user} items={displayItems} reposts={reposts} onRemoveRepost={handleRemoveRepost} onSignOut={handleSignOut} verification={myVerification} onSubmitVerification={handleSubmitVerification} verifiedIds={verifiedIds} />}
        {view === "staff" && <StaffDashboard items={items} claims={claims} allItems={items} onStatusChange={handleStatusChange} onClaimAction={handleClaimAction} onStaffReply={handleStaffReply} />}
        {view === "notifications" && (
          <NotificationsView
            notifications={myNotifications}
            onOpen={n => {
              const it = items.find(i => i.id === n.item_id);
              if (it) {
                // Always open the full-screen PostDetail; land on the ownership
                // panel when the notification is about a report.
                setDetailInitialAction(!!n.response_id);
                setDetailItem(it);
                // Also pre-select a specific report if the notification links to one.
                if (n.response_id) setFoundThisReportId(n.response_id);
              }
            }}
          />
        )}
      </main>

      <BottomNav
        view={view}
        canCreate={role !== "staff"}
        unreadCount={unreadCount}
        onFeed={() => setView("catalog")}
        onCommunity={() => setView("gallery")}
        onCreate={() => setView("log")}
        onAlerts={() => setView("notifications")}
        onProfile={() => setView("profile")}
      />

      {challengeItem && (
        <ChallengeModal
          item={challengeItem}
          onClose={() => setChallengeItem(null)}
          onSubmit={(answers, note) => handleSubmitChallengeResponse(challengeItem.id, answers, note)}
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
      {authorProfile && (
        <PublicProfileView
          authorId={authorProfile.id}
          authorName={authorProfile.name}
          items={displayItems}
          reposts={reposts}
          currentUserId={user.id}
          onBack={() => setAuthorProfile(null)}
          onTop={profileOnTop}
        />
      )}
      {activeDetailItem && (
        <PostDetail
          key={activeDetailItem.id}
          item={activeDetailItem}
          comments={comments[activeDetailItem.id] ?? []}
          currentUserId={user.id}
          onBack={() => { setDetailItem(null); setDetailInitialAction(false); setFoundThisReportId(null); }}
          initialReportId={foundThisReportId}
          onAddComment={(msg, visibility) => handleAddComment(activeDetailItem.id, msg, visibility)}
          onAddReply={(commentId, msg) => handleAddReply(activeDetailItem.id, commentId, msg)}
          onUpvote={handleUpvote}
          upvoted={myUpvotedIds.has(activeDetailItem.id)}
          onRepost={setRepostingItem}
          reposted={myRepostItemIds.has(activeDetailItem.id)}
          repostCount={repostCounts[activeDetailItem.id] ?? 0}
          onShare={handleShare}
          claimBlockedUntil={claimBlockedUntil}
          isStaff={role === "staff"}
          challengeResponses={challengeResponses.filter(r => r.item_id === activeDetailItem.id)}
          onSubmitChallengeResponse={(itemId, answers, note) => handleSubmitChallengeResponse(itemId, answers, note)}
          onSubmitFoundReport={handleSubmitFoundReport}
          onOwnerAnswer={handleOwnerAnswer}
          onApprove={id => handleChallengeDecision(id, "approved")}
          onReject={id => handleChallengeDecision(id, "rejected")}
          onEscalate={handleEscalateChallengeResponse}
          initialActionOpen={detailInitialAction}
        />
      )}
    </div>
    </ProfilesContext.Provider>
    </UpvoteOthersContext.Provider>
    </OpenAuthorContext.Provider>
    </LostFlowContext.Provider>
    </OpenDetailContext.Provider>
    </VerifiedContext.Provider>
  );
}
