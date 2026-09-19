-- Phase 3.2 — make the "I found this" lost-flow and notifications sync across
-- users. Adds a notifications table and extends challenge_responses with the
-- lost-flow columns (kind, owner_id) and the new statuses.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.

-- ─── challenge_responses: lost-flow columns + widened status set ─────────────
alter table public.challenge_responses
  add column if not exists kind text not null default 'found';
alter table public.challenge_responses
  add column if not exists owner_id text;

-- Widen the status check to include the lost-flow states.
do $$ begin
  alter table public.challenge_responses drop constraint if exists challenge_responses_status_check;
exception when undefined_object then null; end $$;
do $$ begin
  alter table public.challenge_responses
    add constraint challenge_responses_status_check
    check (status in ('pending','approved','rejected','escalated','awaiting_owner','answered'));
exception when duplicate_object then null; end $$;

-- The lost post's owner also needs to read (to answer) and update (to submit
-- answers) the report addressed to them. Recreate the policies to include owner_id.
drop policy if exists cr_select on public.challenge_responses;
create policy cr_select on public.challenge_responses
  for select to authenticated
  using (
    responder_id = auth.uid()::text
    or finder_id = auth.uid()::text
    or owner_id = auth.uid()::text
  );

drop policy if exists cr_update on public.challenge_responses;
create policy cr_update on public.challenge_responses
  for update to authenticated
  using (finder_id = auth.uid()::text or owner_id = auth.uid()::text)
  with check (finder_id = auth.uid()::text or owner_id = auth.uid()::text);

-- ─── notifications ───────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id text primary key,
  recipient_id text not null,
  message text not null,
  item_id text,
  response_id text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc);
alter table public.notifications enable row level security;

-- Recipients read/update their own; any authenticated user may create a
-- notification (e.g. the finder notifying the owner, and vice versa).
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (recipient_id = auth.uid()::text);

drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert to authenticated with check (true);

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (recipient_id = auth.uid()::text)
  with check (recipient_id = auth.uid()::text);

-- ─── Realtime (idempotent) ────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end $$;

-- Owner's note back to the finder (lost flow).
alter table public.challenge_responses add column if not exists owner_note text;
