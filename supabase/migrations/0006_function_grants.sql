-- Phase 3.3 hardening — tighten who can call the 0005 functions over the API.
--
-- Trigger functions only need to run as triggers (EXECUTE isn't checked for
-- that), so nobody gets to call them via /rest/v1/rpc. is_staff() and
-- escalate_challenge_response() are for signed-in users only.
--
-- Idempotent. Paste into the Supabase SQL editor and Run.

revoke execute on function public.enforce_claim_rate_limit() from public, anon, authenticated;
revoke execute on function public.enforce_response_rate_limit() from public, anon, authenticated;
revoke execute on function public.write_audit_log() from public, anon, authenticated;

revoke execute on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

revoke execute on function public.escalate_challenge_response(text, text) from public, anon;
grant execute on function public.escalate_challenge_response(text, text) to authenticated;
