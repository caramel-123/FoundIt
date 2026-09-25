# Implementation Plan — Campus Lost & Found

This plan reflects the current client-side prototype and the path toward the
Supabase-backed target. Tasks marked `[x]` are implemented in `src/App.tsx`
today; unchecked tasks are remaining work.

## Phase 1 — Client prototype (in-memory, no seed data)

- [x] 1. Project scaffold (React 19 + Vite 8 + Tailwind v4) and app shell
  - `main.tsx` mounts `App`; `index.css` imports Tailwind.
  - _Requirements: all_

- [x] 2. Core data types (no seed data)
  - `Item`, `Claim`, `ClaimMessage`, `MissingNotice`, `Role`, status enums.
  - Initial item/claim/notice collections are empty; content is created by the
    user at runtime.
  - _Requirements: 1, 2, 6, 7, 9_

- [x] 3. Role-based navigation with demo role selector
  - `Nav` filters destinations by role and resets to catalog on role change.
  - _Requirements: 10_

- [x] 4. Item status state machine
  - Four states; staff-only transitions via `handleStatusChange`.
  - _Requirements: 2_

- [x] 5. Public catalog with search and category filter
  - Visibility limited to `in_office` / `approved_for_pickup`.
  - Search matches title, description, and location; category filter; empty state.
  - Working, visible search field with focus/clear control.
  - _Requirements: 3_

- [x] 6. Reddit-style item card
  - Avatar + poster name + relative time (7-day cutoff to full date).
  - Title, description, location, status shown as an icon.
  - Action row (upvote/comment/repost/share) aligned on one row.
  - "Claim this item" aligned bottom-right.
  - _Requirements: 4, 5_

- [x] 7. Finder intake form
  - Title, category, location, time, description, private note, photo.
  - Simulated EXIF-strip processing state; success confirmation.
  - _Requirements: 1_

- [x] 8. Owner claim submission and private thread
  - `ClaimModal` creates a `pending_review` claim; per-claim message thread;
    owner replies.
  - _Requirements: 6, 7_

- [x] 9. Staff dashboard
  - Pending-intake queue and claims-review queue; approve/reject; status controls;
    staff replies.
  - _Requirements: 8_

- [x] 10. Missing notices bulletin
  - Passive post form and list; no claim/thread.
  - _Requirements: 9_

## Phase 2 — Data layer refactor (prep for backend)

- [x] 11. Extract types into a shared module (`src/types.ts`) used by `App` and
      `db.ts`; drop the duplicate `Db*` shapes and casts
  - The original schema notes are obsolete (see design "Shared types module").
  - _Requirements: Future 2_

- [x] 12. Introduce a data-access layer abstraction (`src/lib/db.ts`)
  - Wrap all reads/writes behind functions so mock data can be swapped for
    Supabase without touching components.
  - _Requirements: Future 2_

## Phase 2.5 — Google authentication (Requirement 10)

- [x] 12a. Define the auth contract module `src/lib/auth.ts`
  - `AuthUser`, `AuthState`, and functions `getSession`, `signInWithGoogle`,
    `signOut`, `onAuthChange`.
  - _Requirements: 10_

- [x] 12b. Add auth state to `App` and gate the app behind sign-in
  - Loading state during session restore; render `SignIn` when signed out; render
    the app only when signed in; persist/restore session across reloads.
  - _Requirements: 10 (1, 2, 6, 7)_

- [x] 12c. Build the `SignIn` screen
  - Branded screen with a "Continue with Google" button and friendly error
    display on failure/cancel.
  - _Requirements: 10 (1, 2, 7)_

- [x] 12c-1. Public landing page + signed-out routing (Requirement 10a)
  - Add `LandingPage` component: brand wordmark, tagline, "how it works"
    summary (log → verify → claim → release), and a "Get started" CTA.
  - Add signed-out `authView` state (`"landing" | "login"`) to `App`; default to
    landing, CTA opens `SignIn`, and `SignIn` has a back control to landing.
  - Landing shown only when signed out; authenticated app renders directly.
  - _Requirements: 10a (1, 2, 3, 4, 5, 6); 10 (1)_

- [x] 12d. Replace the demo role selector in `Nav` with the account UI
  - Show signed-in user's avatar/name and a "Sign out" action; derive role from
    the account (default non-staff); retire Requirement 11's demo selector.
  - _Requirements: 10 (3, 5, 8); 11_

- [x] 12e. Wire record ownership to the authenticated user
  - Set `finder_id` (items) and `owner_id` / owner name (claims) from `AuthUser`
    instead of hardcoded ids.
  - _Requirements: 10 (4)_

