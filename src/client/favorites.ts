import type { Basis, DiaryEntry, Food, Nutrition } from "../contracts/types";

export const FAVORITES_KEY = "protein-scanner-favorites-v1";

/** A food with the exact amount that was logged, enough to log it again without a network call. */
export type FoodServing = {
  food: Food;
  nutrition: Nutrition | null;
  amount: Basis;
};

export type SavedFood = FoodServing & { key: string };

/** Foods are the same item when both the name (case-insensitive) and barcode match. */
export function foodKey(food: Food): string {
  return `${food.name.trim().toLowerCase()}::${(food.barcode ?? "").trim()}`;
}

export function entryAsSavedFood(entry: DiaryEntry): SavedFood {
  return {
    key: foodKey(entry.food),
    food: entry.food,
    nutrition: entry.nutrition,
    amount: entry.amount,
  };
}

function isSavedFood(value: unknown): value is SavedFood {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<SavedFood>;
  return (
    typeof item.key === "string" &&
    item.key.length > 0 &&
    item.food !== null &&
    typeof item.food === "object" &&
    typeof (item.food as { name?: unknown }).name === "string" &&
    item.amount !== null &&
    typeof item.amount === "object" &&
    typeof (item.amount as { amount?: unknown }).amount === "number" &&
    Number.isFinite((item.amount as { amount: number }).amount) &&
    (item.amount as { amount: number }).amount > 0 &&
    (item.nutrition === null || (item.nutrition !== undefined && typeof item.nutrition === "object"))
  );
}

/** Favourites live only in this browser. Broken or foreign records are ignored. */
export function loadFavorites(storage: Pick<Storage, "getItem"> = localStorage): SavedFood[] {
  try {
    const raw = storage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: SavedFood[] = [];
    for (const value of parsed) {
      if (!isSavedFood(value)) continue;
      const key = foodKey(value.food);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...value, key });
    }
    return result;
  } catch {
    return [];
  }
}

export function saveFavorites(items: SavedFood[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(FAVORITES_KEY, JSON.stringify(items));
}

/** Adds a food when it is not saved, otherwise removes every copy of it. */
export function toggleFavorite(items: SavedFood[], item: FoodServing): SavedFood[] {
  const key = foodKey(item.food);
  if (items.some((saved) => saved.key === key)) {
    return items.filter((saved) => saved.key !== key);
  }
  return [{ ...item, key }, ...items];
}
