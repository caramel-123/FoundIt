-- Comment visibility: public (default) or private (author + commenter only).
-- Filtering is done client-side (needs post ownership), so RLS stays as-is;
-- the column just carries the flag. Idempotent.

alter table public.comments
  add column if not exists visibility text not null default 'public';
do $$ begin
  alter table public.comments add constraint comments_visibility_check
    check (visibility in ('public','private'));
exception when duplicate_object then null; end $$;
