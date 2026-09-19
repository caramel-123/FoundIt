// Supabase Edge Function: parse-caption
//
// Takes a pasted post caption and asks Google Gemini to structure it into the
// Log Found Item fields. The Gemini API key is read from the GEMINI_API_KEY
// secret and never leaves the server.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=your_key
//   supabase functions deploy parse-caption
//
// Request  (POST JSON): { "caption": "..." }
// Response (JSON):      { "title", "category", "location_found", "description" }

// deno-lint-ignore-file no-explicit-any

const CATEGORIES = [
  "Electronics",
  "ID / Card",
  "Bag / Backpack",
  "Keys",
  "Clothing",
  "Wallet / Purse",
  "Water Bottle",
  "Books / Notes",
  "Other",
];

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

function clampCategory(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = CATEGORIES.find(c => c.toLowerCase() === value.trim().toLowerCase());
  return match ?? "";
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

  let caption = "";
  try {
    const body = await req.json();
    caption = String(body?.caption ?? "").trim();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!caption) {
    return json({ error: "Missing caption" }, 400);
  }

  const prompt =
    "You extract structured lost-and-found details from a social media post " +
    "caption. Return ONLY strict minified JSON with exactly these keys: " +
    'title, category, location_found, description. ' +
    `The "category" MUST be one of: ${CATEGORIES.join(", ")} — or an empty ` +
    "string if none fit. \"title\" is a short headline (max ~80 chars). " +
    '"location_found" is where the item was found if stated, else empty. ' +
    '"description" summarizes the item (color, brand, markings, contents). ' +
    "Do not invent facts not present in the caption. " +
    `Caption:\n"""${caption}"""`;

  // Model names change over time; try a rolling alias first, then fall back
  // through known-good names so the function keeps working across Gemini
  // releases.
  // Rolling aliases only — Google keeps these pointed at current models, so
  // they don't get retired out from under us like pinned versions do.
  const MODELS = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
  ];
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
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
      // Try the next model on model-not-found (404) or transient
      // overload/rate-limit (503/429); otherwise stop and report.
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

  const text: string =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model returned non-JSON; degrade gracefully to empties.
    parsed = {};
  }

  return json({
    title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : "",
    category: clampCategory(parsed.category),
    location_found:
      typeof parsed.location_found === "string" ? parsed.location_found : "",
    description:
      typeof parsed.description === "string" ? parsed.description : "",
  });
});
