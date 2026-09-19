# System Design Document — Campus Lost & Found

*This SDD incorporates the detailed architecture already specified by the
requester almost verbatim — it was effectively delivered as a near-complete
SDD/implementation meta-prompt. Phase 2 scaffolding follows this directly.*

## Architecture overview
- **Frontend:** React (Vite) + TypeScript + TailwindCSS, shipped as an
  installable PWA (`display: "standalone"`).
- **Backend:** Supabase — Postgres (schema + RLS + triggers), Auth (JWT
  with custom `role` claim: finder/owner/staff — in practice every user
  can act as finder or owner; `staff` is an elevated claim), Storage
  (item photos), Edge Functions (claim rate limiting).
- **Offline layer:** Dexie.js over IndexedDB for local reads/cache;
  Workbox + `workbox-background-sync` for queued, replayed mutations.

## Components and why
- **Vite PWA Plugin** — generates/injects the manifest and service
  worker build step, keeps icon/manifest compliance automated rather
  than hand-maintained.
- **Workbox** — abstracts Service Worker routing/caching strategy
  selection instead of hand-rolled `fetch` interception.
- **Dexie.js** — ergonomic wrapper over raw IndexedDB for the offline
  read cache and mutation queue.
- **Supabase/PostgREST** — the DB is directly exposed to the client, so
  authorization must live in the database (RLS), not app middleware —
  this shapes almost every other decision below.
- **Canvas API (client)** — sole mechanism for photo sanitization; it
  decodes pixels only and cannot read/retain EXIF/IPTC/XMP, giving a
  structural (not policy-based) privacy guarantee.

## Data model

```sql
create type item_status as enum
  ('pending_intake', 'in_office', 'approved_for_pickup', 'released');
create type claim_status as enum
  ('pending_review', 'rejected', 'approved');

create table items (
  id uuid primary key default gen_random_uuid(),
  finder_id uuid not null references auth.users(id),
  category text not null,
  location_found text not null,
  time_found timestamptz not null,
  description text not null,
  private_note text,                 -- finder->staff only, never public
  status item_status not null default 'pending_intake',
  image_url text,
  upvotes integer not null default 0,
  created_at timestamptz not null default now()
);

create table missing_notices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  description text not null,
  location_lost text not null,
  time_lost timestamptz not null,
  image_url text,
  created_at timestamptz not null default now()
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  owner_id uuid not null references auth.users(id),
  identifying_details text not null,
  status claim_status not null default 'pending_review',
  created_at timestamptz not null default now()
);

create table claim_messages (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id),
  sender_id uuid not null references auth.users(id),
  message text not null,
  created_at timestamptz not null default now()
);

create table item_upvotes (
  item_id uuid not null references items(id),
  user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

create table audit_logs (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id uuid not null,
  action text not null,               -- TG_OP
  performed_by uuid,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[],
  created_at timestamptz not null default now()
);
```

### State machine (`items.status`)
| State | Meaning | Public visibility |
|---|---|---|
| `pending_intake` | Finder logged it, not yet physically surrendered | Finder only |
| `in_office` | Staff verified custody | Public catalog |
| `approved_for_pickup` | Owner's claim verified by staff | Public, locked |
| `released` | Physical handover complete | Archived, drops from feed |

`missing_notices` deliberately has **no** state machine, claim, or chat —
pure passive bulletin. If a missing item later shows up in `items`, the
owner abandons the notice and files a real `claims` row against the
catalog item instead.

## RLS policies

Every user-supplied predicate is wrapped in a scalar subquery
(`(select auth.uid())`) rather than a bare `auth.uid() = col`, so the
planner evaluates it once per query (`initPlan`) instead of once per row.

