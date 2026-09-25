# Design — Campus Lost & Found

## Overview

The product's user-facing brand name is **FoundIt** (shown in the header and
sign-in screen). "Campus Lost & Found" remains the internal project/spec title.

FoundIt is a React + Vite + Tailwind CSS v4 application. The current
build is a single-file, client-side prototype (`src/App.tsx`) driven by in-memory
mock data and React state. It demonstrates the full UX — finder intake, public
catalog, owner claims, private claim threads, staff dashboard, and passive
missing notices — with roles switched through a demo selector.

This document describes both:
- **Current design** — what is implemented today in the prototype.
- **Target backend design** — the Supabase architecture the prototype will be
  wired to in later phases (carried forward from the original SDD).

## Current architecture (implemented)

```
index.html
  └─ src/main.tsx            React entrypoint, imports index.css, mounts <App/>
       └─ src/App.tsx        entire app: types, mock data, components, state
            └─ src/index.css Tailwind v4 import + global styles
```

- **Framework:** React 19 + TypeScript, built with Vite 8.
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite`, plus inline `style`
  objects for the warm color palette. No Tailwind config file.
- **State:** all application state is held in the top-level `App` component with
  `useState`. There is no network, persistence, or backend yet.
- **Data:** the app starts with no seeded records. The initial item, claim, and
  missing-notice collections are empty; content appears only as the signed-in
  user creates it during the session. Application state is held in React
  `useState` and **persisted to `localStorage`** (Requirement 14) so it survives
  page reloads, until the Supabase data layer lands in Phase 3.

### Client-side persistence (Requirement 14)

A small `usePersistentState` hook wraps `useState`: it hydrates the initial value
from `localStorage` on first render (falling back to the default if the key is
absent or the JSON is malformed) and writes back via `useEffect` whenever the
value changes. Persisted slices — `items`, `claims`, `notices`, `comments`,
`reposts`, and `upvotedIds` — are stored under versioned keys prefixed
`foundit:v1:` so a later Supabase layer can supersede them cleanly. `upvotedIds`
is a `Set`, so it is (de)serialized via array form. Auth/session state is not
persisted here; it stays owned by `src/lib/auth.ts`.

### Component structure (`src/App.tsx`)

| Component | Responsibility |
|---|---|
| `App` | Owns all state (items, claims, notices, role, view, upvotes) and handlers; renders `Nav` + the active view; hosts the claim modal. |
| `Nav` | Sticky header: brand (→ catalog); search; right side (wide screens) a "+" create icon, a Gallery grid icon, the notifications bell, and the profile avatar; offline banner. No hamburger/sidebar. Search state is lifted to `App` and passed in. |
| `CatalogView` | Public catalog with search field + category filter; supports "Feed" (post list) and "Community" (photo-centric grid) view modes, and renders an empty state with filter clearing. |
| `ItemCard` | Reddit-style post: avatar + poster name + relative time + status icon, title, description, location, action row (upvote/comment/repost/share) and bottom-right claim action. |
| `PostDetail` | Full-screen post detail view hosting full post content, action row, inline `OwnershipActionSection` ("I found it" / "I lost it"), and recursive comment thread. |
| `OwnershipActionSection` | Adaptive inline section rendered between post and comments inside `PostDetail` for submitting/answering ownership challenges and found reports. |
| `PublicProfileView` | Public profile for any user displaying avatar, name, student verification badge, and list of public items. |
| `StatusBadge` | Renders the item status as an icon with an accessible label/tooltip. |
| `Avatar` | Deterministic colored initials avatar keyed on user id, clickable to open author profile. |
| `ClaimModal` | Owner submits identifying details for a claim. |
| `FinderForm` | "Log a Found/Lost Item": a **Found / Lost** mode toggle. Found mode creates a `pending_intake` item (photo, optional ownership challenge). Lost mode collects the same fields (title, category, location/time lost, description, optional staff note, optional photo) EXCEPT the ownership challenge, and creates a missing notice via `onPostNotice`; no drop-off/intake copy. |
| `MissingNotices` | Passive missing-item bulletin with a post form. |
| `StaffDashboard` | Pending-intake queue and claims-review queue with status controls and reply thread. |


### Data types (current)

```ts
type ItemStatus = "pending_intake" | "in_office" | "approved_for_pickup" | "released";
type ClaimStatus = "pending_review" | "approved" | "rejected";
type Role = "finder" | "owner" | "staff";