- [x] 12f. Configure Google OAuth provider (out of band)
  - Google Cloud OAuth client created; redirect URI
    `https://zyyaoquwgnaexsgxsjcv.supabase.co/auth/v1/callback` registered;
    Supabase Google provider enabled with the client id/secret. Secrets stay in
    the dashboard, not the repo.
  - _Requirements: 10 (2)_

- [x] 12g. Wire real Supabase Google OAuth (env-driven, mock fallback)
  - `src/lib/supabase.ts` client from `VITE_SUPABASE_URL` /
    `VITE_SUPABASE_ANON_KEY`; `auth.ts` uses Supabase OAuth when configured and
    falls back to the mock otherwise.
  - _Requirements: 10 (2, 3, 6)_

## Phase 2.6 — AI caption import (Requirement 12)

- [x] 12h. `parse-caption` Supabase Edge Function
  - Accepts `{ caption }`, calls Gemini 1.5 Flash for strict JSON
    `{ title, category, location_found, description }`, validates/clamps
    category to the app list, returns JSON with CORS. Key via `GEMINI_API_KEY`
    secret.
  - _Requirements: 12 (2, 8)_

- [x] 12i. Client helper `src/lib/captionImport.ts`
  - `parseCaption(text)` invokes the Edge Function when Supabase is configured,
    else a local heuristic parser fallback.
  - _Requirements: 12 (2, 7)_

- [x] 12j. "Fill from caption" UI on `FinderForm`
  - Paste textarea + action; processing/disabled state; merges non-empty fields;
    fields stay editable; no auto-submit; message when nothing extracted. When
    the caption yields no time found, default "When did you find it?" to now
    (editable).
  - _Requirements: 12 (1, 2a, 3, 4, 5, 6)_

- [x] 12k. Deploy the function and set the key (out of band)
  - `supabase secrets set GEMINI_API_KEY=...` and
    `supabase functions deploy parse-caption`. Deployed; uses rolling
    `-latest` model aliases with 404/503/429 fall-through.
  - _Requirements: 12 (8)_

## Phase 2.7 — Functional item card actions (Requirement 5)

- [x] 13a. State + handlers in `App`
  - `repostedIds: Set<string>`, `comments: Record<string, ItemComment[]>`;
    handlers for repost toggle, add-comment, and share (clipboard). `ItemComment`
    type added.
  - _Requirements: 5 (4, 6, 8, 9)_

- [x] 13b. Wire `ItemCard` buttons
  - Repost toggle (active state + count), share copy-link with transient
    "Link copied" confirmation, comment toggles the thread; counts reflect real
    values.
  - _Requirements: 5 (4, 5, 6, 7, 10)_

- [x] 13c. Inline comment thread UI on the card
  - List existing comments (author + relative time), add-comment input, empty
    prompt when none.
  - _Requirements: 5 (8, 9, 11)_

- [x] 13d. Per-comment replies
  - `CommentReply` type + `replies` on `ItemComment`; "Reply" action per comment
    reveals an input; replies render indented; count includes replies.
  - _Requirements: 5 (15, 16, 17)_

- [x] 13d-1. Modal comment panel (Facebook-style pop-up)
  - Replace the inline slide-down thread with a `CommentModal`: centered dialog
    over a dimmed backdrop, the full post rendered at the top, scrollable comment
    tree, sticky bottom composer. Comment button becomes a trigger. Dismiss via
    close button, backdrop click, and Escape.
  - _Requirements: 5 (11)_

- [x] 13d-2. Branching (nested) replies
  - Unify comments/replies into one recursive `CommentNode` (`replies:
    CommentNode[]`). Recursive `CommentThread` render with per-node Reply input
    and increasing indentation; immutable add-reply walks the tree by parent id;
    count sums the whole tree.
  - _Requirements: 5 (15, 16, 17, 18)_

## Phase 2.8 — Facebook-style reposts + My Timeline (Requirements 5, 5a)

- [x] 13e. Repost data model + handlers
  - `Repost` type; `reposts: Repost[]` state; add-repost (with optional caption)
    and remove-repost handlers; per-user "already reposted" lookup.
  - _Requirements: 5 (4, 5, 6, 8)_

- [x] 13f. Repost dialog
  - Activating Repost opens a dialog: optional caption + confirm, or remove
    existing repost.
  - _Requirements: 5 (4, 6)_

