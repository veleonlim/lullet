import type { CategoryId } from "@/lib/ledger";

/**
 * One fixed colour per category, in the category order, so a category keeps its colour whatever
 * is filtered. Written out in full so Tailwind sees every class.
 */
export const CATEGORY_FILL: Record<CategoryId, string> = {
  food: "bg-series-1",
  transport: "bg-series-2",
  stay: "bg-series-3",
  sightseeing: "bg-series-4",
  shopping: "bg-series-5",
  other: "bg-series-6",
};