interface Item {
  id: string;
  kind: "found" | "lost"; // "lost" posts are owner-reported and appear in the catalog too
  finder_id: string;      // for lost posts this is the reporter (owner)
  title: string;
  category: string;
  location_found: string; // for lost posts, where it was lost
  time_found: string;     // for lost posts, when it was lost
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

interface ChallengeQuestion {
  id: string;
  prompt: string; // short-text question authored by the finder
}

interface ChallengeResponse {
  id: string;
  item_id: string;
  responder_id: string;
  responder_name: string;
  answers: { question_id: string; prompt: string; answer: string }[];
  note?: string; // optional note to the finder
  status: "pending" | "approved" | "rejected" | "escalated";
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
  title?: string;
  category?: string;
  description: string;
  location_lost: string;
  time_lost: string;
  note?: string;       // optional private note to staff
  image_url?: string;  // optional photo
  created_at: string;
}
```

### Key behaviors

- **Status state machine:** `handleStatusChange` mutates `items[].status`. Only
  the staff view exposes controls that call it. Approving a claim
  (`handleClaimAction`) moves the item to `approved_for_pickup`.
- **Catalog visibility:** `CatalogView` shows `in_office` /
  `approved_for_pickup` items to everyone, plus the current user's own
  `pending_intake` items (marked "Pending Intake") so a freshly logged item
  reflects immediately for its poster. This requires passing the current user id
  into `CatalogView`. Search and category filters apply after visibility.
- **Search:** matches the query (lowercased) against `title`, `description`, and
  `location_found`. The search icon doubles as a focus/clear control and uses
  `pointer-events` correctly so typing is never blocked.
- **Relative time:** `postedLabel` shows "just now" / "Nh ago" / "Nd ago" up to
  7 days, then falls back to the full formatted date.
- **Item card actions (upvote / repost / share / comment):**
  - **Upvote** is tracked in a `Set<string>` of item ids (`upvotedIds`) held in
    `App`; toggling adjusts the displayed count. Engagement signal only.
  - **Repost (Facebook-style)** is a first-class record, not just a toggle.
    Activating Repost opens a `RepostDialog` where the user adds an optional
    caption and confirms (or removes an existing repost). Reposts are stored as a
    `Repost[]` in `App`. A repost appears both on the user's **My Timeline** view
    and in the **catalog feed** as a "reposted" card that quotes the original
    item and shows the reposter's name/caption. The card's repost count reflects
    the number of reposts of that item. "Already reposted" is derived from whether
    the current user has a repost for the item. No effect on status.
  - **Share** copies a link to the item (`?item=<id>` on the app origin) to the
    clipboard via `navigator.clipboard`; on failure it surfaces the link text so
    it can be copied manually. A brief "Link copied" confirmation shows on the
    card.
  - **Comment** opens a **modal comment panel** (`CommentModal`) — a centered
    pop-up dialog over a dimmed backdrop, not an inline slide-down. The panel
    renders the **full post** at the top of its scrollable area (poster, status,
    title, description, photo if any, found location/time), then a scrollable
    **branching** comment tree, with a sticky composer at the bottom. It closes
    via a close button, backdrop click, or Escape.
  - **Branching replies:** comments and replies share one recursive node type
    (`CommentNode`, each with its own `replies: CommentNode[]`), so any node can
    be replied to at arbitrary depth. Nodes are stored per post id in a
    `Record<string, CommentNode[]>` map in `App`. A recursive `CommentThread`
    component renders each node with a per-node **Reply** input and progressively
    increasing indentation. Adding a reply walks the tree by parent id
    immutably and appends the new node to that parent's `replies`. The card's
    comment count reflects the base count plus the total node count across the
    whole tree. Empty threads show a first-comment prompt inside the panel. The
    card's comment button is a trigger only (it no longer expands content in
    place).
  - All of this is in-memory and resets on reload until the Supabase data layer
    lands.
  - **Generalized engagement (items + reposts):** upvotes, comments, and (share
    is stateless) are keyed by a generic **post id** rather than strictly an item
    id. An item's post id is its item id; a repost's post id is its repost id
    (`Repost.id`). This lets a reposted card carry its own upvote count and its
    own comment thread, independent of the original item. `upvotedIds` and the
    `comments` map are therefore keyed by post id. **Repost** on a reposted card
    always targets the underlying original item (so `myRepostItemIds` /
    `repostCounts` remain item-keyed).

### My Profile view

A new `View` value `"profile"` and nav item "Profile" (signed-in users).
`ProfileView` shows a header (avatar, name, email, sign-out) then the user's own
logged items (as item cards) and their reposts (as repost cards), newest first,
with an empty state when there are none.

```ts
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
```

### My Timeline view

A new `View` value `"timeline"` and nav item "My Timeline" (signed-in users).
`TimelineView` lists the current user's reposts newest-first: the user's caption
(if any) above a compact quoted card of the reposted item, with a control to
remove the repost. The catalog feed also renders reposts: each repost of a
visible item shows as a reposted card quoting the original.
- **Claims:** `handleClaimSubmit` appends a `pending_review` claim; owner and
  staff replies append to the claim's `messages` array.

### Visual/UX conventions (design system)

- **Identity:** a white page and surface background (`#FFFFFF`) with a warm
  accent family (sand `#E6CFA9`, terracotta `#C1856D`, rust `#9A3F3F`, ink
  `#2C1414`) exposed as CSS theme tokens in `index.css`. Text and icons on rust
  fills are white. One accent (rust); no competing accent colors. The app's
  home-screen icon keeps its original cream artwork.
- **Black:** every "black" (text, primary buttons, tags, dots) is one soft
  black, `#3A3A3A`, not pure or near-pure black; secondary text is grey
  (`#6B7280`).
- **Typography:** all body and UI text uses the device's **system font**
  (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial,
  sans-serif` — SF Pro on Apple devices, Segoe UI on Windows, Roboto on
  Android), like Reddit; nothing is downloaded. The "Foundit" wordmark keeps
  **Momo Trust Display**. Headings use tight leading.
  Numeric counts use `font-variant-numeric: tabular-nums` so they don't jitter.
- **Surfaces:** cards use sand backgrounds with terracotta hairline borders and
  soft, warm-tinted shadows (not pure-black). Rounded corners vary by nesting
  (softer on containers, tighter on inner controls).
- **Interaction states:** all interactive elements have hover (subtle background
  shift), active/pressed (`translateY(1px)` / slight scale), and a visible
  `:focus-visible` ring in rust for keyboard users. Transitions are 150–200ms on
  color/transform/opacity only (GPU-friendly).
- **Item cards** mimic a social post layout, but there is intentionally no way to
  contact a finder directly.
- **Status** is communicated with an icon (with tooltip), not a text label, on
  cards.
- Accessibility: focus rings are never removed without a visible replacement;
  icon-only controls carry `aria-label`/`title`.

## Authentication design — Google sign-in (Requirement 10)

Authentication gates the entire app: an unauthenticated visitor sees only the
public **landing page** (Requirement 10a) and, from its call to action, the
**sign-in screen**. All app views (catalog, finder form, claims, staff) render
only once a session exists.

### Signed-out routing (landing → login)

While signed out, `App` tracks a small local `authView` state:
`"landing" | "login"`. It defaults to `"landing"`. The landing page's primary CTA
sets it to `"login"` (renders `<SignIn/>`); the sign-in screen has a back control
that returns to `"landing"`. This is client-only view state (no URL routing yet)
and resets to `"landing"` whenever the user is signed out. The `<LandingPage/>`
is a new presentational component: brand wordmark, tagline, a compact
"how it works" summary (log → verify → claim → release), and the CTA. Neither the
landing page nor the sign-in screen exposes authenticated data.

### Approach

Use **Supabase Auth with the Google OAuth provider**. This keeps auth aligned
with the target backend (the same JWT drives Row-Level Security later) and avoids
hand-rolling an OAuth exchange. Supabase's `signInWithOAuth({ provider: "google" })`
handles the redirect flow; the session is persisted by the Supabase client and
restored on reload.

Rationale: the prototype is already destined for Supabase (see target backend
design below), so using Supabase Auth now means the session and user id we build
against are the same ones RLS will trust in Phase 3 — no throwaway auth layer.

### Configuration prerequisites (out of band, not code)

- A Google Cloud OAuth 2.0 Client ID (Web application) with the app origin and
  the Supabase callback URL registered as authorized redirect URIs.
- The Google client id/secret set on the Supabase project's Google auth provider.
- These secrets live in Supabase project settings and environment config, never
  committed to the repo.

### Auth model in the app

```ts
interface AuthUser {
  id: string;            // Supabase user id (stable account key)
  name: string;          // Google display name
  email: string;
  avatar_url?: string;   // Google profile picture
  role: Role;            // derived from account; defaults to non-staff
}

type AuthState =
  | { status: "loading" }               // restoring session on load
  | { status: "signed_out" }            // show sign-in screen
  | { status: "signed_in"; user: AuthUser };
```

- **Session restore:** on mount, read the current Supabase session; while
  resolving, render a loading state (not the sign-in screen) to avoid a flash.
- **Sign in:** the sign-in screen offers a single "Continue with Google" button
  that calls the OAuth flow. On the return redirect, Supabase completes the
  session and the app transitions to `signed_in`.
- **Sign out:** clears the Supabase session and returns to `signed_out`.
- **Role derivation:** role comes from the account (a `staff_members` lookup /
  JWT claim in the backend phase). Until staff assignment exists, every
  authenticated account is a standard finder/owner user. This **replaces** the
  demo role selector in `Nav` (Requirement 11 is retired at that point).
- **Record ownership:** `finder_id` on items and `owner_id` on claims are set
  from `AuthUser.id` instead of the current hardcoded `"u1"` / `"u_current"`.
- **Error handling:** a failed or cancelled OAuth flow returns to the sign-in
  screen with a friendly message and no session.

### Component impact

| Component | Change |
|---|---|
| `App` | Add auth state and a signed-out `authView` (`"landing" \| "login"`); render `<LandingPage/>` or `<SignIn/>` when signed out, a loader while loading, and the current app only when signed in. Pass `AuthUser` down. |
| `LandingPage` (new) | Public marketing/intro screen: brand wordmark, tagline, "how it works" summary, and a "Get started" CTA that opens the sign-in screen. |
| `SignIn` (new) | Branded sign-in screen with the "Continue with Google" button, error display, and a back control to the landing page. |
| `Nav` | Replace the demo role selector with the signed-in user's avatar/name and a "Sign out" action. |
| `ClaimModal` / claim handlers | Use `AuthUser.id` and `AuthUser.name` instead of hardcoded owner values. |
| `FinderForm` handler | Set `finder_id` from `AuthUser.id`. |
| new `src/lib/auth.ts` | Thin wrapper over the Supabase client: `getSession`, `signInWithGoogle`, `signOut`, and an `onAuthChange` subscription. |

### Concrete integration

- **Dependency:** `@supabase/supabase-js`.
- **Client:** `src/lib/supabase.ts` creates the client from environment
  variables and exports it, or exports `null` when the variables are absent.
  - `VITE_SUPABASE_URL` — e.g. `https://<project-ref>.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` — the public anon key (safe in client code)
  - These live in a gitignored `.env`. The anon key is publishable; the Google
    client secret is NOT in the app — it lives only in the Supabase dashboard.
- **`src/lib/auth.ts`** depends on `supabase.ts`:
  - `signInWithGoogle()` → `supabase.auth.signInWithOAuth({ provider: "google",
    options: { redirectTo: window.location.origin } })`, which redirects to
    Google and back to the app origin.
  - On return, the Supabase client parses the callback and establishes the
    session; `getSession()` reads `supabase.auth.getSession()`.
  - `onAuthChange()` subscribes to `supabase.auth.onAuthStateChange` and maps the
    session's user (`user_metadata.full_name`, `email`, `user_metadata.avatar_url`)
    into `AuthUser`.
  - `signOut()` → `supabase.auth.signOut()`.
  - **Role derivation:** until a `staff_members` roster exists, every
    authenticated account maps to a non-staff (`owner`) role. Staff mapping is
    added in Phase 3 with RLS.

### Mock fallback (no configuration present)

If `supabase.ts` exports `null` (env vars unset), `auth.ts` falls back to the
interim mock that simulates a Google user and persists to localStorage. This
keeps the app runnable in environments without Supabase configured, and means
enabling real auth is purely a matter of providing the two env vars — no code
change.

### Google provider prerequisites (done in dashboards, not code)

- Google Cloud OAuth 2.0 Web client with authorized redirect URI
  `https://<project-ref>.supabase.co/auth/v1/callback` and the app origin as an
  authorized JavaScript origin.
- Supabase → Authentication → Providers → Google enabled with that client's
  ID and secret.

## AI caption import design (Requirement 12)

Lets a finder paste a post caption and auto-fill the Log Found Item form. The
content comes from the user (paste), which sidesteps scraping/CORS/login-wall
issues with sites like Facebook — we never fetch the post ourselves.

### Provider and placement

- **Model:** Google Gemini via rolling `-latest` aliases (`gemini-flash-latest`,
  falling back to `gemini-flash-lite-latest`) — free tier, fast, reliable JSON
  output. Rolling aliases are used deliberately so retired pinned versions don't
  break the function; the Edge Function also falls through to the next alias on
  404/503/429.
- **Key safety:** the `GEMINI_API_KEY` is held only by a backend function, never
  in the client bundle. The call runs in a **Supabase Edge Function**
  (`supabase/functions/parse-caption`), matching the existing Supabase stack.

### Flow

1. User pastes caption text into a "Paste a post caption" textarea on
   `FinderForm` and clicks "Fill from caption".
2. Client helper `src/lib/captionImport.ts` → `parseCaption(text)`:
   - If a Supabase client is configured, invoke the `parse-caption` Edge
     Function (`supabase.functions.invoke`).
   - Otherwise (or on error), fall back to a local heuristic parser so the
     feature still fills what it can with no backend.
3. The function/parser returns `{ title, category, location_found, description }`
   (any field may be empty). Category is constrained to the app's `CATEGORIES`.
4. `FinderForm` merges non-empty fields into its form state; all fields stay
   editable. Nothing auto-submits.
5. If the "When did you find it?" (`time_found`) field is still empty after the
   merge, `FinderForm` defaults it to now (current date/time, formatted for the
   `datetime-local` input). The parser does not infer a time; the default is
   applied in the UI layer and remains editable. This keeps the required field
   pre-filled so a pasted caption without a time still yields a submittable form.

### Edge Function contract (`parse-caption`)

- **Input (POST JSON):** `{ caption: string }`.
- **Behavior:** prompts Gemini to return STRICT JSON with keys `title`,
  `category`, `location_found`, `description`; `category` must be one of the
  app's categories or empty. The function validates/normalizes the model output
  and clamps `category` to the known list.
- **Output JSON:** `{ title, category, location_found, description }`.
- **Secret:** `GEMINI_API_KEY` set via `supabase secrets set`.
- **CORS:** returns permissive CORS headers so the browser client can call it.

### Local heuristic fallback

`captionImport.ts` includes a dependency-free parser that:
- Uses the first non-empty line (trimmed, length-capped) as the title.
- Scans for a category keyword against `CATEGORIES` synonyms.
- Extracts a location from lines/phrases after cues like "at", "near", "found
  in", "location:".
- Uses the full caption as the description.
This runs when Supabase/the function is not available and keeps the UX working
offline; real Gemini output supersedes it once deployed.

### Client type

```ts
interface ParsedCaption {
  title: string;
  category: string;       // one of CATEGORIES (excluding "All") or ""
  location_found: string;
  description: string;
}
```

## Student verification design (Requirement 15)

AI-assisted, staff-fallback verification that a user is a real student, surfaced
as a "Verified student" badge. Mirrors the caption-import architecture: a Gemini
call runs in a Supabase Edge Function (`verify-student`) that holds the key, with
a dependency-free local fallback so the app still runs without a backend.

### Flow

1. In **Profile**, an `unverified`/`rejected` user picks a document type
   (Student ID / COR / Class schedule) and selects an image, then submits.
2. Client helper `src/lib/studentVerify.ts` → `verifyStudent({ imageBase64,
   accountName, docType })`:
   - If Supabase is configured, invoke the `verify-student` Edge Function
     (multimodal Gemini Vision), which returns structured fields + confidence.
   - Otherwise, a local fallback returns a non-committal result that never
     auto-verifies and routes to staff.
3. Decision (fully automated, no staff step):
   - `pass` + high confidence + name consistent with the account → `verified`.
   - Otherwise → `rejected`; the user can retry with a clearer document.
   - If the AI service is unavailable → surface "temporarily unavailable"; do
     not verify.

### Edge Function contract (`verify-student`)

- **Input (POST JSON):** `{ imageBase64, mimeType, accountName, docType }`.
- **Behavior:** prompts Gemini Vision to return STRICT JSON:
  `{ is_student_doc, doc_type, name, student_no, school, term_valid,
  name_matches_account, confidence, verdict }`. The function normalizes output
  and clamps `confidence` to `0..1`.
- **Decision returned to client:** `verified` only when `verdict === "pass"`,
  `confidence >= 0.75`, `is_student_doc`, and `name_matches_account`; else
  `rejected` (AI-only, no staff queue).
- **Secret:** `GEMINI_API_KEY` (same secret as `parse-caption`).
- **CORS:** permissive headers like `parse-caption`.

### AI limits (documented, by design)

AI reads what is on the image; it does not authenticate the document against the
registrar and can be fooled by tampering. The badge means "student, best-effort
verified," not "identity legally confirmed." Item **release** remains gated by
in-person staff custody checks, so a mis-verified badge is low-risk. No
facial/biometric matching is performed.

### Data model & privacy

App-owned (not part of `AuthUser`, which comes from Google). Verification state is
keyed by user id and persisted via `usePersistentState` (`foundit:v1:verifications`).
The **raw image is never persisted** — only the decision, extracted fields, and
confidence.

```ts
type VerificationStatus = "unverified" | "verified" | "rejected"; // AI-only, no "pending"

interface StudentVerification {
  user_id: string;
  user_name: string;
  status: VerificationStatus;
  doc_type?: "student_id" | "cor" | "class_schedule";
  extracted?: { name?: string; student_no?: string; school?: string; term_valid?: boolean };
  confidence?: number;      // 0..1
  ai_verdict?: "pass" | "fail";
  submitted_at?: string;
  decided_at?: string;
  decided_by?: "ai" | "staff";
}
```

### Component / handler changes

| Component | Change |
|---|---|
| `App` | Add `verifications` persistent state (`Record<userId, StudentVerification>`); a submit handler that applies the AI decision directly; derive current user's status and `verifiedIds`. |
| `VerificationBadge` (new) | Small check + "Verified student" label; shown next to names on posts, comments, and profile. |
| `ProfileView` | Verification section: status + submit form (doc type + image); verified/rejected states (no pending). |
| new `src/lib/studentVerify.ts` | `verifyStudent(...)` → Edge Function when configured; when unavailable, reports unavailable (no fallback approval). |
| new `supabase/functions/verify-student` | Gemini Vision review; returns structured verdict; holds the key. |

## Ownership Challenge design (Requirement 16)

Lets a finder attach verification questions to a found item; a claimant answers
them via **"Prove it's yours"**; the finder reviews responses on their own post
and decides, or escalates to staff. The finder is the primary decider, with an
explicit escalation path into the existing staff claim flow.

### Flow

1. **Author (FinderForm):** an optional "Ownership challenge" section lets the
   finder add/remove short-text questions. Saved as `item.challenge:
   ChallengeQuestion[]` (omitted/empty ⇒ no challenge).
2. **Answer (item card → "Prove it's yours"):** when `item.challenge` is
   non-empty, the item's claim action is labeled "Prove it's yours" and opens a
   `ChallengeModal` rendering one short-text input per question plus an optional
   **note to the finder**. Submitting creates a `ChallengeResponse` (status
   `pending`). When there is no challenge, the existing free-text `ClaimModal`
   (Requirement 6) is used unchanged.
3. **Review (Profile → Your posts):** the finder's own item cards show a
   **Responses** control opening a `ChallengeResponsesModal`: each responder
   (name + verified badge), their answer per question, their note, and the
   response count. Per response the finder can **Approve**, **Reject**, or
   **Send to staff**.
4. **Decide / escalate:** Approve → response `approved` (finder's decision;
   physical release still happens at the office, so no status auto-change).
   Reject → `rejected`. Send to staff → response `escalated` AND a `Claim`
   (Requirement 6) is created from the response's answers (joined into
   `identifying_details`) with status `pending_review`, entering the normal staff
   review thread.

### Data & visibility

`ChallengeResponse[]` is app state persisted via `usePersistentState`
(`foundit:v1:challengeResponses`). Responses are shown only to the item's finder
(and staff via an escalated claim) — never to other users, since answers can
reveal identifying info and a public list could be gamed.

### Component / handler changes

| Component | Change |
|---|---|
| `FinderForm` | Optional "Ownership challenge" question builder (add/remove short-text prompts); include `challenge` on the submitted item. |
| `PostActions` / item card | If `item.challenge?.length`, show "Prove it's yours" → `ChallengeModal`; else existing claim action. |
| `ChallengeModal` (new) | Renders the finder's questions as short-text inputs + optional note; submits a `ChallengeResponse`. |
| `ChallengeResponsesModal` (new) | Finder-only responses/analytics for their item; Approve / Reject / Send to staff per response. |
| `ProfileView` | "Responses (N)" control on the finder's own posts opens `ChallengeResponsesModal`. |
| `App` | `challengeResponses` state + handlers: submit response, finder approve/reject, escalate-to-staff (creates a `Claim`). |

## Target backend design (future phases)

The prototype is intended to be backed by Supabase. This section is the target
and is **not yet implemented**.

- **Backend:** Supabase — Postgres (schema + RLS + triggers), Auth (JWT with a
  `role`/`staff` claim), Storage (item photos), Edge Functions (claim rate
  limiting).
- **Offline:** Dexie.js over IndexedDB for cached reads; Workbox +
  background-sync for queued, replayed mutations; installable PWA.
- **Authorization:** Row-Level Security is the real security boundary because
  PostgREST exposes the database directly; app-layer checks are UX only.
- **Photo privacy:** Canvas re-encode to WebP strips EXIF/GPS structurally before
  upload; no server-side EXIF processing exists by design.
- **Audit:** triggers on `items` and `claims` write who/when/old→new into an
  `audit_logs` table.
- **Rate limiting:** an Edge Function in front of claim inserts enforces max 3
  claims per rolling 24h per authenticated user.

The full SQL schema, RLS policies, indexing strategy, upvote-concurrency trigger,
audit trigger, EXIF pipeline, and PWA caching configuration are documented in
`src/imports/pasted_text/campus-lost-found-sdd.md` and should be treated as the
authoritative reference when wiring the backend.

## Migration path (prototype → backend)

1. Extract the inline types into a shared module and align them with the SQL
   schema (add `missing_notices.image_url`, split `owner_name` out of `Claim`).
2. Replace mock arrays and `useState` handlers with Supabase client calls behind
   a small data-access layer, one view at a time (catalog first).
3. Introduce Google sign-in (Requirement 10) and derive `Role` from the
   authenticated account instead of the demo selector — see "Authentication
   design — Google sign-in" above.
4. Implement the real EXIF-strip pipeline to replace the simulated one in
   `FinderForm`.
5. Add the PWA/offline layer last, over a working online app.

## Phase 3 (in progress) — shared Supabase data so all users see each other's posts

To make posts visible across users (not just within one browser's
`localStorage`), application data moves into shared Supabase Postgres, read/written
through a data-access layer with realtime sync. This is done **incrementally,
one slice at a time**, starting with `items` (the catalog) to prove cross-user
sharing, then claims, notices, comments, reposts, challenge responses, and
verifications.

### Data-access layer (`src/lib/db.ts`)

- Thin functions per slice: e.g. `listItems()`, `createItem()`,
  `subscribeItems(cb)` (Supabase Realtime). They map DB rows ⇄ the app's inline
  types.
- **Fallback:** when Supabase is not configured (`isSupabaseConfigured` false),
  the app keeps its existing `usePersistentState` localStorage behavior so local
  dev without env vars still works. When configured, the db layer is the source
  of truth and localStorage is bypassed for migrated slices.

### `items` table (first slice)

```sql
create table public.items (
  id uuid primary key default gen_random_uuid(),
  finder_id uuid not null references auth.users(id),
  finder_name text,
  title text not null,
  category text not null,
  location_found text not null,
  time_found timestamptz,
  description text not null,
  private_note text,
  status text not null default 'pending_intake'
    check (status in ('pending_intake','in_office','approved_for_pickup','released')),
  image_url text,
  upvotes int not null default 0,
  challenge jsonb,           -- ChallengeQuestion[] or null
  created_at timestamptz not null default now()
);
alter table public.items enable row level security;
```

RLS (matches Requirement 3 visibility):
- **select**: any authenticated user may read items that are `in_office` or
  `approved_for_pickup`; a finder may also read their own `pending_intake` items.
- **insert**: an authenticated user may insert an item where `finder_id = auth.uid()`.
- **update**: (later slice) restricted to the finder / staff; not needed for the
  first read/write slice.
- `private_note` is not exposed publicly by app queries; column-level hardening
  and staff-only exposure land with the claims/staff slice.

### App rewiring (items)

`App` replaces `usePersistentState("items", …)` with: load via `listItems()` on
mount, subscribe via `subscribeItems` for realtime inserts/updates, and write via
`createItem()` in `handleFinderSubmit`. Other slices remain on `localStorage`
until their own migration lands.

### Phase 3.3 — staff roster, shared claims, upvotes, rate limit, audit (migration `0005_staff_claims_audit.sql`)

**Staff roster (Requirement 10.9).** `public.staff (email text primary key)` is
edited only from the SQL editor (no insert/update policy for app users).
`public.is_staff()` is a `security definer` SQL function that returns true when
the JWT email (`auth.jwt() ->> 'email'`) is in the roster. `auth.ts` calls
`supabase.rpc("is_staff")` after mapping the user and sets `role: "staff"` when
it returns true; any RPC error means non-staff. In mock mode, `deriveRole`
checks `VITE_STAFF_EMAILS`. RLS is the real boundary; the client role only picks
which views are shown.

**Items (Requirement 2.6, 8).** New `items_update_staff` policy lets staff update
any item. `db.updateItemStatus(id, status)` is called from `handleStatusChange`
so staff status changes reach every user. `items_select` also lets staff read
`released` items.

**Claims (Requirements 6, 7, 8).**

```sql
claims (id text pk, item_id text, owner_id text, owner_name text,
        identifying_details text, status text check in
        ('pending_review','approved','rejected'), created_at timestamptz)
claim_messages (id text pk, claim_id text references claims on delete cascade,
                sender_id text, sender_role text check in ('owner','staff'),
                message text, created_at timestamptz)
```

RLS: the owner and staff read a claim; the owner inserts their own claim with
status `pending_review`; only staff update a claim's status. Messages are
readable by the claim owner and staff; a sender inserts only as themselves, and
`sender_role = 'staff'` requires `is_staff()`. `db.ts` adds `listClaims`
(claims with their messages nested, oldest message first), `createClaim`,
`updateClaimStatus`, `insertClaimMessage`, and `subscribeClaims` (realtime on
both tables). `App` loads and subscribes to claims like the other slices. When
the finder escalates a challenge response, the finder is not the claim owner, so
the claim is inserted by the finder through `escalate_challenge_response(id)`,
a `security definer` function that checks the caller is that response's finder.

**Claim rate limit (Requirement 6.5).** The design called for an Edge Function;
`before insert` triggers are simpler and cannot be bypassed through PostgREST,
so they replace it. Owners claim through "Prove it's yours", so the trigger on
`challenge_responses` raises `claim_rate_limited` when the responder already has
3 `kind = 'found'` responses with `created_at > now() - interval '24 hours'`.
A second trigger on `claims` applies the same limit to any direct claim insert
and skips escalated claims (created by `escalate_challenge_response`), since the
claimant did not start them. Both triggers overwrite `created_at` with `now()` so
a client can't backdate rows. The client runs the same check first
(`claimBlockedUntil`) and shows "You can claim again after <time>" in the
post-detail claim form instead of submitting. `ClaimModal` is removed; it was
unreachable after Requirement 16.

**Upvotes (Requirement 5.3a).** `upvotes (post_id text, user_id text, pk both)`.
Anyone signed in can read; users insert/delete only their own rows. `App`
derives `upvotedIds` (mine) and `upvoteCounts` (everyone) from the rows. An
`UpvoteCountsContext` gives `PostActions` the number of *other* users' upvotes
for a post, so the displayed count is `base + others + (mine ? 1 : 0)`.
`item.upvotes` stays 0 for db-backed items.

**Audit trail (Future 4).** `audit_logs (id bigserial, table_name, row_id,
action, actor_id, old_row jsonb, new_row jsonb, created_at)`. An
`after insert or update or delete` trigger on `items` and `claims` writes one
row per change with `auth.uid()` as the actor. Only staff may read it; nobody
writes to it directly (the trigger function is `security definer`). No UI in
this phase.

### Post detail wiring (Requirements 5.19, 5.19a, 17.8)

`PostDetail` keeps `panel: "comments" | "action"` (replacing the old
`showClaimForm` boolean), starting at `"action"` when `initialActionOpen`. The
"N comments" label is a button that sets `"comments"`; the icon-only
`IconDocument` button toggles between `"action"` and `"comments"`. The comment
thread renders only in `"comments"`. In `"action"`, the panel is the inline
form when the user can start a claim/report, otherwise `OwnershipActionSection`
(status/review of an existing flow). `OwnershipActionSection` is no longer
rendered above the row. Opening a notification that references a report sets
`detailInitialAction` so the detail opens on the ownership panel.
For a lost post, the `"action"` panel's form has a `builderOpen` flag: false
shows the "Create verification form" button; true shows the builder
(`reportQuestions` list rendered as text + pen + disabled preview inputs, a
"+ Add question" link, the note, and Send/Cancel). Opening the builder seeds
one sample question; "+ Add question" appends an empty question and puts it in
edit mode (`editingQuestionId`), and committing it empty removes it. Cancel
resets the questions and the note.
The question list, pen edit-in-place, and "+ Add question" live in a shared
`QuestionBuilder` component (props: `questions`, `onChange`). Edits update the
parent's list on every keystroke; Escape (or saving empty) restores the
previous text, or removes a just-added question. `PostDetail` (lost-post found
report) and `FinderForm` (found-item ownership challenge) both render it inside
the same white, sand-bordered card; parents send only non-empty prompts.

On a found post's poster side, `OwnershipActionSection` shows the claims the
same way (cards → one opened claim with `SubmittedAnswers` and Approve /
Reject / Send to staff for `pending`), reusing `openReportId`. This replaces
the Profile "Responses" button and the `ChallengeResponsesModal`,
`LostResponsesModal`, and `LostFlowModal` pop-ups, which are removed.

On the owner's side, `OwnershipActionSection`'s lost-post branch keeps
`openReportId`: null renders the reports as rectangular cards (buttons);
set renders that report's form (questions as text + answer inputs, or
read-only `SubmittedAnswers` once answered) with a "← All forms" back link.
`needsAction` (owner with an `awaiting_owner` report, or reporter whose report
is `answered`) draws a dot on the icon and makes `"action"` the initial panel
(Requirement 5.19b).

