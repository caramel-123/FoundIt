// ─── Caption import (Requirement 12) ───────────────────────────────────────────
//
// Turns a pasted post caption into structured Log-Found-Item fields. When a
// Supabase client is configured, it calls the `parse-caption` Edge Function
// (which uses Google Gemini). Otherwise it falls back to a dependency-free local
// heuristic parser so the feature still works without a backend.

import { supabase, isSupabaseConfigured } from "./supabase";
import { localParse, type ParsedCaption } from "./captionHeuristic";

export type { ParsedCaption };

/**
 * Parse a caption into structured fields. Uses the Gemini-backed Edge Function
 * when Supabase is configured; otherwise falls back to the local parser.
 */
export async function parseCaption(caption: string): Promise<ParsedCaption> {
  const text = caption.trim();
  if (!text) {
    return { title: "", category: "", location_found: "", description: "" };
  }

  if (isSupabaseConfigured && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke("parse-caption", {
        body: { caption: text },
      });
      if (!error && data) {
        const d = data as Partial<ParsedCaption>;
        // Guard against an empty AI result by backfilling from the local parser.
        const local = localParse(text);
        return {
          title: d.title || local.title,
          category: d.category || local.category,
          location_found: d.location_found || local.location_found,
          description: d.description || local.description,
        };
      }
    } catch {
      // fall through to local parser
    }
  }

  return localParse(text);
}
