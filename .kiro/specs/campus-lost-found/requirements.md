# Requirements — Campus Lost & Found

## Introduction

Campus Lost & Found digitizes the campus admin office's trusted lost-and-found
workflow as a strict state machine — not a social forum. Finders log found
items, staff verify physical custody, owners claim items privately, and staff
verify and release. There is deliberately no public chat, no peer-to-peer
contact, and no listing of items the office does not physically hold yet.

The current implementation (`src/App.tsx`) is a client-side React prototype.
It starts with no seeded data — items, claims, and missing notices appear only
as the signed-in user creates them during a session. Authentication uses Google
sign-in (Requirement 10). Application data is migrating from per-browser
`localStorage` (Requirement 14) to **shared Supabase Postgres** (Phase 3) so all
users see each other's posts. Migrated slices: items, comments, reposts,
challenge responses, verifications, notifications, upvotes, and claims with
their private threads. A staff roster in the database decides which accounts
are staff. When Supabase is not configured, every slice falls back to
`localStorage`. Offline background-sync replay is the main remaining target and
is captured in `design.md`.

### Personas
- **Finder** — found something, wants to log it fast (ideally from a phone,
  possibly offline) and be done once dropped at the office.
- **Owner** — lost something, wants to check whether it was turned in and prove
  ownership without a stranger contacting them.
- **Staff** — admin office worker, wants a queue of pending intake, a way to
  mark custody, and a private thread to verify each claim before release.

---

## Requirements

### Requirement 1 — Log a found item (Finder)

**User story:** As a finder, I want to log a found item with its details and an
optional photo, so that I can hand it to the office and have it tracked.

#### Acceptance Criteria
0a. THE "Log Item" view SHALL be a **post composer that looks like the post it
   will create**: the signed-in user's profile photo and name, "just now", and a
   tappable **Found / Lost** tag (which is the mode toggle) in the post header;
   the caption typed directly into the post (first line styled as the title),
   with grey template hints rather than prefilled text; a category chip; a 📍
   location row (there is no time field — the item's time is recorded as the
   moment it is posted); and the photo area where the post image goes,
   showing the image once chosen. Below the post: the verification form card
   (Found only), the private note to staff, and a **Post** button. The
   caption-import action is a plain ✨ icon at the bottom-right of the caption
   area; it opens the caption import as a pop-up dialog over a dimmed
   backdrop, styled like the verification-form card (white, sand border,
   rounded, heading + close control). It closes on ✕, backdrop click, or
   Escape, and closes automatically after a successful fill.
