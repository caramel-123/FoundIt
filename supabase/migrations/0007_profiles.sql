-- Phase 3.6 — shared profile records (name + Google photo) so avatars and
-- author profile pages can show other users' profile pictures.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.

create table if not exists public.profiles (
  id text primary key,
  name text,
  avatar_url text,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid()::text);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid()::text)
  with check (id = auth.uid()::text);
