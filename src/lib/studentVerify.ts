// ─── Student verification (Requirement 15) ──────────────────────────────────────
//
// Turns an uploaded document image (Student ID / COR / class schedule) into a
// verification verdict using Google Gemini Vision via the `verify-student` Edge
// Function. This is AI-only: there is no staff review. A high-confidence pass
// whose name matches the account → verified; anything else → rejected (retry).
// If the AI service isn't configured/available, we report "unavailable" and do
// NOT verify (no fallback approval). AI is a signal, not proof of identity, and
// forgery detection is out of scope — item release stays gated by staff custody.

import { supabase, isSupabaseConfigured } from "./supabase";

export type DocType = "student_id" | "cor" | "class_schedule";

export interface VerifyExtracted {
  name?: string;
  student_no?: string;
  school?: string;
  term_valid?: boolean;
}

export interface VerifyResult {
  // Fully automated decision (no staff step). "unavailable" = AI not configured.
  decision: "verified" | "rejected" | "unavailable";
  ai_verdict: "pass" | "fail";
  confidence: number; // 0..1
  extracted: VerifyExtracted;
  name_matches_account: boolean;
  is_student_doc: boolean;
  message?: string; // human-friendly note
}

export interface VerifyInput {
  imageBase64: string; // data WITHOUT the data: prefix
  mimeType: string;
  accountName: string;
  docType: DocType;
}

// Loose name-consistency check: do the account name tokens overlap the extracted name?
export function namesLooselyMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(t => t.length > 1);
  const ta = new Set(norm(a));
  const tb = norm(b);
  if (ta.size === 0 || tb.length === 0) return false;
  return tb.some(t => ta.has(t));
}

function unavailable(message: string): VerifyResult {
  return {
    decision: "unavailable",
    ai_verdict: "fail",
    confidence: 0,
    extracted: {},
    name_matches_account: false,
    is_student_doc: false,
    message,
  };
}

/**
 * Review a student document via the Gemini-backed Edge Function (AI-only).
 * Returns "unavailable" (without verifying) when Supabase/the function isn't set up.
 */
export async function verifyStudent(input: VerifyInput): Promise<VerifyResult> {
  if (!input.imageBase64) {
    return unavailable("No document image to check.");
  }
  if (!(isSupabaseConfigured && supabase)) {
    return unavailable("Verification is temporarily unavailable. Please try again later.");
  }

  try {
    const { data, error } = await supabase.functions.invoke("verify-student", {
      body: {
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
        accountName: input.accountName,
        docType: input.docType,
      },
    });
    if (error || !data) {
      return unavailable("Verification is temporarily unavailable. Please try again later.");
    }

    const d = data as Partial<VerifyResult>;
    const confidence = typeof d.confidence === "number" ? Math.min(1, Math.max(0, d.confidence)) : 0;
    const extracted = (d.extracted ?? {}) as VerifyExtracted;
    const is_student_doc = Boolean(d.is_student_doc);
    const ai_verdict = d.ai_verdict === "pass" ? "pass" : "fail";
    const name_matches_account =
      typeof d.name_matches_account === "boolean"
        ? d.name_matches_account
        : namesLooselyMatch(input.accountName, extracted.name ?? "");

    const verified =
      ai_verdict === "pass" && confidence >= 0.75 && is_student_doc && name_matches_account;

    return {
      decision: verified ? "verified" : "rejected",
      ai_verdict,
      confidence,
      extracted,
      name_matches_account,
      is_student_doc,
      message: verified
        ? "Verified automatically."
        : !is_student_doc
          ? "We couldn't read this as a student document. Try a clearer photo."
          : !name_matches_account
            ? "The name on the document doesn't match your account name."
            : "The document couldn't be confirmed with enough confidence. Try a clearer photo.",
    };
  } catch {
    return unavailable("Verification is temporarily unavailable. Please try again later.");
  }
}