- [x] 13g. My Timeline view + nav
  - `"timeline"` view and "My Timeline" nav item; list user's reposts (caption +
    quoted item card), empty state, remove control.
  - _Requirements: 5a (1, 2, 3, 4)_

- [x] 13h. Reposts in the catalog feed
  - Render reposts of visible items as reposted cards quoting the original.
  - _Requirements: 5 (7)_

## Phase 2.9 — Repost card actions + My Profile (Requirements 5, 5b)

- [x] 13i. Generalize engagement to post ids
  - Key `upvotedIds` and `comments` by a generic post id (item id or repost id)
    so reposts carry their own upvote/comment state.
  - _Requirements: 5 (8a)_

- [x] 13j. Functional action row on repost cards
  - RepostCard gets upvote, comment thread (+replies), share; Repost targets the
    underlying item.
  - _Requirements: 5 (8a, 8b)_

- [x] 13k. My Profile view + nav
  - `"profile"` view + "Profile" nav item; header (avatar/name/email/sign-out);
    user's posts + reposts; empty state.
  - _Requirements: 5b (1–5)_

- [x] 13l. Client-side persistence via `localStorage` (Requirement 14)
  - `usePersistentState` hook: hydrate from `localStorage` on init (default on
    missing/malformed JSON), write on change; versioned `foundit:v1:` keys.
  - Persist `items`, `claims`, `notices`, `comments`, `reposts`, `upvotedIds`
    (Set (de)serialized as array). Auth/session excluded.
  - _Requirements: 14 (1–6)_

## Phase 2.9 — Student verification (Requirement 15, AI-only)

- [x] 16a. Client helper `src/lib/studentVerify.ts`
  - `verifyStudent({imageBase64,mimeType,accountName,docType})` invokes the
    `verify-student` Edge Function; decides verified only on pass + confidence
    ≥ 0.75 + student doc + name match, else rejected; "unavailable" when Supabase
    isn't configured (no fallback approval).
  - _Requirements: 15 (2, 3, 4, 5, 7, 8)_

- [x] 16b. `verify-student` Supabase Edge Function
  - Gemini Vision reads the image; returns `{is_student_doc, doc_type,
    extracted{...}, name_matches_account, confidence, ai_verdict}` with CORS;
    key via `GEMINI_API_KEY`. Raw image not persisted.
  - _Requirements: 15 (3, 8, 9)_

- [x] 16c. App state + `VerificationBadge`
  - Persistent `verifications` (`Record<userId, StudentVerification>`, no
    "pending"); `verifiedIds` via `VerifiedContext`. `VerificationBadge` shown
    next to names on posts, reposts, comments, and the comment modal's post.
  - _Requirements: 15 (1, 6)_

- [x] 16d. Profile "Get verified" UI
  - Doc-type select + image upload; calls verifyStudent; shows verified /
    rejected / unavailable messages. No staff queue.
  - _Requirements: 15 (1, 2, 5, 6, 7)_

## Phase 2.10 — Ownership Challenge ("Prove it's yours", Requirement 16)

- [x] 17a. Data model + App state/handlers
  - `ChallengeQuestion` on `Item.challenge?`; `ChallengeResponse` type;
    `challengeResponses` persistent state. Handlers: submit response, finder
    approve/reject, send-to-staff (creates a `Claim` from answers).
  - _Requirements: 16 (1, 3, 5, 6, 7)_

- [x] 17b. FinderForm challenge builder
  - Optional "Ownership challenge" section: add/remove short-text questions;
    attach `challenge` to the submitted item.
  - _Requirements: 16 (1)_

- [x] 17c. "Prove it's yours" action + `ChallengeModal`
  - Item card action becomes "Prove it's yours" when `item.challenge` exists;
    modal renders questions as short-text inputs + optional note; submit creates
    a response. Falls back to `ClaimModal` when no challenge.
  - _Requirements: 16 (2, 3, 8)_

- [x] 17d. Finder responses/analytics on own post
  - `ChallengeResponsesModal` opened from a "Responses (N)" control on the
    finder's own posts (Profile → Your posts): responder + answers + note +
    count; Approve / Reject / Send to staff.
  - _Requirements: 16 (4, 5, 6, 7)_

## Phase 2.11 — Found/Lost toggle on the Log form (Requirement 1.0/3a)

- [x] 18a. FinderForm Found/Lost mode toggle
  - Title "Log a Found/Lost Item"; Found/Lost toggle. Found = existing found-item
    flow. Lost = missing-notice fields (description, location lost, time lost,
    optional photo); hide challenge, staff note, drop-off copy.
  - _Requirements: 1 (0, 1, 2, 3, 3a), 9_

