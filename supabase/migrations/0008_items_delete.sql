-- Phase 3.7 — let a post's author (or staff) delete it (Requirement 5d).
-- Updates already use items_update (author) and items_update_staff.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete to authenticated
  using (finder_id = auth.uid()::text or public.is_staff());
