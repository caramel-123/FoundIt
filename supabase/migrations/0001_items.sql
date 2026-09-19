-- Phase 3.0 — shared `items` table so all users see each other's posts.
--
-- finder_id is TEXT (not a FK to auth.users) so both real Supabase user ids and
-- the interim mock ids work during the prototype. RLS compares against
-- auth.uid()::text for the real, signed-in case.

create table if not exists public.items (
  id text primary key,
  finder_id text not null,
  finder_name text,
  title text not null,
  category text not null,
  location_found text not null,
  time_found timestamptz,
  description text not null,
  private_note text,
  status text not null default 'in_office'
    check (status in ('pending_intake','in_office','approved_for_pickup','released')),
  image_url text,
  upvotes int not null default 0,
  challenge jsonb,
  created_at timestamptz not null default now()
);

create index if not exists items_status_created_idx
  on public.items (status, created_at desc);

alter table public.items enable row level security;

-- Read: all authenticated users see every item (public catalog for everyone).
-- Except `released` items, which drop out of the active catalog.
drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select
  to authenticated
  using (status <> 'released');

-- Insert: an authenticated user may create an item attributed to themselves.
drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert
  to authenticated
  with check (finder_id = auth.uid()::text);

-- Update: the finder may update their own item (e.g. status/upvotes for now).
-- Staff-scoped updates land with the staff slice.
drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update
  to authenticated
  using (finder_id = auth.uid()::text)
  with check (finder_id = auth.uid()::text);

-- Realtime: broadcast row changes so catalogs update live across users.
-- Guarded so re-running the migration doesn't error if it's already a member.
do $$
begin
  alter publication supabase_realtime add table public.items;
exception
  when duplicate_object then null;
end $$;
