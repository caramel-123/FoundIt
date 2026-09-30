# FoundIt Build Guide

Campus lost-and-found for PUP. React 19, Vite, TypeScript, Tailwind CSS v4,
Supabase (auth, Postgres with RLS, realtime, Edge Functions), PWA with an offline
queue. Read `AGENTS.md`, then `.kiro/specs/campus-lost-found/`, then `design/`.

## Commands

```
npm install
npm run dev      # Vite dev server
npm run build
npm test         # node --test src/**/*.test.ts (21 tests)
```

## Environment (`.env`)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_STAFF_EMAILS` (optional)

With no Supabase keys the app runs on a localStorage mock, so it works unconfigured.

Edge Function secret (set on Supabase, never in the client):

```
supabase secrets set GEMINI_API_KEY=your_key
```

Used by `parse-caption` and `verify-student`; both have a local fallback.

## Database

Migrations in `supabase/migrations/`, run in order in the Supabase SQL editor.
Applied: 0001 to 0007. **Not applied: 0008_items_delete.sql** (lets authors delete
their own posts).

## Where things are

- `src/App.tsx` main UI (single large file)
- `src/lib/` db, auth, image re-encode, campus places, caption heuristic, comments,
  time, claim limit, offline queue, student verify
- `public/sw.js` service worker (cache `foundit-v3`), `public/manifest.webmanifest`
- `.kiro/specs/campus-lost-found/` requirements, design, tasks
- `design/tokens.md`, `design/ux-rules.md` UI source of truth

## Rules

- Update the spec before changing behavior.
- Follow `design/ux-rules.md` for every UI change.
- Change only what is asked. Do not commit unasked.

## Design assets

Figma design file "FOUNDIT" (key `vuy6t1N7h94DwsJSQqiwt8`) and the Slides mockup deck
(key `z7TuLgPnpdywZeERJ5GNdl`). Screen captures are taken by the AI following `design/screens/README.md` (phone viewport, browser tool). The user does not capture them.