`App` passes the upvote, repost, and share handlers into `PostDetail`. The
detail's "I lost it" / "I found it" button opens the inline form (it no longer
calls back into `App`). `OwnershipActionSection` is rendered between the post
and the comments only when the user already has a flow on this post (their own
response/report, or reports on their own lost post), so review and answering
happen inline and notifications land somewhere useful. Otherwise the plain
inline form is used; for a lost post it now includes the finder's question
builder (Requirement 17.2).

### Photo pipeline (Requirement 1.4)

`src/lib/image.ts` exports `reencodeImage(file, maxSide = 1600)`. It decodes the
file with `createImageBitmap` (falling back to an `<img>` element), draws it to a
canvas scaled so the longest side is at most `maxSide`, and exports with
`canvas.toDataURL("image/webp", 0.85)`, using JPEG when the browser returns a
PNG (no WebP encoder). Canvas output has no EXIF block, so GPS and camera data
are dropped. `FinderForm` shows its existing processing state while this runs
and stores only the returned data URL. A decode failure shows "That file isn't
an image we can read."

### Profiles and profile photos (Requirement 5c.3a) — migration `0007_profiles.sql`

`public.profiles (id text pk, name text, avatar_url text, updated_at)`. RLS:
any signed-in user can read; a user can insert/update only their own row
(`id = auth.uid()::text`). On sign-in `App` upserts the current user's name and
Google `avatar_url` (`db.upsertProfile`) and loads all rows (`db.listProfiles`)
into `profiles` state, provided through `ProfilesContext` (the current user is
always included from the auth session, which also covers mock mode). `Avatar`
reads the context and renders the photo (`<img>`, `object-cover`) when known,
falling back to the initials disc if there is none or it fails to load.