```sql
create or replace function is_staff()
returns boolean
language sql
stable
leakproof
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_members sm
    where sm.user_id = (select auth.uid())
  );
$$;

-- items
alter table items enable row level security;

create policy items_finder_insert on items
  for insert to authenticated
  with check (
    finder_id = (select auth.uid())
    and status = 'pending_intake'
  );

create policy items_finder_select_own on items
  for select to authenticated
  using (finder_id = (select auth.uid()));

create policy items_public_select_active on items
  for select to authenticated
  using (status in ('in_office', 'approved_for_pickup'));

create policy items_staff_all on items
  for all to authenticated
  using (is_staff())
  with check (is_staff());

-- missing_notices
alter table missing_notices enable row level security;

create policy missing_notices_owner_insert on missing_notices
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy missing_notices_public_select on missing_notices
  for select to authenticated
  using (true);

-- claims
alter table claims enable row level security;

create policy claims_owner_insert on claims
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy claims_owner_select_own on claims
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy claims_staff_all on claims
  for all to authenticated
  using (is_staff())
  with check (is_staff());

-- claim_messages
alter table claim_messages enable row level security;

create policy claim_messages_owner_rw on claim_messages
  for select to authenticated
  using (
    exists (
      select 1 from claims c
      where c.id = claim_messages.claim_id
        and c.owner_id = (select auth.uid())
    )
  );

create policy claim_messages_owner_insert on claim_messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from claims c
      where c.id = claim_messages.claim_id
        and c.owner_id = (select auth.uid())
    )
  );

create policy claim_messages_staff_all on claim_messages
  for all to authenticated
  using (is_staff())
  with check (is_staff());
```

`is_staff()` reads a `staff_members(user_id)` table via `SECURITY DEFINER`
so it bypasses recursive RLS on that lookup table itself; `STABLE` lets
the planner cache it per statement; `LEAKPROOF` keeps the planner free to
push index scans ahead of the filter instead of defensively sequential-
scanning.

## Indexing strategy

```sql
-- Leftmost-prefix composite: equality (status) first, sort (created_at) second
create index idx_feed on items (status, created_at desc);

-- Partial index: only ~5% of rows (in_office) ever need to be fast here;
-- rows fall out for free the moment status flips to released
create index idx_active_items on items (category, created_at desc)
  where status = 'in_office';
```

## Upvote concurrency
`item_upvotes` is a separate table with a `(item_id, user_id)` primary
key (idempotent — one vote per user per item, no row-lock contention on
`items` itself). A trigger on `item_upvotes` insert asynchronously
increments a materialized `items.upvotes` counter, so the public feed
read path never runs `count()`.

```sql
create or replace function bump_item_upvotes()
returns trigger
language plpgsql
as $$
begin
  update items set upvotes = upvotes + 1 where id = new.item_id;
  return new;
end;
$$;

create trigger trg_bump_upvotes
  after insert on item_upvotes
  for each row execute function bump_item_upvotes();
```

## Audit trail

```sql
create or replace function audit_log_changes()
returns trigger
language plpgsql
security definer
as $$
declare
  changed text[] := '{}';
  k text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(to_jsonb(new))
    loop
      if to_jsonb(old) -> k is distinct from to_jsonb(new) -> k then
        changed := array_append(changed, k);
      end if;
    end loop;
  end if;

  insert into audit_logs
    (table_name, record_id, action, performed_by,
     old_data, new_data, changed_fields)
  values (
    tg_table_name,
    coalesce(new.id, old.id),
    tg_op,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE','INSERT') then to_jsonb(new) end,
    nullif(changed, '{}')
  );

  return coalesce(new, old);
end;
$$;

create trigger trg_audit_items
  after insert or update or delete on items
  for each row execute function audit_log_changes();

create trigger trg_audit_claims
  after insert or update or delete on claims
  for each row execute function audit_log_changes();
```

`performed_by` reads `request.jwt.claim.sub`, the Supabase-set session
variable carrying the authenticated user's id through PostgREST's
connection pool — `current_user` alone would just show the generic
pooled API role.

## Client-side EXIF stripping

```ts
// src/lib/processAndStripImage.ts
export async function processAndStripImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/webp',
      0.8
    );
  });
}
```

Canvas re-decodes pixels only — EXIF/GPS/IPTC/XMP containers cannot
survive the round trip through `toBlob()`. WebP at quality 0.8 is the
default: ~25–35% smaller than JPEG at negligible visual cost, and
cheaper to encode client-side on older mobile hardware than AVIF.