- [x] 18b. Route submission + wire onPostNotice
  - Found → onSubmit item (unchanged); Lost → onPostNotice(missing notice, with
    optional image_url). Add `image_url?` to MissingNotice.
  - _Requirements: 1 (3, 3a), 9_

## Phase 2.12 — Community photo view, author profile, inline post actions & polish

- [x] 21a. Community photo-centric catalog view toggle (Feed / Community)
  - Layout toggle in CatalogView header; responsive image grid for photo posts
    with minimal overlay (title, Lost/Found tag, location); click opens PostDetail.
  - _Requirements: 3.9_

- [x] 21b. Public author profile (`PublicProfileView` + `OpenAuthorContext`)
  - Clicking any author avatar or name opens PublicProfileView with their avatar,
    name, student verification badge, post count, and list of public posts.
  - _Requirements: 5c_

- [x] 21c. Inline action section inside `PostDetail` ("I found it" / "I lost it")
  - Embed the challenge/lost report authoring and answering forms inline within
    PostDetail directly between the post body and comment thread.
  - _Requirements: 5 (19), 16 (2), 17 (2)_

- [x] 21d. Action row button styling + modal header polish + PWA logo text
  - Share button transparent outline; modal headers "I lost it" / "I found it";
    clickable item card in ChallengeModal; "Foundit" typography in icon.svg.
  - _Requirements: 4 (4), 16, 17, Future 6_

## Phase 3.0 — Shared data via Supabase (incremental; start with items)


Goal: all users see each other's posts by moving data from per-browser
localStorage into shared Postgres, one slice at a time, with a localStorage
fallback when Supabase isn't configured.

- [x] 19a. `items` table + RLS migration (apply to Supabase)
  - Columns map the `Item` type (incl. `challenge jsonb`, `image_url`). RLS:
    authenticated read of `in_office`/`approved_for_pickup` (+ finder's own
    `pending_intake`); insert where `finder_id = auth.uid()`.
  - _Requirements: 3, 1; Phase 3_

- [x] 19b. Data-access layer `src/lib/db.ts` for items
  - `listItems`, `createItem`, `subscribeItems` (Realtime); row⇄Item mapping;
    localStorage fallback when Supabase unconfigured.
  - _Requirements: 3; Phase 3_

- [x] 19c. Rewire App items to Supabase (load + realtime + insert)
  - Replace `usePersistentState("items")` with db load + realtime; write via
    `createItem`. Other slices stay on localStorage until migrated.
  - _Requirements: 3; Phase 3_

- [x] 19d. Later slices: comments, reposts, challenge responses, verifications,
      notifications (same pattern; migrations 0002–0004)
  - Missing notices were superseded by `kind: "lost"` items (Requirement 9).
  - Claims move in task 22b.
  - _Requirements: 6, 7, 9, 5, 16, 15; Phase 3_

## Phase 3.3 — Staff roster, shared claims, upvotes, rate limit, audit

- [x] 22a. Migration `0005_staff_claims_audit.sql`
  - Written; must be run in the Supabase SQL editor (or via migration tooling)
    before the claims/upvotes/staff features work against the shared db.
  - `staff` roster + `is_staff()`; staff update/read policies on `items`;
    `claims` + `claim_messages` with RLS and realtime; rate-limit trigger;
    `escalate_challenge_response()`; `upvotes` table; `audit_logs` + triggers.
  - _Requirements: 2 (6), 5 (3a), 6 (5, 6), 7, 8, 10 (9); Future 2, 3, 4_

- [x] 22b. Staff role from the roster in `auth.ts`
  - `is_staff` RPC after sign-in; `VITE_STAFF_EMAILS` in mock mode.
  - _Requirements: 10 (8, 9)_

- [x] 22c. Claims + claim messages in `db.ts` and `App`
  - list/create/update-status/insert-message/subscribe; escalation via RPC;
    staff replies use the staff member's own id; `localStorage` fallback.
  - _Requirements: 6 (6), 7, 8_

- [x] 22d. Claim rate limit on "Prove it's yours"
  - Server triggers on `challenge_responses` and `claims`; client blocks the 4th
    claim in 24h with "You can claim again after …". Remove unreachable
    `ClaimModal`.
  - _Requirements: 6 (5)_

- [x] 22h. Post detail wiring
  - Pass upvote/repost/share into `PostDetail`; detail "I lost it"/"I found it"
    opens the inline form; render `OwnershipActionSection` for existing flows;
    question builder on the lost-post form.
  - _Requirements: 5 (19), 17 (2, 4, 6, 8)_