### Public author profile (Requirement 5c)

`App` holds `authorProfile: { id, name } | null` and provides it through
`OpenAuthorContext`. Avatars and names on `ItemCard`, `PostDetail`, `RepostCard`,
and `CommentThread` call `openAuthor(id, name)` (with `stopPropagation` so the
card doesn't also open). `PublicProfileView` renders as a full-screen overlay
like `PostDetail`: Back control, avatar, name, verified badge, public post count,
and the author's public items newest first (same visibility rules as the
catalog). Opening an item from it opens `PostDetail` above it, and Back returns
to the profile, so the user keeps their place. Opening your own avatar shows the
same public view.

### Post-style composer (Requirement 1.0a)

`FinderForm` renders one form for both modes, laid out like `ItemCard`: header
row (`Avatar` + name + "just now" + a Found/Lost tag button that flips `mode`),
a `CaptionEditor` (one `caption` string rendered as two seamless borderless
auto-growing textareas: a bold first line that refuses newlines — Enter moves
focus to the body, pasted newlines split into it — and a normal-weight body
where Backspace at position 0 merges back into the first line; placeholder
"What did you find?" / "What did you lose?"), a category
`<select>` styled as a chip, a 📍 location row as a borderless input (no time
field; `time_found` is set to the posting time on submit), and a full-width photo area that becomes the image preview.
Below the card: `CreateFormCard`/`QuestionBuilder` (Found only), the private
note, and a full-width Post button. Found and Lost share one field state
(`caption`, `category`, `location`, `time`, `note`); submit maps it to the
found or lost item exactly as before. Needs the signed-in user, so `App`
passes `user` to `FinderForm`.

