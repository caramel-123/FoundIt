# UX rules

Constraints the user set on FoundIt. Apply them unless told otherwise.

## Controls

- Action rows (upvote, comment, repost, share) are icon-only with the count beside the icon. No border, no outline, no fill.
- Primary action buttons are flat soft black with white text, no outline.
- Bottom navigation and top bar use icons only, no text labels. Header create is a plain "+" beside search, no circle and no colored box behind it.
- Secondary tools that appear once (edit, delete, generate, import) are a bare icon, not a boxed button.
- Edit and delete live behind a single pen icon in the post detail only, and only for the author.
- Submit buttons say "Submit", not "Submit answer".

## Layout

- No boxed stats blocks on profiles. Show a single meaningful number (total upvotes) as an icon plus count to the right of the name.
- Sections are separated by full-bleed grey dividers, not by boxes.
- Same kind of card gets the same size everywhere. If two cards sit in the same slot in different modes, they match.
- Remove filler and hint text unless it prevents an error.
- No headings that restate the obvious (for example a "Forms (1)" heading above one form).

## Composer

- One caption field. The first line renders bold as the title.
- Location is a suggestion list from the real campus places. Category is an icon beside location.
- Drop the time field when the post time is enough.
- Import or generate helpers open as a pop-up dialog over a dimmed backdrop, not inline.

## Status and time

- Show status with an icon and tooltip on cards, not a text label.
- Timestamps and sent times are grey, not accent colored.
- Show the sent time instead of an "ANSWER" style label.

## People

- Any author avatar that creates content (post, form) is tappable and opens that person's full profile page.

## Mobile shell

- Phone status bar and theme color match the page background (white), in both `index.html` and the manifest.
- Do not cache the manifest in the service worker.

## Process

- Screenshot-led. When the user points at something, change that one thing.
- Do not add unrequested features. Do not bring up out-of-scope roles or dashboards.
- Update the spec first, then code. The user commits.
