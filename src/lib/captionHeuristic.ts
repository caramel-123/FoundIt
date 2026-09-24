// ─── Local caption parser (Requirement 12.7) ──────────────────────────────────
// Dependency-free heuristic used when the parse-caption Edge Function is
// unavailable, and to backfill empty AI fields. Pure, so it's unit tested.

export interface ParsedCaption {
  title: string;
  category: string; // one of CATEGORIES (excluding "All") or ""
  location_found: string;
  description: string;
}

// Kept in sync with CATEGORIES in App.tsx (excluding "All").
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

// Keyword hints that map free text to a category.
const CATEGORY_HINTS: Record<string, string[]> = {
  Electronics: ["earbud", "earphone", "headphone", "airpod", "phone", "laptop", "charger", "calculator", "tablet", "ipad", "macbook", "camera", "cable"],
  "ID / Card": ["id card", "student id", "id ", "license", "atm card", "credit card"],
  "Bag / Backpack": ["backpack", "bag", "kånken", "kanken", "tote", "sling"],
  Keys: ["key", "keys", "keychain"],
  Clothing: ["hoodie", "jacket", "shirt", "sweater", "fleece", "cap", "hat", "scarf"],
  "Wallet / Purse": ["wallet", "purse", "pouch"],
  "Water Bottle": ["water bottle", "tumbler", "flask", "hydro"],
  "Books / Notes": ["book", "notebook", "notes", "planner"],
};

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const category of CATEGORIES) {
    const hints = CATEGORY_HINTS[category];
    if (hints && hints.some(h => lower.includes(h))) return category;
  }
  return "";
}

function detectLocation(text: string): string {
  // Look for explicit "location:" first, then common cues.
  const explicit = text.match(/location\s*[:\-]\s*(.+)/i);
  if (explicit) return explicit[1].trim().split(/\n/)[0].slice(0, 120);

  const cue = text.match(/(?:found (?:at|in|near)|near|at)\s+([A-Z][^.,\n]{2,80})/);
  if (cue) return cue[1].trim().slice(0, 120);
  return "";
}

export function localParse(caption: string): ParsedCaption {
  const text = caption.trim();
  const firstLine = text.split(/\n/).map(l => l.trim()).find(Boolean) ?? "";
  return {
    title: firstLine.slice(0, 80),
    category: detectCategory(text),
    location_found: detectLocation(text),
    description: text,
  };
}