### Campus location suggestions (Requirement 1.1b)

`src/lib/campusPlaces.ts` exports `CAMPUS_PLACES` (the 50 legend entries of the
PUP vicinity map, in map order) and a pure `matchPlaces(query, limit)` filter
(case-insensitive substring; names starting with the query rank first; empty
query returns the list in map order). The composer's 📍 row is a
`LocationCombobox`: a borderless input with a suggestion list below it
(`role="listbox"`, `aria-activedescendant` for keyboard highlight). Free text
is always kept.

### Caption-only log form (Requirement 1.1a)

`FinderForm` keeps a single `caption` string per mode instead of `title` and
`description`. `splitCaption(text)` (in `src/lib/captionHeuristic.ts`) returns
`{ title, description }`: the first non-empty line (trimmed) and the remaining
lines joined and trimmed. `joinCaption(title, description)` builds the caption
back from the caption-import result, dropping a leading copy of the title from
the description so it isn't repeated. The `Item` shape and database are
unchanged: posts still store `title` and `description`.

### Mobile bottom tab bar (Requirement 11a.9)

`BottomNav` renders under `md` (768px) as a fixed bar at the bottom: white
background, a 1px sand top border, no blur, gradient, or glow.
Five equal columns; the middle holds a flat 56×36px rectangular button (8px
corner radius) filled soft black (`#3A3A3A`) with a white "+", sitting inline in the
bar (not raised, no ring, no shadow); it darkens slightly while on the Log
form. Tabs are a 24px icon only
(the tab name is its `aria-label`): Feed = house, Community = 3×3 tile grid,
Alerts = bell, Profile = person in a circle. Active tab: soft-black icon and
label, and the house, bell, and profile head fill in; inactive: grey `#6B7280`.
The bar's top edge is `#E5E5E5`.