0. THE "Log Item" view SHALL be titled "Log a Found/Lost Item" and SHALL offer a
   **Found / Lost** mode toggle (the tag in the composer's post header, 0a). "Found" is the default and drives the
   found-item flow below. "Lost" switches the form to post a missing notice
   (Requirement 9) that collects the SAME fields as the found form — caption,
   category, location lost, an optional private note to staff, and an
   optional photo — EXCEPT the ownership challenge (which does not
   apply to a lost post). It SHALL NOT show drop-off/intake instructions, since a
   lost post is a passive notice, not an item the office holds.
1. WHEN a finder opens the "Log Item" view in **Found** mode THEN the system SHALL
   present a form with fields for caption, category, location found, a private
   note to staff, an optional ownership challenge, and a photo. The time found
   is recorded automatically as the time of posting.
1a. THE form SHALL use a single multi-line **Caption** field instead of separate
   title and description fields. On submit, the first non-empty line of the
   caption becomes the item's title and the remaining lines (trimmed) become its
   description, which may be empty. (No helper text is shown under the field.)
1b. THE location field SHALL offer the PUP campus places from the official
   vicinity map (the 50 numbered places, e.g. "Main Academic Building", "Ninoy
   Aquino Learning Resource Center", "Oval", "Lagoon Park") as suggestions: on
   focus it shows the list, typing filters it (case-insensitive, matching any
   part of the name), and picking one fills the field. The user MAY instead
   keep their own typed text; the field accepts any value. Arrow keys move
   through suggestions, Enter picks, Escape closes the list.
   WHILE typing, the caption's first line SHALL display bold (as the post title
   will) and the following lines in normal weight; Enter at the end of the
   first line continues on the next line, and Backspace at the start of the
   second line joins it back onto the first.
2. WHEN a finder submits the Found form THEN the system SHALL require the
   caption (non-empty), category, and location found before accepting the
   submission.
3. WHEN a finder submits a valid Found form THEN the system SHALL create an item
   with status `pending_intake`.
3a. WHEN the user submits the form in **Lost** mode THEN the system SHALL create an
   item with `kind: "lost"` that appears in the shared catalog alongside found
   items (so all users can see it), rather than a separate private notice. The
   catalog SHALL visually distinguish lost vs found posts (a "Lost"/"Found" tag).
   Lost items do not require the found-item custody steps.
4. WHEN a photo is selected THEN the system SHALL show a processing state
   while it re-encodes the image in the browser (canvas → WebP, falling back to
   JPEG, longest side capped at 1600px). Re-encoding drops all EXIF/GPS metadata,
   so only the re-encoded image is ever stored. IF the file cannot be decoded as
   an image THEN the system SHALL reject it with a clear message.
4a. THE photo area SHALL accept a photo either by clicking to pick a file or by
   dragging an image file onto it, in both Found and Lost mode. WHILE a file is
   dragged over it THE area SHALL highlight and read "Drop photo here". A
   dropped file goes through the same re-encode as a picked one; only the
   first file is used when several are dropped.
5. WHEN an item is created THEN the system SHALL confirm the log and instruct the
   finder to drop the item at the admin office to complete intake.
6. WHERE the private note field is used THE system SHALL treat it as
   staff-visible only and never display it in the public catalog.
7. WHERE the shared database is configured, IF the device is offline or the
   network request fails when the user submits the Log form THEN the system
   SHALL save the post in an on-device queue, confirm it as "saved — will post
   when you're back online", and show it in the poster's own catalog marked
   "Waiting to sync". The header SHALL show how many posts are waiting.
8. WHEN the device comes back online, the app is opened, or the browser fires a
   background-sync event THEN the system SHALL send the queued posts in order and
   remove each one once the server accepts it. IF the server rejects a queued
   post for a reason other than the network THEN the system SHALL remove it from
   the queue and tell the user it could not be posted.

### Requirement 2 — Item status state machine

**User story:** As staff, I want items to move through a fixed set of states, so
that custody and release are controlled and auditable.

#### Acceptance Criteria
1. THE system SHALL support exactly four item states: `pending_intake`,
   `in_office`, `approved_for_pickup`, and `released`.
2. WHILE an item is `pending_intake` THE system SHALL make it visible only to its
   finder and to staff, never in the public catalog.
3. WHEN staff mark an item `in_office` THEN the system SHALL make it visible in
   the public catalog.
4. WHEN a claim is approved THEN the system SHALL move the associated item to
   `approved_for_pickup` and keep it visible but marked as pickup-approved.
5. WHEN staff mark an item `released` THEN the system SHALL remove it from the
   active public catalog.
6. THE system SHALL allow only staff to advance an item's status.

### Requirement 3 — Public catalog

**User story:** As an owner, I want to browse and search items the office is
holding, so that I can find my lost item without a noisy social feed.

#### Acceptance Criteria
1. THE catalog SHALL display both found items (`kind: "found"`) and lost items
   (`kind: "lost"`) that are not `released`, to all users, each tagged with its
   kind. (Found items also follow the status visibility rules below.)
2. WHERE an item is `pending_intake` AND the current user is its finder THE
   catalog SHALL also display that item to the finder, visibly marked as
   "Pending Intake", so a freshly logged item reflects immediately for its
   poster. Other users SHALL NOT see `pending_intake` items.
3. WHEN a finder logs an item THEN the newly created `pending_intake` item SHALL
   appear in the finder's catalog immediately without a reload.
4. WHEN a user types in the search field THEN the system SHALL filter items by
   matching the query against title, description, and location (case-insensitive).
5. WHEN a user selects a category filter (located in the header, next to search)
   THEN the system SHALL show only items in that category, or all items when
   "All" is selected.
6. WHEN no items match the active search and filter THEN the system SHALL show an
   empty state with a "Clear filters" action that resets the search to empty and
   the category to "All".
7. THE search field SHALL live in the app header (Reddit-style, centered) and
   drive the catalog filtering; it SHALL display the typed text clearly.
8. Logging a found item is initiated from the header "+" button (Requirement
   11a); the catalog SHALL NOT show a separate composer prompt.
9. THE photo-centric grid is the **Gallery** view (Requirement 19). The mobile
   bottom bar's **Community** tab and the header's Gallery icon both open it,
   so it stays a photo grid at every screen width (resizing only re-flows its
   columns). The catalog (Feed) is always the post list and SHALL NOT show a
   Feed/Community toggle. The Community view SHALL
   prioritize item photos in a responsive gallery with minimal overlay (title,
   Lost/Found tag, location) to help owners rapidly scan visually for their lost
   belongings. Clicking any item in Community view SHALL open its full post detail.


### Requirement 4 — Item card presentation

**User story:** As a user, I want each catalog item shown as a clear post, so
that I can quickly scan who posted it, when, and what it is.

#### Acceptance Criteria
1. THE item card SHALL show the poster's name with a profile avatar and the
   relative post time.
2. WHERE the post is 7 days old or newer THE system SHALL show a relative label
   ("just now", "Nh ago", "Nd ago"); WHERE it is older than 7 days THE system
   SHALL show the full date (e.g. "Sep 14, 2026").
3. THE item card SHALL show a title, a description, and the found location. It
   SHALL NOT show a status icon (the post detail view doesn't either).
4. THE item card SHALL provide an action row with upvote, comment, repost, and
   share controls, aligned on a single row. Those controls SHALL be icon-only
   (with their count beside the icon): no border, outline, or fill. The active
   state (upvoted, reposted) is shown by the accent color.
5. WHERE the item is claimable by the current role THE system SHALL show a
   found-post action labeled **"I lost it"** (Requirement 16) or, on a lost post,
   **"I found it"** (Requirement 17), aligned to the bottom-right of the card.
   The button also shows to the post's author, for whom it opens the post
   detail on the ownership panel (claims / verification forms received).

### Requirement 5 — Item card actions (upvote, comment, repost, share)

**User story:** As a user, I want the upvote, comment, repost, and share controls
on an item card to actually work, so that I can engage with a post.

#### Acceptance Criteria

Upvote:
1. WHEN a user upvotes an item THEN the system SHALL increment the displayed count
   and mark the control as active.
2. WHEN a user removes their upvote THEN the system SHALL decrement the displayed
   count and clear the active state.
3. THE system SHALL treat upvotes as an engagement signal only, with no effect on
   item status.
3a. EACH user SHALL be able to upvote a post (item or repost) at most once. WHERE
   the shared database is configured THE displayed count SHALL include upvotes
   from all users and update live.

Repost (Facebook-style):
4. WHEN a user activates Repost on an item THEN the system SHALL open a dialog
   where the user can add an optional caption and confirm the repost.
5. WHEN the user confirms a repost THEN the system SHALL create a repost
   attributed to the user (with the optional caption), increment the item's
   displayed repost count, and mark the control as active.
6. WHERE the user has already reposted an item THE dialog SHALL let the user
   remove their repost; removing it SHALL decrement the count and clear the
   active state.
7. THE repost SHALL appear on the user's profile and also in the public
   catalog feed as a reposted card that quotes the original item and shows the
   reposter's caption (if any).
8. THE repost SHALL be an engagement signal only, with no effect on item status.
8a. A reposted card SHALL have its OWN action row — upvote, comment (with
    replies), and share — independent of the original item's counts and thread.
8b. WHEN a user activates Repost on a reposted card THEN the system SHALL repost
    the underlying original item (not the repost itself).
8c. WHEN a user activates the quoted original on a reposted card THEN the system
    SHALL open the original item's full-screen post detail (Requirement 5.11).

Share:
9. WHEN a user activates share THEN the system SHALL copy a link to that item to
   the clipboard and show a brief confirmation.
10. IF the clipboard is unavailable THEN the system SHALL still show the link so
    the user can copy it manually, without error.

Comment:
11. WHEN a user clicks a post (its body) OR activates the comment action THEN the
    system SHALL open a full-screen **post detail view** (Reddit-style), not a
    pop-up modal. The detail view SHALL render the full post (poster, tags,
    status, title, description, photo if any, found location/time), the item's
    action row, the comment thread with author and relative time, and a composer
    to add a comment. It SHALL provide a Back control to return to the previous
    view. Clicking the action buttons (upvote/repost/share/claim) SHALL NOT
    navigate into the detail view.
11a. THE comment composer SHALL let the commenter choose **Public** or
    **Private**. A public comment is visible to everyone. A **private** comment
    is a direct note to the post's author, visible only to the post author and
    the commenter (and hidden from all other users). A reply inherits the
    visibility of the thread it belongs to. The comment count SHALL reflect only
    the comments visible to the current user; private comments SHALL be labeled.
12. WHEN a user posts a comment THEN the system SHALL append it to the thread,
    attribute it to the signed-in user, and increment the displayed comment count.
13. THE comment count on the card SHALL reflect the actual number of comments,
    including replies.
14. WHERE there are no comments yet THE thread SHALL show an empty prompt inviting
    the first comment.

Reply (branching / nested):
15. WHERE any comment OR reply exists THE system SHALL offer a "Reply" action on
    it, at any nesting depth.
16. WHEN a user activates "Reply" on a comment or reply THEN the system SHALL
    reveal an input to reply to that specific node.
17. WHEN a user posts a reply THEN the system SHALL append it as a child of its
    parent node, indented one level deeper than the parent, attributed to the
    signed-in user with a relative time, and SHALL include it in the comment
    count.
18. THE reply tree SHALL support arbitrary depth (a reply to a reply to a reply,
    and so on), each level rendered progressively indented so the branching
    structure is visible.
19. THE post detail view SHALL render the full item's action row (upvote, repost,
    share), and those controls SHALL work the same as on the card. The "I lost
    it" / "I found it" button in the detail view SHALL open the inline form.
19a. BELOW the post, the detail view SHALL show a row with the comment count
    ("N comments") on the left and, where the user can act on the post or
    already has an ownership flow on it, an icon-only document button (no
    text, no outline) on the right. Both are clickable and switch what shows
    below the row: the comment count shows the comment thread; the document
    icon shows the ownership panel. The ownership panel is the inline form
    when the user can start one (the claim form on a found post, the finder's
    challenge-question form on a lost post), or otherwise the status/review of
    their existing flow (their claim or found report and its status; on the
    user's own lost post, the finders' reports with answer fields). Only one
    shows at a time; clicking the document icon again returns to the comments.
    The active control is shown in the accent color. The thread shows by
    default; the ownership panel shows when the view was opened from an "I
    lost it" / "I found it" action or from a notification about a report.
19b. WHERE the ownership panel holds something waiting on the current user —
    on their own lost post, a finder's report in `awaiting_owner`; on a lost
    post they reported, their report in `answered` (owner's answers to
    approve or reject); on their own found post, a claim in `pending` — THE document icon SHALL show an accent-colored dot,
    and the detail view SHALL open on the ownership panel instead of the
    comments. Where the item is eligible for action ("I found it" or "I lost it"),
    the action form SHALL be rendered inline directly below the post body and above
    the comment thread, so the user can see and reference the full post details
    while answering or challenging.

### Requirement 5b — My Profile (posts + reposts)

**User story:** As a user, I want to open my profile by clicking my profile
picture, so that I can view my account info and everything I've posted and
reposted in one place.

#### Acceptance Criteria
1. THE navigation SHALL NOT include separate "My Timeline" or "Profile" tabs;
   instead the profile picture (avatar) in the header SHALL open the profile when
   clicked.
2. THE Profile view SHALL show a header with the user's avatar, name, and email.
3. THE Profile view SHALL list the items the user has logged (their posts) and
   the items the user has reposted, newest first.
4. WHERE the user has no posts or reposts THE Profile SHALL show an empty state.
5. THE Profile SHALL provide a sign-out control.
6. WHEN the user removes a repost from the profile THEN it SHALL disappear from
   the profile and the catalog feed and the item's repost count SHALL decrement.

### Requirement 5c — Public Author Profile

**User story:** As a user, I want to click any poster or commenter's avatar, so
that I can view their public profile and see what else they have posted.

#### Acceptance Criteria
1. WHEN a user clicks on an avatar or author name on an item card, post detail,
   repost card, comment thread, or a verification form opened by the owner
   (which shows the finder's avatar next to their name) THEN the system SHALL
   open a public author profile view.
2. THE author profile view SHALL use the same layout as the user's own profile
   (Requirement 5b): a large profile photo, display name with the verified
   student badge (if verified), and a stats row (Posts, Reposts, Verified
   Yes/No). It SHALL NOT show the author's email, a sign-out control, or the
   student-verification form.
3. THE author profile view SHALL list the author's public posts and reposts,
   newest first, rendered as the same post cards used in the feed.
3a. EVERY avatar in the app SHALL show the person's Google profile photo when
   one is known, falling back to their initials. Each signed-in user's name and
   photo are saved to a shared profile record on sign-in so others can see
   them.
4. THE author profile view SHALL provide a Back control to return to the previous
   view without losing place.


### Requirement 6 — Submit a claim (Owner)

**User story:** As an owner, I want to privately claim an item with identifying
details, so that staff can verify it is mine without exposing me publicly.

#### Acceptance Criteria
1. WHERE an item is `in_office` AND the current role is not staff THE system SHALL
   offer a "Claim this item" action.
2. WHEN an owner submits a claim THEN the system SHALL require identifying details
   and create a claim with status `pending_review`.
3. WHEN a claim is created THEN the system SHALL confirm submission and indicate
   staff will follow up in the claim thread.
4. THE claim's identifying details SHALL be visible only to the owner and staff.
5. THE system SHALL communicate AND enforce a limit of 3 claims per rolling 24
   hours per user. A claim here is a "Prove it's yours" submission on a found
   post (Requirement 16), which is how owners claim items; claims that a finder
   escalates to staff do not count against the owner. IF the user already has 3
   claims in the last 24 hours THEN the
   system SHALL block the new claim with a message saying when they can claim
   again. WHERE the shared database is configured THE limit SHALL also be
   enforced server-side, so a modified client cannot bypass it.
6. WHERE the shared database is configured THE claims and their threads SHALL be
   stored in it, so staff on any device see every claim and the owner sees staff
   replies live.

> Note: the standalone "Claim this item" modal was superseded by "Prove it's
> yours" (Requirement 16) and removed. Staff claims now come only from a finder's
> "Send to staff"; criteria 1–4 apply to those claims.

### Requirement 16 — Ownership Challenge ("Prove it's yours")

**User story:** As a finder, I want to attach my own verification questions to a
found item (e.g. "What's the serial number?", "What color is it?"), so that a
person claiming it must prove ownership by answering, and I can review who
answered and decide — or hand the decision to staff.

#### Acceptance Criteria
1. WHEN logging a found item THE system SHALL let the finder optionally add an
   **Ownership Challenge**: an ordered list of short-text questions (each a free
   prompt), with add/remove controls. The challenge is optional. On the Log
   form it uses the same verification-form builder as Requirement 17.2: a
   dashed "Create verification form" card that opens the builder card (sample
   question, text + pen edit-in-place, answer-box preview, ✕, "+ Add
   question"), with a **Remove** control that discards it and returns to the
   dashed card.
2. EVERY found item card SHALL show a **"Prove it's yours"** action (for non-staff
   users). Activating it opens the prove-ownership form:
   - WHERE the item HAS an Ownership Challenge, the form SHALL render the finder's
     questions with a short-text answer field per question, plus an optional
     free-text **note to the finder**.
   - WHERE the item has NO Ownership Challenge, the form SHALL show only the
     optional **note to the finder** (no questions).
3. WHEN a claimant submits their answers THEN the system SHALL record a
   **challenge response** attributed to the signed-in user (name + answers +
   optional note + timestamp) with status `pending`, and SHALL confirm
   submission.
4. THE finder SHALL see the responses to their own item's challenge in that
   post's detail view, under the document icon (Requirement 5.19a): one
   rectangular card per claim (responder photo and name, number of answers,
   status, relative time; pending ones marked), and activating a card opens it
   with the responder's photo (opens their profile), name, verified badge if
   applicable, each question with their answer in a read-only answer box, and
   their optional note. The Profile does not show a separate "Responses"
   button. Responses SHALL be visible only to the
   finder and staff, not to other users.
5. FOR each response THE finder SHALL be able to **Approve** (this is the owner),
   **Reject**, or **Send to staff** (escalate to the normal staff claim review).
6. WHEN the finder approves a response THEN the system SHALL mark that response
   `approved`; approval is the finder's decision and does not itself release the
   item — physical release still happens at the office.
7. WHEN the finder chooses "Send to staff" THEN the system SHALL create a claim
   (Requirement 6) carrying the response's answers as its identifying details,
   with status `pending_review`, so staff can make the final decision.
8. WHERE an item has no Ownership Challenge, "Prove it's yours" still applies but
   collects only the note; the response has no answers. The finder reviews and
   decides (or sends to staff) the same way.
9. WHERE the post is a **lost** item (`kind: "lost"`) THE system SHALL NOT show
   "Prove it's yours"; instead it SHALL show **"I found this"** (Requirement 17).

### Requirement 17 — "I found this" on a lost post (finder verifies the owner)

**User story:** As someone who found an item that another user reported lost, I
want to reach out and verify they are the real owner by asking my own questions,
so I can safely return it.

#### Acceptance Criteria
1. WHERE a post is a lost item THE system SHALL show an **"I found this"**
   action on its card, including to the post's own author. For the author it
   opens the post detail on the ownership panel (the verification forms they
   received) instead of starting a report.
2. WHEN a user activates "I found this" THEN the system SHALL open a form where
   the finder authors **their own challenge questions** (short text) and an
   optional **note**, then submits a **found report** with status
   `awaiting_owner`. In the post detail's ownership panel (Requirement 5.19a)
   this is a two-step builder:
   - First the panel shows a single rectangular **"Create verification form"**
     button. Activating it opens the builder in the same panel.
   - The builder opens with one sample question already added: "What is the
     color of the item?". Each question is shown as numbered plain text (not an
     input) followed by a pen (edit) icon, with a small, non-editable answer
     box under it previewing where the owner will answer, and a remove (✕)
     control on the right.
   - Activating the pen makes the question text editable in place, with no
     visible input box (only a caret, like typing a chat message). Enter or
     leaving the text saves; Escape cancels; saving empty text keeps the
     previous question.
   - A **"+ Add question"** link (no input box) appends a new numbered question
     already in that in-place edit mode; if it's saved empty (or Escape is
     pressed) the new question is removed.
   - An optional note to the owner, then **Send to owner** (disabled until at
     least one question is added) and **Cancel** (back to the first step,
     discarding the draft).
3. WHEN a found report is submitted THEN the system SHALL notify the lost post's
   **owner** (Requirement 18) that someone found their item and needs them to
   answer to verify.
4. WHEN the owner opens the found report THEN the system SHALL show the finder's
   questions with answer fields; the owner fills the answers and submits, moving
   the report to `answered`. In the post detail's ownership panel the owner
   first sees one rectangular card per received verification form (finder
   name, number of questions, status, relative time; cards needing an answer
   are marked). Activating a card opens that form in the same panel: each
   question as plain text with an answer field under it, an optional note to
   the finder, and **Submit answers**, plus a back control to the list of
   cards. Answered, approved, or rejected forms open read-only with the
   answers given. WHERE a report has no questions (sent before
   questions were required) THE system SHALL show the finder's note as the
   prompt and a required "Your answer" field, stored as the owner's note.
5. WHEN the owner answers THEN the system SHALL notify the **finder** that the
   owner responded.
6. WHEN the finder reopens "I found this" (or the report from a notification)
   THEN the system SHALL show the owner's submitted answers, and let the finder
   **Approve** (→ `approved`) or **Reject** (→ `rejected`).
7. THE found report SHALL be visible only to the finder who created it and the
   lost post's owner.
8. THE post detail view SHALL show the report flow for the current user in the
   ownership panel under the document icon (Requirement 5.19a):
   the lost post's owner sees each report with answer fields while it is
   `awaiting_owner`; the finder sees their report's status and, once `answered`,
   the owner's answers with Approve / Reject. Opening a notification about a
   report opens this post detail. A user who already has a report or ownership
   claim on a post SHALL see its status instead of a new blank form.
9. IN every status, the reporter's view of their own found report SHALL show
   what they submitted in the same form layout they built: each question as
   numbered text with a read-only answer box under it, holding the owner's
   answer once given or a muted "Waiting for the owner's answer" until then,
   followed by their note, if any. The same layout is used wherever submitted
   answers are shown read-only.
   Likewise a claimant's view of their own ownership claim on a found post
   SHALL show each question with the answer they gave and their note.

### Requirement 18 — Notifications

**User story:** As a user, I want to be notified when there's activity that needs
me (someone found my lost item, or an owner answered my questions), so I can act.

#### Acceptance Criteria
1. THE system SHALL create a notification for the relevant recipient when: a
   found report is submitted on their lost post; the owner answers a found
   report's questions; or the finder approves/rejects a found report.
2. THE app SHALL provide a **Notifications** view listing the current user's
   notifications newest-first, each with a message and relative time, and a way
   to open the related post.
3. THE navigation SHALL show a notifications control with an **unread count**
   indicator; opening the Notifications view SHALL mark them read.

### Requirement 19 — Gallery view (photo-centric catalog mode)

**User story:** As an owner searching for a lost item, I want a photo-grid view
of all posts so I can quickly scan by image without reading every caption.

#### Acceptance Criteria
1. THE app SHALL provide a **Gallery** view alongside the Catalog, opened from
   the header's Gallery icon on wide screens (Requirement 11a.7).
2. THE Gallery SHALL display items that have photos in a responsive masonry
   grid, photo-first, with minimal text overlay (Found/Lost tag + title only).
   The number of columns SHALL follow the screen width and re-flow live when
   the window is resized: 2 columns on phones, 3 from 640px, 4 from 1024px,
   and 5 from 1280px, with the grid using the wider page width on desktop.
3. WHERE an item has no photo it SHALL be omitted from the Gallery.
4. WHEN a user taps a gallery tile THEN the system SHALL open the full-screen
   post detail for that item.
5. THE Gallery SHALL respect the same visibility rules as the Catalog.

### Requirement 7 — Private claim thread

**User story:** As an owner and as staff, I want a private message thread scoped
to a claim, so that verification happens without public exposure.

#### Acceptance Criteria
1. THE system SHALL scope each message thread to a single claim.
2. THE thread SHALL be visible only to the claim's owner and to staff.
3. WHEN an owner or staff member posts a reply THEN the system SHALL append it to
   the thread with the sender's role.

### Requirement 8 — Staff dashboard

**User story:** As staff, I want queues for pending intake and claims to review,
so that I can process the office workflow efficiently.

#### Acceptance Criteria
1. THE staff dashboard SHALL provide a pending-intake queue and a claims-to-review
   queue.
2. WHEN staff confirm custody of a pending-intake item THEN the system SHALL allow
   moving it to `in_office`.
3. WHEN staff open a claim THEN the system SHALL show the identifying details, the
   message thread, and controls to approve or reject the claim.
4. WHEN staff approve a claim THEN the system SHALL set the item to
   `approved_for_pickup`.
5. WHEN staff reject a claim THEN the system SHALL set the claim status to
   rejected without changing the item status.

### Requirement 9 — Missing notices (passive bulletin)

**User story:** As an owner, I want to post a passive "still missing" notice, so
that there is a record even if the item has not been turned in.

> Superseded: lost items are now posted as catalog items with `kind: "lost"`
> (Requirement 1.3a / Requirement 3) and are visible to all users in the shared
> catalog. The separate "Missing" tab / passive-notice model has been removed;
> the criteria below are retained for historical context only.

#### Acceptance Criteria (historical — superseded by kind:"lost")
1. THE system SHALL allow an owner to post a missing notice with title, category,
   description, location lost, time lost, an optional private note to staff, and
   an optional photo.
2. THE missing-notice feature SHALL have no state machine, claim, or message
   thread attached.
3. WHEN a missing notice is posted THEN the system SHALL display it in the missing
   list with its relative post time.

### Requirement 10 — Google authentication and user accounts

**User story:** As a campus user, I want to sign in with my Google account, so
that my identity is tied to the items I log and the claims I make without
managing a separate password.

#### Acceptance Criteria
1. WHEN an unauthenticated user opens the app THEN the system SHALL present the
   public landing page (Requirement 10a) and SHALL NOT expose the catalog,
   finder form, claims, or staff views until sign-in completes. The landing page
   SHALL provide a call to action that opens the sign-in screen with a "Continue
   with Google" option.
2. WHEN a user chooses "Continue with Google" THEN the system SHALL start the
   Google OAuth flow and, on success, establish an authenticated session.
3. WHEN authentication succeeds THEN the system SHALL create or load a user
   account keyed on the Google identity and SHALL make the user's display name
   and avatar available to the app.
4. WHERE an authenticated user has posted items or claims THE system SHALL
   associate those records with that user's account id.
5. WHEN an authenticated user selects "Sign out" THEN the system SHALL end the
   session and return to the sign-in screen.
6. WHILE a session is active THE system SHALL persist it across page reloads and
   restore the authenticated state on return.
7. IF the Google OAuth flow fails or is cancelled THEN the system SHALL return
   the user to the sign-in screen with a clear, non-technical error message and
   no session.
8. THE system SHALL derive the user's role from their account rather than a
   manual selector; WHERE no staff role is assigned THE account SHALL default to
   a standard (finder/owner) user.
9. THE staff role SHALL be assigned through a staff roster keyed by email address,
   kept in the database and editable only by a database administrator (not from
   the app). WHEN a user signs in THEN the system SHALL look up the roster and
   grant the staff role if their email is on it. WHERE Supabase is not configured
   THE roster SHALL come from the `VITE_STAFF_EMAILS` build variable
   (comma-separated), for local demos only.

> Note: Requirement 11 ("Role-based navigation (demo)") describes the interim
> demo role selector. Once Requirement 10 is implemented, the demo selector is
> retired and role is derived from the authenticated account (see criterion 8).

### Requirement 10a — Public landing page

**User story:** As a first-time visitor, I want a landing page that explains what
FoundIt is and how it works, so that I understand the service and can decide to
sign in.

#### Acceptance Criteria
1. WHEN an unauthenticated user opens the app THEN the system SHALL show a landing
   page as the default view for signed-out users, before the sign-in screen.
2. THE landing page SHALL present the FoundIt brand (wordmark), a short tagline,
   and a brief explanation of the trusted lost-and-found workflow (log → staff
   verify custody → owner claims privately → staff release).
3. THE landing page SHALL provide a primary call to action ("Get started" /
   "Sign in") that navigates to the sign-in screen.
4. WHEN the user is on the sign-in screen THEN the system SHALL provide a way to
   return to the landing page (a back control).
5. THE landing page and sign-in screen SHALL NOT expose any authenticated views
   or private data; only after successful sign-in SHALL the app views render.
6. WHILE the user is signed in THE landing page SHALL NOT be shown; the app SHALL
   render the authenticated experience directly.

### Requirement 11 — Role-based navigation (demo)

**User story:** As a demo user, I want to switch roles, so that I can exercise the
finder, owner, and staff experiences.

#### Acceptance Criteria
1. THE navigation SHALL expose a role selector for finder, owner, and staff.
2. WHEN the role changes THEN the system SHALL show only the navigation
   destinations permitted for that role and reset the view to the catalog.
3. THE catalog SHALL be available to all roles; "Log Item" and "Missing" to
   finder and owner; "My Claims" to owner; and "Staff" to staff.

### Requirement 11a — Header layout (Reddit-style)

**User story:** As a user, I want a clean top header, so that search and my
account are always reachable.

#### Acceptance Criteria
1. THE header SHALL show, left to right: the brand/logo, the search control,
   and on the right a "+" create icon-button, a Gallery (grid) icon-button, the
   notifications bell, and the user's profile avatar. There is no hamburger
   menu or sidebar.
2. THE "+" button SHALL open the Log Found Item form and SHALL NOT show a
   "Create" text label; it is icon-only.
3. THE header SHALL NOT include a chat/messages icon. On wide screens it SHALL
   show the notifications bell with the unread count (Requirement 18.3).
4. WHEN the user clicks the avatar THEN the system SHALL open the profile.
5. THE header search SHALL be the single source of the catalog search query, and
   a category filter (All, Electronics, …) SHALL sit next to the search field in
   the header and drive the catalog filtering.
6. ~~Left sidebar with navigation destinations~~ — removed. Navigation is the
   header (brand → catalog, search, "+", Gallery, bell, avatar) on wide
   screens and the bottom tab bar (9) on narrow screens. The "My Claims" view
   is removed.
7. THE Gallery icon-button SHALL sit directly after "+" and open the Gallery
   (Requirement 19), highlighted in the accent color while the Gallery is open.
   Like "+", it is shown on wide screens only; on narrow screens the bottom
   bar's Community tab covers the photo grid.
8. ~~Sidebar role filtering~~ — removed with the sidebar.
9. ON narrow screens (below 768px) THE app SHALL show a fixed bottom tab bar with,
   left to right: **Feed**, **Community**, a wide rectangular soft-black **+** button,
   **Alerts**, and **Profile**. Tabs are icon-only (no visible text label);
   each keeps its name as an accessible label.
   - Feed opens the catalog; Community opens the Gallery (Requirement 3.9).
   - "+" opens the Log a Found/Lost Item form. WHERE the user is staff (who
     don't log items) THE "+" button SHALL be omitted.
   - Alerts opens Notifications and shows the unread count as a badge.
   - Profile opens the user's profile.
   - The current tab SHALL be highlighted in soft black (`#3A3A3A`); the others
     use grey (`#6B7280`).
   - On narrow screens the header's "+", Gallery, bell, and avatar SHALL be
     hidden (the bottom bar replaces them); the brand and search stay.
   - The bar SHALL respect the device's bottom safe area, and page content SHALL
     not be hidden behind it.
   - Full-screen overlays (post detail, author profile) cover the bar.

### Requirement 12 — AI caption import on the Log Item form

**User story:** As a finder, I want to paste the text/caption of an existing post
(e.g. a Facebook lost-and-found post) and have the log form filled in
automatically, so that I don't have to re-type the details.

> Note: This revises the earlier "AI/agent features: none in v1" stance. v1 now
> includes this one text-structuring AI assist. Image-based AI matching remains
> out of scope.

#### Acceptance Criteria
1. THE Log Found Item form SHALL provide a text area to paste a post caption and
   a "Fill from caption" action.
2. WHEN the user pastes caption text and triggers "Fill from caption" THEN the
   system SHALL structure the text into the form fields it can infer: the
   caption (inferred title as its first line, followed by the description),
   category (mapped to the app's existing category list), and location found.
2a. ~~Default the "When did you find it?" field to now~~ — superseded: the Log
   form has no time field; the time is recorded as the moment of posting.
3. WHILE the caption is being processed THE system SHALL show a processing
   state and SHALL disable the action to prevent duplicate requests.
4. WHEN structuring completes THEN the system SHALL populate the corresponding
   fields and SHALL leave them fully editable so the user can review and correct
   before submitting.
5. THE system SHALL NOT auto-submit; the user always confirms via the normal
   "Log found item" action.
6. THE photo SHALL NOT be inferred from caption text; the user adds it via the
   existing upload control.
7. WHERE the AI service is unavailable or not configured THE system SHALL fall
   back to a local best-effort parser so the feature still fills what it can,
   and SHALL surface a clear message if nothing could be extracted.
8. THE AI provider key SHALL never be exposed in the client; the call SHALL be
   made through a backend function that holds the key as a secret.

### Requirement 14 — Client-side persistence (prototype)

**User story:** As a user of the prototype, I want the items, claims, notices, and
my interactions to survive a page reload, so that I don't lose what I logged.

#### Acceptance Criteria
1. WHEN the user creates or changes application data (items, claims, missing
   notices, comments, reposts, upvotes) THEN the system SHALL persist that data
   to the browser's `localStorage`.
2. WHEN the app loads THEN the system SHALL restore any previously persisted data
   from `localStorage` so it is present after a reload.
3. WHERE no persisted data exists THE app SHALL start from its default empty
   collections.
4. WHERE persisted data is malformed or cannot be parsed THE app SHALL fall back
   to the default collections without crashing.
5. THE persistence layer SHALL be scoped under a versioned storage key so that a
   future Supabase data layer can supersede it without collision.
6. THE persisted data SHALL be limited to the prototype's non-auth application
   state; the authenticated session remains managed by the auth layer.

### Requirement 15 — Student verification and verified badge (AI-assisted)

**User story:** As a campus user, I want to verify that I'm a real student by
submitting my student ID or Certificate of Registration (COR), so that a
"Verified student" badge appears next to my name and others can trust me.

> Note: This is a second AI assist (see Requirement 12), using Gemini Vision to
> read the document. AI is a *signal*, not the sole authority: it does not detect
> forgery or prove the document belongs to the submitter, so ambiguous cases fall
> back to staff review, and staff can always override the AI decision. Facial or
> biometric matching of a person against their ID is explicitly out of scope.

#### Acceptance Criteria
1. THE profile SHALL show the user's verification status: `unverified`,
   `pending`, `verified`, or `rejected`, and — when unverified or rejected —
   provide a way to submit a document.
2. WHEN a user submits a document THEN the system SHALL let them pick a document
   type (Student ID, Certificate of Registration, or Class schedule) and select
   an image, then request an AI review.
3. WHEN the document is reviewed THEN the system SHALL extract structured fields
   (document type, name, student number, school, term validity) and return a
   confidence score and a pass/fail verdict.
4. WHERE the AI verdict is a pass with high confidence AND the extracted name is
   consistent with the signed-in account name THE system SHALL mark the user
   `verified`. The decision is fully automated; there is no staff review step.
5. WHERE the AI verdict is low-confidence, fails, or the name does not match THE
   system SHALL mark the submission `rejected` and let the user try again with a
   clearer document.
6. WHEN a user is `verified` THEN the system SHALL display a "Verified student"
   badge next to their name on their posts, claims, comments, and profile.
7. WHERE the AI service is unavailable or not configured THE system SHALL report
   that verification is temporarily unavailable and SHALL NOT verify the user
   (no fallback approval).
8. THE AI provider key SHALL never be exposed in the client; the review SHALL run
   in a backend function that holds the key as a secret (as with Requirement 12).
9. THE prototype SHALL NOT persist the raw uploaded document image; it SHALL
   store only the verification decision, the extracted fields, and the
   confidence. (Encrypted document storage, access control, and a retention /
   deletion policy are Supabase-phase concerns.)

> Note: This is intentionally AI-only. Because item *release* is still gated by
> in-person staff custody checks, a mis-verified badge is low-risk. There is no
> `pending` state and no staff verification queue.

---

## Future-phase requirements

These come from the original architecture. Struck-through items are now
implemented.

1. ~~Client-side EXIF/GPS strip and WebP re-encode of photos~~ — implemented
   (Requirement 1.4). Photos are stored as data URLs, not in Supabase Storage.
2. ~~Row-Level Security enforcing finder/owner/staff isolation~~ — implemented
   (migrations 0001–0005, `is_staff()`).
3. ~~Rate limiting of 3 claims per rolling 24 hours enforced server-side~~ —
   implemented as a database trigger (Requirement 6.5).
4. ~~Full audit trail (who changed what, when, old → new) on items and claims~~ —
   implemented as triggers writing `audit_logs`, readable by staff only.
5. ~~Offline logging with Background-Sync replay for finder intake~~ —
   implemented (Requirement 1.7–1.8).
6. ~~PWA shell (installable, offline caching)~~ — implemented (`public/sw.js`,
   `manifest.webmanifest`).

## Out of scope (v1)
Push notifications, student-to-student chat, interactive campus maps, AI photo
matching, and university SSO.
