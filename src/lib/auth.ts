// ─── Auth contract (Requirement 10) ────────────────────────────────────────────
//
// The single boundary between the app and the auth provider. When Supabase is
// configured (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY present), this uses
// Supabase Auth's Google OAuth provider. Otherwise it falls back to an interim
// mock that simulates a Google sign-in and persists to localStorage, so the app
// still runs in environments without Supabase configured.
//
// The rest of the app depends only on the exported types and functions.

import type { Session, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

export type Role = "finder" | "owner" | "staff";

export interface AuthUser {
  id: string; // stable account key (Supabase user id)
  name: string; // Google display name
  email: string;
  avatar_url?: string; // Google profile picture
  role: Role; // derived from the account; defaults to non-staff
}

export type AuthState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signed_in"; user: AuthUser };

type AuthListener = (state: AuthState) => void;

// ─── Shared helpers ────────────────────────────────────────────────────────

// Role derivation (Requirement 10.9): staff are listed by email in the
// `public.staff` roster and checked through the `is_staff()` RPC. Any error
// means non-staff; RLS is the real boundary, this only picks which views show.
// Without Supabase, the roster comes from VITE_STAFF_EMAILS (local demos only).
const MOCK_STAFF_EMAILS = String(import.meta.env.VITE_STAFF_EMAILS ?? "")
  .split(",")
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function isMockStaff(email: string): boolean {
  return MOCK_STAFF_EMAILS.includes(email.toLowerCase());
}

async function withRole(user: AuthUser): Promise<AuthUser> {
  if (!supabase) return user;
  try {
    const { data, error } = await supabase.rpc("is_staff");
    return !error && data === true ? { ...user, role: "staff" } : user;
  } catch {
    return user;
  }
}

function mapUser(user: User): AuthUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (meta.full_name as string) ||
    (meta.name as string) ||
    (user.email ? user.email.split("@")[0] : "Campus member");
  return {
    id: user.id,
    name,
    email: user.email ?? "",
    avatar_url: (meta.avatar_url as string) || (meta.picture as string) || undefined,
    role: "owner",
  };
}

// ─── Supabase-backed implementation ──────────────────────────────────────────

function supabaseGetSession(): Promise<AuthUser | null> {
  return supabase!.auth.getSession().then(({ data }) => {
    const session = data.session as Session | null;
    return session?.user ? withRole(mapUser(session.user)) : null;
  });
}

async function supabaseSignInWithGoogle(): Promise<void> {
  const { error } = await supabase!.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  // On success the browser redirects to Google, so nothing follows here.
  if (error) throw error;
}

async function supabaseSignOut(): Promise<void> {
  const { error } = await supabase!.auth.signOut();
  if (error) throw error;
}

function supabaseOnAuthChange(listener: AuthListener): () => void {
  const { data } = supabase!.auth.onAuthStateChange((_event, session) => {
    if (!session?.user) {
      listener({ status: "signed_out" });
      return;
    }
    // Defer the RPC: Supabase warns against awaiting its own calls inside this callback.
    const user = mapUser(session.user);
    setTimeout(() => {
      withRole(user).then(u => listener({ status: "signed_in", user: u }));
    }, 0);
  });
  return () => data.subscription.unsubscribe();
}

// ─── Interim mock implementation (no Supabase configured) ────────────────────

const STORAGE_KEY = "clf.auth.user";
const mockListeners = new Set<AuthListener>();

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

const MOCK_GOOGLE_USER: AuthUser = {
  id: "user_google_mock",
  name: "Olivia Chen",
  email: "olivia.chen@riverside.edu",
  avatar_url: undefined,
  role: "owner",
};

function withMockRole(user: AuthUser): AuthUser {
  return { ...user, role: isMockStaff(user.email) ? "staff" : "owner" };
}

async function mockGetSession(): Promise<AuthUser | null> {
  await new Promise(r => setTimeout(r, 150));
  const user = readStoredUser();
  return user ? withMockRole(user) : null;
}

async function mockSignInWithGoogle(): Promise<void> {
  await new Promise(r => setTimeout(r, 400));
  const user = withMockRole(MOCK_GOOGLE_USER);
  writeStoredUser(user);
  mockListeners.forEach(l => l({ status: "signed_in", user }));
}

async function mockSignOut(): Promise<void> {
  await new Promise(r => setTimeout(r, 100));
  writeStoredUser(null);
  mockListeners.forEach(l => l({ status: "signed_out" }));
}

function mockOnAuthChange(listener: AuthListener): () => void {
  mockListeners.add(listener);
  return () => mockListeners.delete(listener);
}

// ─── Public API (dispatches to Supabase or mock) ─────────────────────────────

export function getSession(): Promise<AuthUser | null> {
  return isSupabaseConfigured ? supabaseGetSession() : mockGetSession();
}

export function signInWithGoogle(): Promise<void> {
  return isSupabaseConfigured ? supabaseSignInWithGoogle() : mockSignInWithGoogle();
}

export function signOut(): Promise<void> {
  return isSupabaseConfigured ? supabaseSignOut() : mockSignOut();
}

export function onAuthChange(listener: AuthListener): () => void {
  return isSupabaseConfigured ? supabaseOnAuthChange(listener) : mockOnAuthChange(listener);
}