### Form-card style (verification forms, reports, claims, caption pop-up)

All cards built on the verification-form template share one neutral look: no
outline, a light grey fill (`#F7F7F8`), soft black (`#3A3A3A`) headings/questions/
names, grey (`#6B7280`) secondary text and status chips (`#ECECEE` fill), white
inputs with a light grey edge (`#E5E5E5`), a black primary button, and
grey-edged secondary buttons. The "Create verification form" entry card uses a
dashed grey edge. The accent red is not used inside these cards.

### Icon style

All UI icons are drawn in-house on a 24×24 grid in an Instagram-style
line language: 2px stroke, round caps and joins, generous corner radii, simple
geometric shapes (search = circle + handle, comment = round speech bubble with a
tail at bottom-right, share = paper plane, repost = two looping arrows, upvote
= rounded triangle, camera, two-people, sparkles for AI). Filled variants mark
active states. They are original drawings in that style, not copies of a
third-party icon kit's files. Press feedback is a 0.96 scale on the "+"
(skipped under `prefers-reduced-motion`). The bar pads by
`env(safe-area-inset-bottom)`, and `<main>` gets matching bottom padding on
narrow screens.

Community opens `view = "gallery"` (the same `GalleryView` the header's Gallery
icon opens), so the photo grid never depends on screen width; `CatalogView` has
no layout mode. Feed is active when `view === "catalog"`, Community when
`view === "gallery"`. In `Nav`,
the "+", bell, and avatar get `hidden md:inline-flex`. Staff (`canCreate`
false) get a four-tab bar without the "+".

