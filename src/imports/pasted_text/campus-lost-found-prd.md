# Product Requirements Document — Campus Lost & Found

## Purpose / value proposition
Digitize the campus admin office's existing trusted lost-and-found
workflow as a strict digital state machine — not a social forum. Finders
log items, staff verify physical custody, owners claim privately, staff
verify and release. No public chat, no peer-to-peer contact, no listing
of items the office doesn't physically hold yet.

## Personas
- **Finn the Finder** — student who found a phone in the library.
  Wants to log it fast, ideally from his phone, possibly offline, and be
  done with it once he's dropped it at the office.
- **Olivia the Owner** — student who lost her ID card. Wants to check if
  it's been turned in without scrolling a noisy Facebook feed, and to
  prove it's hers without a stranger DM-ing her.
- **Sam on Staff** — admin office worker. Wants a queue of what's pending
  intake, a simple way to mark custody, and a private thread to verify
  each claim before releasing anything.

## MoSCoW feature table

| Priority | Feature |
|---|---|
| Must | Finder: log a found item (category, location, time, description, private note, photo) |
| Must | Client-side EXIF/GPS strip + WebP re-encode before any photo upload |
| Must | Item status state machine: `pending_intake` → `in_office` → `approved_for_pickup` → `released`, staff-only mutation |
| Must | Public catalog: authenticated users see only `in_office` / `approved_for_pickup` items |
| Must | Owner: submit a claim with identifying details against a catalog item |
| Must | Private claim_messages thread: owner ↔ staff only, scoped per claim |
| Must | Staff: approve/reject claim, mark item released |
| Must | RLS enforcing finder/owner/staff data isolation at the DB layer |
| Must | Rate limiting: max 3 claims / rolling 24h / authenticated user |
| Must | Full audit trail (who changed what, when, old→new) on `items` and `claims` |
| Must | Offline logging with background-sync replay for finder intake |
| Should | Passive "still missing" bulletin (`missing_notices`) — no claim/chat |
| Should | Upvote on catalog items ("I saw this too") — engagement signal only |
| Should | Staff dashboard: pending-intake queue, claims-to-review queue |
| Could | Email notification on claim status change (poll-friendly fallback if not built) |
| Could | Category/date filters on the public catalog |
| Won't (v1) | Push notifications |
| Won't (v1) | Student-to-student chat |
| Won't (v1) | Interactive campus maps |
| Won't (v1) | AI-driven photo matching |
| Won't (v1) | University SSO |

## User stories (Given/When/Then)

**Finder logs an item**
- Given Finn found a water bottle and is signed in, when he submits
  category/location/time/description/photo, then an `items` row is
  created with `status = pending_intake`, visible only to him, and the
  photo has been stripped of EXIF/GPS before upload.

**Item enters custody**
- Given staff physically receive the water bottle at the desk, when
  staff mark the item's status `in_office`, then the item becomes
  visible in the public catalog to all authenticated users.

**Owner claims an item**
- Given Olivia recognizes her item in the catalog, when she submits a
  claim with identifying details, then a `claims` row is created with
  `status = pending_review`, visible only to her and staff, and it
  counts against her 3-per-24h rate limit.

**Staff verifies and releases**
- Given staff review Olivia's identifying details via
  `claim_messages` and are satisfied, when staff approve the claim and
  mark the item `approved_for_pickup`, then the item stays in the public
  feed but shows locked/unavailable; when the physical handover happens
  at the desk and staff mark it `released`, then the item is archived
  and instantly drops out of the active feed.

**Offline intake**
- Given Finn is in a basement with no signal, when he submits a found-
  item log, then the request is queued in IndexedDB via the Background
  Sync API and automatically replayed the moment connectivity returns,
  even if he has closed the app.

**Abuse resistance**
- Given a user has already submitted 3 claims in the last 24 hours,
  when they attempt a 4th, then the request is rejected before reaching
  the claims table.

## App flow & UX intent
Two entry surfaces, deliberately asymmetric:
1. **"I found something"** — a short, camera-first form. Optimized for
   speed and for working offline.
2. **"I lost something"** — browse the public catalog (filterable by
   category), optionally post a passive missing notice, and claim an
   item privately when spotted. No way to message a finder directly, at
   any point, by design.

Staff get a separate, simpler operational view: a pending-intake queue,
an active-claims queue with the per-claim message thread, and status
controls. Staff are the only role that can ever move an item forward in
the state machine.

## Out of scope
Push notifications, peer-to-peer chat, campus maps, AI photo matching,
SSO — see BRD for rationale (kept in for v1 focus on replacing the core
Facebook-group workflow safely, not building a broader platform).

## AI/agent feature spec
None in v1. (AI-driven photo matching is explicitly deferred, not
built.)

## Dependencies & assumptions
- Supabase project (Auth, Postgres, Storage, Edge Functions) provisioned
  and reachable.
- Staff accounts are provisioned with a `staff` claim out of band
  (no self-service staff signup in v1).
- Users have a modern evergreen browser (Canvas API, Service Worker,
  Background Sync API support assumed — Background Sync currently has
  partial cross-browser support; see SDD open questions).

## Milestone implementation plan
1. Schema + RLS + indexes + audit triggers live in Supabase.
2. Finder intake flow + EXIF-strip pipeline + offline queue.
3. Staff intake/claims dashboard + status transitions.
4. Public catalog + claim submission + claim_messages thread.
5. Rate limiting Edge Function + upvotes.
6. PWA shell (manifest, Workbox caching, install prompt) wired over the
   above.
