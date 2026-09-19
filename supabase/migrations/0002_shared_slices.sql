-- Phase 3.1 — shared data for the remaining slices so they sync across users:
-- comments, reposts, challenge_responses, verifications. (Claims stay local for
-- now; they're private staff-review threads and lower traffic.)
--
-- Idempotent. Paste into the Supabase SQL editor and Run.

-- ─── comments ──────────────────────────────────────────────────────────────
-- One row per comment/reply node. parent_id links replies into a tree.
-- post_id is the item id (or repost id) the thread belongs to.
create table if not exists public.comments (
  id text primary key,
  post_id text not null,
  parent_id text,
  author_id text not null,
  author_name text,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);
alter table public.comments enable row level security;

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated using (true);

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated with check (author_id = auth.uid()::text);

-- ─── reposts ───────────────────────────────────────────────────────────────
create table if not exists public.reposts (
  id text primary key,
  item_id text not null,
  user_id text not null,
  user_name text,
  caption text,
  created_at timestamptz not null default now()
);
create index if not exists reposts_item_idx on public.reposts (item_id);
alter table public.reposts enable row level security;

drop policy if exists reposts_select on public.reposts;
create policy reposts_select on public.reposts
  for select to authenticated using (true);

drop policy if exists reposts_insert on public.reposts;
create policy reposts_insert on public.reposts
  for insert to authenticated with check (user_id = auth.uid()::text);

drop policy if exists reposts_delete on public.reposts;
create policy reposts_delete on public.reposts
  for delete to authenticated using (user_id = auth.uid()::text);

-- ─── challenge_responses ─────────────────────────────────────────────────────
-- Answers to a found item's Ownership Challenge. Readable by the item's finder
-- and the responder. Responder inserts; the item's finder updates the status.
create table if not exists public.challenge_responses (
  id text primary key,
  item_id text not null,
  finder_id text not null,          -- denormalized so RLS can grant finder access
  responder_id text not null,
  responder_name text,
  answers jsonb not null default '[]'::jsonb,
  note text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','escalated')),
  created_at timestamptz not null default now()
);
create index if not exists cr_item_idx on public.challenge_responses (item_id, created_at);
alter table public.challenge_responses enable row level security;

drop policy if exists cr_select on public.challenge_responses;
create policy cr_select on public.challenge_responses
  for select to authenticated
  using (responder_id = auth.uid()::text or finder_id = auth.uid()::text);

drop policy if exists cr_insert on public.challenge_responses;
create policy cr_insert on public.challenge_responses
  for insert to authenticated
  with check (responder_id = auth.uid()::text);

drop policy if exists cr_update on public.challenge_responses;
create policy cr_update on public.challenge_responses
  for update to authenticated
  using (finder_id = auth.uid()::text)
  with check (finder_id = auth.uid()::text);

-- ─── verifications ───────────────────────────────────────────────────────────
-- One row per user's student-verification decision. Readable by all (so the
-- "Verified student" badge shows on their posts/comments across users); each
-- user writes only their own row.
create table if not exists public.verifications (
  user_id text primary key,
  user_name text,
  status text not null check (status in ('unverified','verified','rejected')),
  doc_type text,
  extracted jsonb,
  confidence real,
  ai_verdict text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz not null default now()
);
alter table public.verifications enable row level security;

drop policy if exists verifications_select on public.verifications;
create policy verifications_select on public.verifications
  for select to authenticated using (true);

drop policy if exists verifications_upsert_insert on public.verifications;
create policy verifications_upsert_insert on public.verifications
  for insert to authenticated with check (user_id = auth.uid()::text);

drop policy if exists verifications_upsert_update on public.verifications;
create policy verifications_upsert_update on public.verifications
  for update to authenticated
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- ─── Realtime (idempotent) ────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table public.comments; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.reposts; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.challenge_responses; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.verifications; exception when duplicate_object then null; end $$;