### Catalog Feed / Community toggle (Requirement 3.9)

`CatalogView` takes the layout from `App` (no toggle of its own). Community
renders the photo grid shared with `GalleryView` (extracted
as `PhotoGrid`) over the same filtered items, so search and category still
apply. The chosen mode is kept in `localStorage` (`foundit:v1:catalogMode`).

### Offline intake queue (Requirement 1.7–1.8)

`src/lib/offlineQueue.ts` is a small pure module over a `Storage`-like object
(`getItem`/`setItem`) so it can be unit tested. The queue lives under
`foundit:v1:offlineQueue` as a JSON array of items. Functions: `readQueue`,
`enqueue`, `removeFromQueue`, and `replayQueue(storage, send)`, which sends items
oldest first and stops at the first `"retry"` so order is kept. `send` returns
`"ok"` (remove), `"retry"` (keep, stop), or `"failed"` (remove and report).

`db.createItem` returns `"ok" | "retry" | "failed"`: a duplicate primary key
(`23505`, the earlier attempt actually landed) counts as `"ok"`; a fetch/network
error or `navigator.onLine === false` is `"retry"`; anything else is `"failed"`.
`App` enqueues on `"retry"` (or skips the request when already offline), merges
queued items into the catalog so the poster still sees them (status label
"Waiting to sync"), and replays on the `online` event, on sign-in, and when the
service worker posts `{ type: "replay-queue" }`. On enqueue, `App` registers a
background-sync tag (`foundit-replay`) where `registration.sync` exists
(Chromium); `sw.js` handles the `sync` event by messaging open clients to
replay, since the queue lives in page storage. Rejected posts show a dismissible
banner under the header. Dexie/Workbox from the original target design are not
used; the queue is small and `localStorage` is enough.

