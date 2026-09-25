// ─── PUP campus places (Requirement 1.1b) ──────────────────────────────────────
// The 50 numbered places from the PUP vicinity map legend, in map order.

export const CAMPUS_PLACES: readonly string[] = [
  "The Pylon",
  "The Mural",
  "Visitor's Lounge",
  "Open Court",
  "Lawn Tennis Court",
  "Basketball Court",
  "Souvenir Shop",
  "Mabini Shrine",
  "Mabini Museum",
  "Obelisk",
  "Freedom Park",
  "Fountain Park",
  "Inter-Faith Chapel",
  "Main Academic Building",
  "Gazebo",
  "Grandstand",
  "Oval",
  "Tahanan ng Atleta",
  "Gabriela Silang Building",
  "Food and Nutrition Building",
  "Facility Management Office",
  "Sampaguita Building",
  "Student Center",
  "Charlie del Rosario Building",
  "Linear Park",
  "Laboratory High School Building",
  "Printing Press Building",
  "Property and Supply Management Office",
  "Water Tower",
  "Ninoy Aquino Learning Resource Center",
  "Lagoon Commercial Spaces",
  "Amphitheater",
  "Lagoon Park",
  "Nutrition & Food Technology Research and Development Center Building",
  "Human Kinetics Building",
  "Tahanan ng Alumni",
  "Swimming Pool",
  "Multi-Purpose Building",
  "Engineering and Science Research Center",
  "Communication Building",
  "PUP Theater",
  "Engineering and Architecture Building",
  "Condotel",
  "NDC Tennis Court and Club House",
  "NDC Covered Court",
  "Business Processing Office",
  "Information Technology Building",
  "Antique House",
  "Graduate School",
  "Hasmin Building",
];

/**
 * Places matching `query` (case-insensitive, any part of the name). Names that
 * start with the query come first; otherwise map order is kept.
 */
export function matchPlaces(query: string, limit = 50, places: readonly string[] = CAMPUS_PLACES): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return places.slice(0, limit);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const p of places) {
    const lower = p.toLowerCase();
    if (lower.startsWith(q) || lower.split(/\s+/).some(w => w.startsWith(q))) starts.push(p);
    else if (lower.includes(q)) contains.push(p);
  }
  return [...starts, ...contains].slice(0, limit);
}
