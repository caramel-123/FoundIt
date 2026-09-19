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
  user creates it during the session. (Data is still in-memory and resets on
  reload until the Supabase data layer lands in Phase 3.)

### Component structure (`src/App.tsx`)

| Component | Responsibility |
|---|---|
| `App` | Owns all state (items, claims, notices, role, view, upvotes) and handlers; renders `Nav` + the active view; hosts the claim modal. |
| `Nav` | Sticky Reddit-style header: hamburger button (far left) toggling a left sidebar drawer that holds the role-filtered nav destinations (highlighting the current one); brand; centered search field; right side a "+" create icon (opens Log Item) and the profile avatar (opens profile); offline banner. No chat/bell, no top nav row. Search state is lifted to `App` and passed in. |
| `CatalogView` | Public catalog with search field + category filter; renders `ItemCard` list and an empty state. |
| `ItemCard` | Reddit-style post: avatar + poster name + relative time + status icon, title, description, location, action row (upvote/comment/repost/share) and bottom-right claim action. |
| `StatusBadge` | Renders the item status as an icon with an accessible label/tooltip. |
| `Avatar` | Deterministic colored initials avatar keyed on user id. |
| `ClaimModal` | Owner submits identifying details for a claim. |
| `FinderForm` | Log a found item; simulates EXIF stripping on photo select. |
| `MissingNotices` | Passive missing-item bulletin with a post form. |
| `OwnerClaimsView` | Owner's claims list and per-claim message thread. |
| `StaffDashboard` | Pending-intake queue and claims-review queue with status controls and reply thread. |

### Data types (current)

```ts
type ItemStatus = "pending_intake" | "in_office" | "approved_for_pickup" | "released";
type ClaimStatus = "pending_review" | "approved" | "rejected";
type Role = "finder" | "owner" | "staff";

interface Item {
  id: string;
  finder_id: string;
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
  - **Comment** reveals an inline thread on the card. Comments are stored per
    item id in a `Record<string, ItemComment[]>` map in `App`. Posting appends a
    comment attributed to the signed-in user. Each comment has a **Reply** action
    that reveals a per-comment input; replies are stored in the comment's
    `replies` array and rendered indented under their parent. The card's comment
    count reflects `baseComments + total comments + total replies`. Empty threads
    show a first-comment prompt.
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

- **Identity:** a single warm palette family (cream `#FBF9D1`, sand `#E6CFA9`,
  terracotta `#C1856D`, rust `#9A3F3F`, ink `#2C1414`) exposed as CSS theme
  tokens in `index.css`. One accent (rust); no competing accent colors.
- **Typography:** display/UI font is **Outfit** (loaded via Google Fonts in
  `index.css`) with a system-font fallback. Headings use SemiBold/Bold with
  slightly negative letter-spacing and tight leading; body uses Regular/Medium.
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

Authentication gates the entire app: an unauthenticated visitor sees only a
sign-in screen, and all views (catalog, finder form, claims, staff) render only
once a session exists.

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
| `App` | Add auth state; render `<SignIn/>` when signed out, a loader while loading, and the current app only when signed in. Pass `AuthUser` down. |
| `SignIn` (new) | Branded sign-in screen with the "Continue with Google" button and error display. |
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

## Error handling & edge cases (current prototype)

- Empty search/filter result renders a clear empty state with a reset action.
- Required form fields block submission until filled.
- Toggling an upvote off never drops the count below the base value.
- Because state is in-memory, a page reload resets all data — acceptable for the
  prototype, resolved by the backend phase.

## Testing strategy

- No automated tests exist yet. Type safety is enforced via `tsc --noEmit`.
- When the backend is introduced, add unit tests around the data-access layer and
  RLS policy tests at the database layer before UI integration tests.