### Shared types module (task 11)

The app's data types (`Item`, `Claim`, `ChallengeResponse`, `CommentNode`,
`Repost`, `StudentVerification`, `AppNotification`, …) live in `src/types.ts`.
Both `App.tsx` and `src/lib/db.ts` import them, so `db.ts` no longer keeps
duplicate `Db*` shapes and `App` no longer needs `as unknown as` casts. The
original task's schema notes are obsolete: missing notices were replaced by
`kind: "lost"` items, and `owner_name` stays on `Claim` because the `claims`
table stores it (denormalized for staff views).

## Error handling & edge cases (current prototype)

- Empty search/filter result renders a clear empty state with a reset action.
- Required form fields block submission until filled.
- Toggling an upvote off never drops the count below the base value.
- Because state is in-memory, a page reload resets all data — acceptable for the
  prototype, resolved by the backend phase.

## Testing strategy

- Unit tests use Node's built-in runner (`node --test`), which runs TypeScript
  directly on Node 22.18+/24, so no test framework dependency is added. Run with
  `npm test` / `pnpm test`.
- Tested modules are pure (no `import.meta.env`, no Supabase client, no DOM):
  `src/lib/time.ts` (relative/posted labels), `src/lib/comments.ts` (tree build,
  count, nested reply insert, private-comment visibility),
  `src/lib/claimLimit.ts` (3-per-24h window), `src/lib/offlineQueue.ts`, and
  `src/lib/captionHeuristic.ts` (local caption parser). Logic is extracted from
  `App.tsx`/`db.ts`/`captionImport.ts` into these modules so tests exercise the
  code the app runs.
- Type safety: `tsc --noEmit` and `vite build`.
- Not covered yet: RLS policy tests against a database and UI integration
  tests; both need infrastructure (a local Supabase stack, a browser runner).
