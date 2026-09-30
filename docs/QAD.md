# QA plan

## Scope
Tested: posting, catalog, verification flows, claims, profiles, notifications,
offline queue, auth routing. Not tested automatically: UI rendering and the Edge
Functions against the live Gemini API.

## Unit tests
Run with `npm test` (21 tests, all passing as of 2026-09-27).

| File | Covers |
|---|---|
| src/lib/campusPlaces.test.ts | Location suggestions from the PUP map (R1) |
| src/lib/captionHeuristic.test.ts | Local caption parsing fallback (R12) |
| src/lib/claimLimit.test.ts | 3 claims per 24 hours (R6) |
| src/lib/comments.test.ts | Public and private comment visibility (R5) |
| src/lib/offlineQueue.test.ts | Offline intake queue and replay (R1, R14) |
| src/lib/time.test.ts | Relative time formatting (R4) |

## Manual checks
Run at phone size (375x812). Compare with `design/screens/`.

| R | Steps | Expected |
|---|---|---|
| R10a | Open the app signed out | Landing page, then sign-in on "Get started" |
| R1 | Tap "+", write a caption, pick a place, add a photo, Post | Post appears at the top of the feed with the place and photo |
| R1 | Turn off network, post, turn it back on | Post shows as pending, then syncs |
| R12 | Open the caption import pop-up and paste a caption | Fields fill from the caption |
| R5 | Upvote, comment (public and private), repost, share | Counts update; private comments only visible to the author |
| R5d | On your own post, open the pen icon | Edit and delete work; not shown on others' posts |
| R16 | Claim a found post and answer the finder's form | Finder sees the answers and can approve or reject |
| R17 | On a lost post, tap "I found it" and send a form | Owner is notified and can answer |
| R18 | Trigger a claim or form answer | Notification appears; tapping it opens the post |
| R5c | Tap an author avatar | Full author profile with their posts and total upvotes |
| R19 | Open the gallery tab | Photo grid of posts |
| R6 | Submit a fourth claim within 24 hours | Blocked with a clear message |
| R15 | Start student verification | Upload flow runs; badge only after approval |

## Release criteria
1. `npx tsc --noEmit`, `npm run build` and `npm test` pass.
2. All manual checks above pass on a phone.
3. Screens in `design/screens/` re-captured for any changed UI.
4. Pending migrations applied (0008_items_delete.sql is not applied yet).
