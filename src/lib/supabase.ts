// ─── Supabase client ────────────────────────────────────────────────────────
//
// Creates the Supabase client from environment variables. When the variables
// are absent (e.g. a dev environment without Supabase configured), this exports
// `null` and the auth layer falls back to its interim mock.
//
// Env vars (in a gitignored .env):
//   VITE_SUPABASE_URL       https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY  the public anon key (safe in client code)

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true, // completes the OAuth redirect on return
      },
    })
  : null;
