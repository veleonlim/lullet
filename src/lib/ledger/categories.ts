/**
 * The fixed expense categories (agreed in the design report). The ids match the
 * `expense_category` database enum; a test keeps the two in sync.
 */
export const CATEGORIES = [
  { id: "food", label: "Food" },
  { id: "transport", label: "Transport" },
  { id: "stay", label: "Stay" },
  { id: "sightseeing", label: "Sightseeing" },
  { id: "shopping", label: "Shopping" },
  { id: "other", label: "Other" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export const CATEGORY_IDS = CATEGORIES.map((category) => category.id) as [
  CategoryId,
  ...CategoryId[],
];

export function isCategoryId(value: unknown): value is CategoryId {
  return CATEGORIES.some((category) => category.id === value);
}

export function categoryLabel(id: CategoryId): string {
  return CATEGORIES.find((category) => category.id === id)?.label ?? "Other";
}