## PWA / offline configuration

Caching strategy by asset class:

| Asset | Strategy | Why |
|---|---|---|
| App shell (HTML/CSS/JS) | Stale-While-Revalidate | instant paint, background refresh |
| Static assets (icons/fonts) | Cache-First | immutable, avoid network entirely |
| Live catalog feed (GET) | Network-First | freshness first, cached fallback offline |
| Mutations (POST/PUT/DELETE) | Network-Only + Background Sync queue | never cache a write; queue and replay instead |

```ts
// vite.config.ts (excerpt)
import { VitePWA } from 'vite-plugin-pwa';

export default {
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Campus Lost & Found',
        short_name: 'Lost & Found',
        display: 'standalone',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: ({ request }) =>
              ['style', 'script', 'document'].includes(request.destination),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'app-shell' },
          },
          {
            urlPattern: ({ request }) =>
              ['image', 'font'].includes(request.destination),
            handler: 'CacheFirst',
            options: { cacheName: 'static-assets' },
          },
          {
            urlPattern: /\/rest\/v1\/items.*$/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: { cacheName: 'item-feed' },
          },
          {
            urlPattern: /\/rest\/v1\/(items|claims|claim_messages).*$/,
            method: 'POST',
            handler: 'NetworkOnly',
            options: {
              backgroundSync: {
                name: 'offline-mutations',
                options: { maxRetentionTime: 24 * 60 }, // minutes
              },
            },
          },
        ],
      },
    }),
  ],
};
```

Read fallback for offline browsing uses Dexie.js as a local mirror of
the last-synced `items`/`missing_notices` result set, kept warm by the
Network-First fetches above.

## Abuse prevention (claims rate limiting)
Edge Function in front of `POST /claims`: sliding-window check keyed on
`(select auth.uid())` from the caller's JWT, max 3 approved insertions
per rolling 24h. Applied at the application layer (not IP) because
campus NAT/shared Wi-Fi makes IP-based limiting unreliable.

```ts
// supabase/functions/submit-claim/index.ts (sketch)
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CLAIMS = 3;

// 1. authenticate, extract user id from JWT
// 2. count claims where owner_id = user.id and created_at > now() - WINDOW_MS
// 3. if count >= MAX_CLAIMS -> 429
// 4. else insert claim, return 201
```

## Non-functional requirements
- Public feed query (`status, created_at`) must stay index-served as the
  `released` archive grows across semesters — validated by the partial +
  composite index pair above.
- Offline logging must survive app close (Background Sync wakes the
  Service Worker independently of an open tab).
- All photo uploads sanitized client-side before touching Storage — no
  server-side EXIF processing exists as a fallback (by design: never
  trust raw upload bytes).

## Security / data handling
- RLS is the only authorization boundary that matters (PostgREST exposes
  the DB directly); app-layer checks are UX, not security.
- `private_note` on `items` is never selected by any public-facing
  query/policy path — enforced by omission from the public SELECT
  policy's implicit column exposure at the API layer (Supabase generates
  columns from the row; a public-view alternative that explicitly
  excludes `private_note` is worth adding — see open questions).
- Photos: EXIF/GPS stripped client-side before upload (see above).

## Open questions
- `private_note` is a full-row column, and Supabase's PostgREST
  auto-API returns whatever columns the policy allows through minus any
  explicit column grants — recommend exposing the public catalog via a
  `select`-restricted view or column-level `GRANT` rather than relying
  solely on row-level policy, so `private_note` can never leak through a
  future `select *`. Flagged for Phase 2 implementation.
- Background Sync API browser support is not universal (notably still
  gapped on Safari/iOS at time of writing) — needs a graceful
  degradation path (e.g. retry-on-app-foreground fallback) rather than
  a hard dependency. `NEEDS EVIDENCE`/verification against current
  caniuse data before launch.
- `staff_members` table (referenced by `is_staff()`) and its own RLS/
  provisioning process is assumed but not detailed in the source spec —
  defined here as a minimal staff-roster table.