- [x] 21e. Real photo re-encode (`src/lib/image.ts`) in `FinderForm`
  - _Requirements: 1 (4); Future 1_

- [x] 22e. Staff item status changes persisted (`updateItemStatus`)
  - _Requirements: 2 (6), 8 (2, 4)_

- [x] 22f. Shared upvotes (`listUpvotes`, `toggleUpvote`, `subscribeUpvotes`,
      `UpvoteCountsContext`)
  - _Requirements: 5 (1, 2, 3a)_

- [x] 22g. Catalog empty state "Clear filters" action
  - _Requirements: 3 (6)_

## Phase 3.4 — Mobile navigation

- [x] 23a. Mobile bottom tab bar (`BottomNav`)
  - Feed / Community / square "+" / Alerts (unread badge) / Profile; lift catalog
    layout mode into `App`; hide header "+"/bell/avatar and the catalog toggle
    below `md`; safe-area padding; staff variant without "+".
  - _Requirements: 11a (3, 9), 3 (9), 18 (3)_

## Phase 3.5 — Caption-only log form

- [x] 24a. Single Caption field on the Log form (Found and Lost)
  - `splitCaption` / `joinCaption` in `src/lib/captionHeuristic.ts` (+ tests);
    first line → title, rest → description; caption import fills the caption.
  - _Requirements: 1 (0, 1, 1a, 2), 12 (2)_

## Phase 3.6 — Public profiles like your own

- [x] 25a. `profiles` table + upsert on sign-in + `ProfilesContext`; `Avatar`
      shows photos. Author profile page mirrors `ProfileView` (photo, name,
      stats, posts + reposts as cards; no email/sign-out/verification).
  - _Requirements: 5c (2, 3, 3a)_

## Phase 3.7 — Edit / delete own post

- [x] 26a. `PostMenu` (⋯) on card + detail for the author; Edit reuses the
      composer (`editItem`); Delete with confirm; `db.updateItem` /
      `db.deleteItem`; migration 0008 `items_delete` policy.
  - _Requirements: 5d_

## Phase 3 — Supabase backend

- [x] 13. Provision schema, enums, and indexes (items, claims, claim_messages,
      missing_notices, item_upvotes, audit_logs)
  - Done through migrations 0001–0005 (text ids and check constraints instead of
    uuid FKs and enums; `missing_notices` superseded by `kind: "lost"`). Ticked
    with 22a.
  - _Requirements: Future 2, 4_

- [x] 14. Row-Level Security policies and `is_staff()`
  - Finder/owner/staff isolation; public catalog restricted to active statuses;
    `private_note` never exposed publicly.
  - _Requirements: 2, 3, 6, 7; Future 2_

- [x] 15. Back the auth contract with real Supabase Auth
  - Point `src/lib/auth.ts` at Supabase Auth's Google provider (replacing any
    interim mock); derive `Role` from the account/JWT `staff` claim.
  - _Requirements: 10; Future 2_

- [x] 16. Upvote concurrency and audit triggers
  - `upvotes` table with a (post, user) primary key; counts are derived from the
    rows instead of a counter trigger, so there's no counter to race. Audit
    triggers on items/claims (migration 0005).
  - _Requirements: 5; Future 4_

- [x] 17. Claim rate limiting (database trigger replaces the Edge Function; see
      design "Claim rate limit"). Ticked with 22a/22d.
  - Max 3 claims per rolling 24h per user, enforced server-side.
  - _Requirements: 6; Future 3_

## Phase 4 — Media and offline

- [x] 18. Real client-side EXIF/GPS strip + WebP re-encode
  - Canvas pipeline in `src/lib/image.ts` (task 21e). Photos stay as data URLs;
    moving them to Supabase Storage is not done.
  - _Requirements: 1; Future 1_

- [x] 19. PWA shell + offline caching + background-sync replay
  - Done: installable manifest and app-shell service worker (`public/sw.js`).
  - Offline intake queue (`src/lib/offlineQueue.ts`) with replay on reconnect,
    app open, and background sync; "Waiting to sync" label; rejection banner.
  - _Requirements: 1 (7, 8)_
  - _Requirements: Future 5, 6_

## Phase 5 — Quality

- [x] 20. Automated tests
  - `node --test` unit tests for pure modules extracted from `App`/`db`/
    `captionImport`: time labels, comment tree, claim limit, offline queue,
    caption heuristic. `test` script in `package.json`.
  - RLS policy tests and UI integration tests remain future work.
  - _Requirements: all_
