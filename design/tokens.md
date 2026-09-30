# Tokens

## Color

| Token | Value | Use |
|---|---|---|
| ink | #3A3A3A | All "black": text, primary buttons, tags, dots. Never pure black |
| grey | #6B7280 | Secondary text, icons |
| hint | #9CA3AF | Timestamps, placeholders |
| body | #4B5563 | Long text |
| card | #F7F7F8 | Card and input fill |
| subtle | #F2F2F2 | Hover, quiet fills |
| chip | #ECECEE | Chips, inactive tags |
| divider | #E5E5E5 | Full-bleed rules |
| dashed | #D1D5DB | Dashed drop zones |
| page | #FFFFFF | Page, surface, phone status bar |
| rust | #9A3F3F | Single accent, wordmark, lost tag text |
| terracotta | #C1856D | Accent detail |
| sand | #E6CFA9 | Soft highlight |
| sand-text | #5C2020 | Text on sand |
| lost-bg | #F5ECEC | Lost tag fill |

Text and icons on rust fills are white. One accent only, no competing colors.

## Type

- System font stack (SF Pro on Apple, Segoe UI on Windows, Roboto on Android). Download nothing.
- Only the wordmark uses a display font (Momo Trust Display).
- Tight leading on headings. `tabular-nums` on counts.

## Shape

- Radii 8 for controls, 12 for cards, full for avatars and pills.
- Cards use a fill (#F7F7F8), no border, no shadow.
- Dividers run edge to edge (full bleed), 1px #E5E5E5.

## Motion

- 150 to 200ms, color, transform and opacity only.
- Pressed state moves 1px down. Hover is a subtle fill shift.
- Visible focus ring for keyboard users, never removed without a replacement.

## Icons

- Grey, rounded, 2px line icons in one consistent set.
- Active state is darker or filled, never boxed or circled.
