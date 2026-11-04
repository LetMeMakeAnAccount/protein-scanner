import type { FoodMatch } from "./api";
import type { MarketItem } from "./market";
import { marketValues } from "./market";
import type { Source } from "../contracts/types";
import seed from "../data/marketplace-seed.json";

/** One row of the bundled, offline catalog. Nutrition is per 100 g. */
export type CatalogFood = {
  code: string;
  name: string;
  proteinG: number;
  kcal: number;
  packageGrams: number | null;
  packageLabel: string | null;
  country: string | null;
};

const SEED = seed as { foods: CatalogFood[] };
export const CATALOG: CatalogFood[] = SEED.foods;

export function filterCatalog(query: string): CatalogFood[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return CATALOG;
  return CATALOG.filter(
    (food) =>
      food.name.toLowerCase().includes(needle) ||
      food.code.includes(needle) ||
      (food.country ?? "").toLowerCase().includes(needle),
  );
}

/** Builds an honest Open Food Facts match for the existing saved-list shape. */
export function catalogMatch(food: CatalogFood): FoodMatch {
  const source: Source = {
    kind: "off",
    label: "Open Food Facts",
    productId: food.code,
    url: `https://world.openfoodfacts.org/product/${food.code}`,
  };
  const packageGrams =
    food.packageGrams !== null && Number.isFinite(food.packageGrams) && food.packageGrams > 0
      ? food.packageGrams
      : null;
  return {
    food: {
      name: food.name,
      barcode: food.code,
      source,
      packageBasis: packageGrams === null ? null : { amount: packageGrams, unit: "g" },
      servingSize: null,
      servingsPerPackage: null,
    },
    nutrition: {
      proteinG: food.proteinG,
      energyKcal: food.kcal,
      basis: { amount: 100, unit: "g" },
      source,
    },
  };
}

export function catalogProteinPer100Kcal(food: CatalogFood): number | null {
  return food.kcal > 0 ? (food.proteinG / food.kcal) * 100 : null;
}

/** Uses the catalog's package grams, as the row formula requires. */
export function catalogProteinPerDollar(
  food: CatalogFood,
  price: { value: number; currency: string } | null,
): number | null {
  if (!price || food.packageGrams === null) return null;
  if (!Number.isFinite(food.packageGrams) || food.packageGrams <= 0) return null;
  const value = (food.proteinG * food.packageGrams) / 100 / price.value;
  return Number.isFinite(value) ? value : null;
}

/** A saved row's price, if the user or an observation already supplied one. */
export function catalogSavedPrice(item: MarketItem | undefined): { value: number; currency: string } | null {
  return item ? marketValues(item).price : null;
}
