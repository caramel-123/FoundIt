-- Phase 3.3 — staff roster, shared claims + threads, claim rate limit, shared
-- upvotes, and an audit trail on items/claims.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.
-- Add staff with:  insert into public.staff (email) values ('someone@school.edu');

-- ─── Staff roster + is_staff() ───────────────────────────────────────────────
-- No insert/update/delete policies: the roster is edited from the SQL editor only.
create table if not exists public.staff (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table public.staff enable row level security;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to authenticated;

-- ─── items: staff may read everything and update any item ────────────────────
drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select to authenticated
  using (status <> 'released' or public.is_staff());

drop policy if exists items_update_staff on public.items;
create policy items_update_staff on public.items
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ─── claims ──────────────────────────────────────────────────────────────────
create table if not exists public.claims (
  id text primary key,
  item_id text not null,
  owner_id text not null,
  owner_name text,
  identifying_details text not null,
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists claims_owner_created_idx on public.claims (owner_id, created_at desc);
alter table public.claims enable row level security;

drop policy if exists claims_select on public.claims;
create policy claims_select on public.claims
  for select to authenticated
  using (owner_id = auth.uid()::text or public.is_staff());

drop policy if exists claims_insert on public.claims;
create policy claims_insert on public.claims
  for insert to authenticated
  with check (owner_id = auth.uid()::text and status = 'pending_review');

drop policy if exists claims_update_staff on public.claims;
create policy claims_update_staff on public.claims
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ─── claim_messages (private thread per claim) ───────────────────────────────
create table if not exists public.claim_messages (
  id text primary key,
  claim_id text not null references public.claims (id) on delete cascade,
  sender_id text not null,
  sender_role text not null check (sender_role in ('owner','staff')),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists claim_messages_claim_idx on public.claim_messages (claim_id, created_at);
alter table public.claim_messages enable row level security;

drop policy if exists claim_messages_select on public.claim_messages;
create policy claim_messages_select on public.claim_messages
  for select to authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.claims c where c.id = claim_id and c.owner_id = auth.uid()::text)
  );

drop policy if exists claim_messages_insert on public.claim_messages;
create policy claim_messages_insert on public.claim_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()::text
    and (
      (sender_role = 'staff' and public.is_staff())
      or (sender_role = 'owner' and exists (
        select 1 from public.claims c where c.id = claim_id and c.owner_id = auth.uid()::text
      ))
    )
  );

-- ─── Claim rate limit: max 3 per owner per rolling 24h ───────────────────────
create or replace function public.enforce_claim_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server time only, so a client can't backdate claims to dodge the window.
  new.created_at := now();
  -- Claims created by a finder's escalation skip the limit: the claimant didn't start them.
  if coalesce(current_setting('foundit.escalating', true), '') = '1' then
    return new;
  end if;
  if (
    select count(*) from public.claims
    where owner_id = new.owner_id and created_at > now() - interval '24 hours'
  ) >= 3 then
    raise exception 'claim_rate_limited' using hint = 'Max 3 claims per 24 hours.';
  end if;
  return new;
end;
$$;

drop trigger if exists claims_rate_limit on public.claims;
create trigger claims_rate_limit
  before insert on public.claims
  for each row execute function public.enforce_claim_rate_limit();

-- Owners claim through "Prove it's yours", so the same limit applies there.
create or replace function public.enforce_response_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_at := now();
  if new.kind = 'found' and (
    select count(*) from public.challenge_responses
    where responder_id = new.responder_id and kind = 'found'
      and created_at > now() - interval '24 hours'
  ) >= 3 then
    raise exception 'claim_rate_limited' using hint = 'Max 3 claims per 24 hours.';
  end if;
  return new;
end;
$$;

drop trigger if exists challenge_responses_rate_limit on public.challenge_responses;
create trigger challenge_responses_rate_limit
  before insert on public.challenge_responses
  for each row execute function public.enforce_response_rate_limit();

-- ─── Escalate a challenge response to staff (finder-initiated claim) ─────────
create or replace function public.escalate_challenge_response(p_response_id text, p_claim_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.challenge_responses%rowtype;
  details text;
begin
  select * into r from public.challenge_responses where id = p_response_id;
  if not found or r.finder_id <> auth.uid()::text then
    raise exception 'not_allowed';
  end if;

  select string_agg((a ->> 'prompt') || ': ' || coalesce(a ->> 'answer', ''), E'\n')
    into details
    from jsonb_array_elements(r.answers) a;
  if r.note is not null and r.note <> '' then
    details := coalesce(details || E'\n', '') || 'Note: ' || r.note;
  end if;

  perform set_config('foundit.escalating', '1', true);
  insert into public.claims (id, item_id, owner_id, owner_name, identifying_details, status)
  values (p_claim_id, r.item_id, r.responder_id, r.responder_name, coalesce(details, '(no answers)'), 'pending_review');
  perform set_config('foundit.escalating', '', true);

  update public.challenge_responses set status = 'escalated' where id = p_response_id;
end;
$$;
grant execute on function public.escalate_challenge_response(text, text) to authenticated;

-- ─── Shared upvotes (one per user per post; post = item id or repost id) ─────
create table if not exists public.upvotes (
  post_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.upvotes enable row level security;

drop policy if exists upvotes_select on public.upvotes;
create policy upvotes_select on public.upvotes
  for select to authenticated using (true);

drop policy if exists upvotes_insert on public.upvotes;
create policy upvotes_insert on public.upvotes
  for insert to authenticated with check (user_id = auth.uid()::text);

drop policy if exists upvotes_delete on public.upvotes;
create policy upvotes_delete on public.upvotes
  for delete to authenticated using (user_id = auth.uid()::text);

-- ─── Audit trail on items and claims (staff read-only) ───────────────────────
create table if not exists public.audit_logs (
  id bigserial primary key,
  table_name text not null,
  row_id text,
  action text not null,
  actor_id text,
  old_row jsonb,
  new_row jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_logs enable row level security;

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.is_staff());

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (table_name, row_id, action, actor_id, old_row, new_row)
  values (
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
    lower(tg_op),
    auth.uid()::text,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists items_audit on public.items;
create trigger items_audit
  after insert or update or delete on public.items
  for each row execute function public.write_audit_log();

drop trigger if exists claims_audit on public.claims;
create trigger claims_audit
  after insert or update or delete on public.claims
  for each row execute function public.write_audit_log();

-- ─── Realtime (idempotent) ────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table public.claims; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.claim_messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.upvotes; exception when duplicate_object then null; end $$;
