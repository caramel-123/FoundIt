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

- [ ] 11. Extract types into a shared module and reconcile with the SQL schema
  - Add `missing_notices.image_url`; separate `owner_name` from `Claim`.
  - _Requirements: Future 2_

- [ ] 12. Introduce a data-access layer abstraction
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

- [ ] 12h. `parse-caption` Supabase Edge Function
  - Accepts `{ caption }`, calls Gemini 1.5 Flash for strict JSON
    `{ title, category, location_found, description }`, validates/clamps
    category to the app list, returns JSON with CORS. Key via `GEMINI_API_KEY`
    secret.
  - _Requirements: 12 (2, 8)_

- [ ] 12i. Client helper `src/lib/captionImport.ts`
  - `parseCaption(text)` invokes the Edge Function when Supabase is configured,
    else a local heuristic parser fallback.
  - _Requirements: 12 (2, 7)_

- [ ] 12j. "Fill from caption" UI on `FinderForm`
  - Paste textarea + action; processing/disabled state; merges non-empty fields;
    fields stay editable; no auto-submit; message when nothing extracted.
  - _Requirements: 12 (1, 3, 4, 5, 6)_

- [x] 12k. Deploy the function and set the key (out of band)
  - `supabase secrets set GEMINI_API_KEY=...` and
    `supabase functions deploy parse-caption`. Deployed; uses rolling
    `-latest` model aliases with 404/503/429 fall-through.
  - _Requirements: 12 (8)_

## Phase 2.7 — Functional item card actions (Requirement 5)

- [ ] 13a. State + handlers in `App`
  - `repostedIds: Set<string>`, `comments: Record<string, ItemComment[]>`;
    handlers for repost toggle, add-comment, and share (clipboard). `ItemComment`
    type added.
  - _Requirements: 5 (4, 6, 8, 9)_

- [ ] 13b. Wire `ItemCard` buttons
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

## Phase 2.8 — Facebook-style reposts + My Timeline (Requirements 5, 5a)

- [ ] 13e. Repost data model + handlers
  - `Repost` type; `reposts: Repost[]` state; add-repost (with optional caption)
    and remove-repost handlers; per-user "already reposted" lookup.
  - _Requirements: 5 (4, 5, 6, 8)_

- [ ] 13f. Repost dialog
  - Activating Repost opens a dialog: optional caption + confirm, or remove
    existing repost.
  - _Requirements: 5 (4, 6)_

- [ ] 13g. My Timeline view + nav
  - `"timeline"` view and "My Timeline" nav item; list user's reposts (caption +
    quoted item card), empty state, remove control.
  - _Requirements: 5a (1, 2, 3, 4)_

- [x] 13h. Reposts in the catalog feed
  - Render reposts of visible items as reposted cards quoting the original.
  - _Requirements: 5 (7)_

## Phase 2.9 — Repost card actions + My Profile (Requirements 5, 5b)

- [ ] 13i. Generalize engagement to post ids
  - Key `upvotedIds` and `comments` by a generic post id (item id or repost id)
    so reposts carry their own upvote/comment state.
  - _Requirements: 5 (8a)_

- [ ] 13j. Functional action row on repost cards
  - RepostCard gets upvote, comment thread (+replies), share; Repost targets the
    underlying item.
  - _Requirements: 5 (8a, 8b)_

- [ ] 13k. My Profile view + nav
  - `"profile"` view + "Profile" nav item; header (avatar/name/email/sign-out);
    user's posts + reposts; empty state.
  - _Requirements: 5b (1–5)_

## Phase 3 — Supabase backend

- [ ] 13. Provision schema, enums, and indexes (items, claims, claim_messages,
      missing_notices, item_upvotes, audit_logs)
  - _Requirements: Future 2, 4_

- [ ] 14. Row-Level Security policies and `is_staff()`
  - Finder/owner/staff isolation; public catalog restricted to active statuses;
    `private_note` never exposed publicly.
  - _Requirements: 2, 3, 6, 7; Future 2_

- [ ] 15. Back the auth contract with real Supabase Auth
  - Point `src/lib/auth.ts` at Supabase Auth's Google provider (replacing any
    interim mock); derive `Role` from the account/JWT `staff` claim.
  - _Requirements: 10; Future 2_

- [ ] 16. Upvote concurrency and audit triggers
  - `item_upvotes` table + counter trigger; audit trigger on items/claims.
  - _Requirements: 5; Future 4_

- [ ] 17. Claim rate-limiting Edge Function
  - Max 3 claims per rolling 24h per user, enforced server-side.
  - _Requirements: 6; Future 3_

## Phase 4 — Media and offline

- [ ] 18. Real client-side EXIF/GPS strip + WebP re-encode
  - Replace the simulated processing in `FinderForm` with the Canvas pipeline;
    upload to Storage.
  - _Requirements: 1; Future 1_

- [ ] 19. PWA shell + offline caching + background-sync replay
  - Installable manifest; cache strategies per asset class; queued mutations.
  - _Requirements: Future 5, 6_

## Phase 5 — Quality

- [ ] 20. Automated tests
  - Data-access unit tests, RLS policy tests, and key UI integration tests.
  - _Requirements: all_
