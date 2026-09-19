// Supabase Edge Function: verify-student
//
// Takes an uploaded student document image (Student ID / COR / class schedule)
// and asks Google Gemini Vision to read it and return a structured verdict. The
// Gemini API key is read from the GEMINI_API_KEY secret and never leaves the
// server. AI is a signal only: it does not detect forgery or prove the document
// belongs to the submitter, so the client routes ambiguous cases to staff.
//
// The raw image is NOT persisted by this function — it is used only to produce
// the verdict for the current request.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=your_key
//   supabase functions deploy verify-student
//
// Request  (POST JSON): { imageBase64, mimeType, accountName, docType }
// Response (JSON):      { is_student_doc, doc_type, extracted{...},
//                         name_matches_account, confidence, ai_verdict }

// deno-lint-ignore-file no-explicit-any

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function looseNameMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  const ta = new Set(norm(a));
  const tb = norm(b);
  if (ta.size === 0 || tb.length === 0) return false;
  return tb.some((t) => ta.has(t));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "GEMINI_API_KEY is not configured" }, 500);
  }

  let imageBase64 = "";
  let mimeType = "image/jpeg";
  let accountName = "";
  let docType = "";
  try {
    const body = await req.json();
    imageBase64 = String(body?.imageBase64 ?? "").trim();
    mimeType = String(body?.mimeType ?? "image/jpeg");
    accountName = String(body?.accountName ?? "").trim();
    docType = String(body?.docType ?? "");
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!imageBase64) {
    return json({ error: "Missing imageBase64" }, 400);
  }

  const prompt =
    "You verify whether an uploaded image is a legitimate student document " +
    "(a student ID card, a Certificate of Registration, or a class schedule) " +
    "for a campus lost-and-found app. Read the document and return ONLY strict " +
    "minified JSON with exactly these keys: is_student_doc (boolean), doc_type " +
    '(one of "student_id","cor","class_schedule", or ""), name (string, the ' +
    "person's full name as printed, else empty), student_no (string, else " +
    "empty), school (string, else empty), term_valid (boolean, true if the " +
    "document shows a current/undated enrollment term), confidence (number " +
    "0..1 for how confident you are it is a genuine student document of the " +
    "stated type). Do not invent facts not visible in the image. You are NOT " +
    "asked to detect forgery beyond obvious signs. " +
    `The account holder's name is: "${accountName}". ` +
    `The user says the document type is: "${docType}".`;

  // Rolling aliases only, matching parse-caption's resilience strategy.
  const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
  const requestBody = JSON.stringify({
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
  });

  let data: any;
  let lastDetail = "";
  for (const model of MODELS) {
    const endpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      model +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });
      if (res.ok) {
        data = await res.json();
        break;
      }
      lastDetail = await res.text();
      if (res.status !== 404 && res.status !== 503 && res.status !== 429) {
        return json({ error: "Gemini request failed", detail: lastDetail }, 502);
      }
    } catch (e) {
      lastDetail = String(e);
    }
  }
  if (!data) {
    return json({ error: "No supported Gemini model", detail: lastDetail }, 502);
  }

  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }

  const extracted = {
    name: typeof parsed.name === "string" ? parsed.name : "",
    student_no: typeof parsed.student_no === "string" ? parsed.student_no : "",
    school: typeof parsed.school === "string" ? parsed.school : "",
    term_valid: Boolean(parsed.term_valid),
  };
  const is_student_doc = Boolean(parsed.is_student_doc);
  const confidence =
    typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;
  const name_matches_account = looseNameMatch(accountName, extracted.name);
  const ai_verdict =
    is_student_doc && confidence >= 0.5 ? "pass" : "fail";

  return json({
    is_student_doc,
    doc_type: typeof parsed.doc_type === "string" ? parsed.doc_type : "",
    extracted,
    name_matches_account,
    confidence,
    ai_verdict,
  });
});
