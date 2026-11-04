import type { Food, Nutrition } from "../contracts/types";
import type { FoodMatch } from "./api";
import { nutritionPer100g } from "./history";
import { proteinPerDollar, type PriceObservation } from "./prices";

export const MARKET_KEY = "protein-scanner-market-v1";
export const MARKET_LIMIT = 50;

/** One food the user pulled online, with anything they entered about it. */
export type MarketItem = {
  key: string;
  food: Food;
  nutrition: Nutrition | null;
  observations: PriceObservation[];
  packageWeightG: number | null;
  paidPrice: number | null;
  paidCurrency: string;
};

/**
 * Barcode when there is one, otherwise the lowercase name. Two rows never
 * stand for the same product once one of these keys matches.
 */
export function marketKey(food: Pick<Food, "name" | "barcode">): string {
  const barcode = (food.barcode ?? "").trim();
  if (barcode) return `barcode:${barcode}`;
  return `name:${food.name.trim().toLowerCase()}`;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isFood(value: unknown): value is Food {
  if (value === null || typeof value !== "object") return false;
  const food = value as Partial<Food>;
  return (
    typeof food.name === "string" &&
    food.name.trim().length > 0 &&
    food.source !== null &&
    typeof food.source === "object" &&
    typeof (food.source as { label?: unknown }).label === "string"
  );
}

function isNutrition(value: unknown): value is Nutrition {
  if (value === null || typeof value !== "object") return false;
  const nutrition = value as Partial<Nutrition>;
  return (
    (nutrition.proteinG === null || typeof nutrition.proteinG === "number") &&
    (nutrition.energyKcal === null || typeof nutrition.energyKcal === "number") &&
    nutrition.basis !== null &&
    typeof nutrition.basis === "object" &&
    typeof (nutrition.basis as { amount?: unknown }).amount === "number"
  );
}

function isObservation(value: unknown): value is PriceObservation {
  if (value === null || typeof value !== "object") return false;
  const observation = value as Partial<PriceObservation>;
  return (
    typeof observation.price === "number" &&
    Number.isFinite(observation.price) &&
    observation.price > 0 &&
    typeof observation.currency === "string" &&
    observation.currency.trim().length > 0 &&
    (observation.date === null || typeof observation.date === "string") &&
    (observation.store === null || typeof observation.store === "string") &&
    (observation.city === null || typeof observation.city === "string") &&
    (observation.country === null || typeof observation.country === "string") &&
    (observation.pricePer === null || observation.pricePer === "UNIT" || observation.pricePer === "KG" || observation.pricePer === "L") &&
    typeof observation.discounted === "boolean" &&
    observation.source === "open_prices"
  );
}

function normalizeItem(value: unknown): MarketItem | null {
  if (value === null || typeof value !== "object") return null;
  const item = value as Partial<MarketItem>;
  if (!isFood(item.food)) return null;
  const observations = Array.isArray(item.observations)
    ? item.observations.filter(isObservation).slice(0, 5)
    : [];
  const nutrition = isNutrition(item.nutrition) ? item.nutrition : null;
  const currency =
    typeof item.paidCurrency === "string" && item.paidCurrency.trim()
      ? item.paidCurrency.trim()
      : observations[0]?.currency ?? "USD";
  return {
    key: marketKey(item.food),
    food: item.food,
    nutrition,
    observations,
    packageWeightG: positiveNumber(item.packageWeightG),
    paidPrice: positiveNumber(item.paidPrice),
    paidCurrency: currency,
  };
}

/** Saved rows live only in this browser. Broken or foreign records are ignored. */
export function loadMarket(storage: Pick<Storage, "getItem"> = localStorage): MarketItem[] {
  try {
    const raw = storage.getItem(MARKET_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: MarketItem[] = [];
    for (const value of parsed) {
      const item = normalizeItem(value);
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      result.push(item);
      if (result.length >= MARKET_LIMIT) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function saveMarket(items: MarketItem[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(MARKET_KEY, JSON.stringify(items.slice(0, MARKET_LIMIT)));
}

/** Adds a food at the top, refreshing its record while keeping anything the user entered. */
export function upsertMarketItem(
  items: MarketItem[],
  match: FoodMatch,
  observations?: PriceObservation[],
): { items: MarketItem[]; item: MarketItem } {
  const key = marketKey(match.food);
  const existing = items.find((entry) => entry.key === key);
  const item: MarketItem = {
    key,
    food: match.food,
    nutrition: match.nutrition,
    observations: observations ?? existing?.observations ?? [],
    packageWeightG: existing?.packageWeightG ?? null,
    paidPrice: existing?.paidPrice ?? null,
    paidCurrency: existing?.paidCurrency ?? existing?.observations[0]?.currency ?? "USD",
  };
  return { items: [item, ...items.filter((entry) => entry.key !== key)].slice(0, MARKET_LIMIT), item };
}

export function patchMarketItem(
  items: MarketItem[],
  key: string,
  patch: Partial<Pick<MarketItem, "packageWeightG" | "paidPrice" | "paidCurrency">>,
): MarketItem[] {
  return items.map((item) => (item.key === key ? { ...item, ...patch } : item));
}

export function removeMarketItem(items: MarketItem[], key: string): MarketItem[] {
  return items.filter((item) => item.key !== key);
}

/** Package grams the user entered, or the package size already listed for the food. */
export function packageGrams(item: MarketItem): number | null {
  if (item.packageWeightG !== null) return item.packageWeightG;
  const basis = item.food.packageBasis;
  if (!basis || !Number.isFinite(basis.amount) || basis.amount <= 0) return null;
  if (basis.unit === "g") return basis.amount;
  if (basis.unit === "kg") return basis.amount * 1000;
  return null;
}

export type MarketValues = {
  proteinG: number | null;
  energyKcal: number | null;
  price: { value: number; currency: string } | null;
  proteinPerCurrency: { value: number; currency: string } | null;
  proteinPer100Kcal: number | null;
};

/**
 * The compact row values. An entered price is shown over an observation, and
 * ratios are only produced from values that are actually known — never filled in.
 */
export function marketValues(item: MarketItem): MarketValues {
  const per100g = nutritionPer100g(item.food, item.nutrition);
  const latest = item.observations[0] ?? null;
  const paidPrice = positiveNumber(item.paidPrice);
  const price =
    paidPrice !== null
      ? { value: paidPrice, currency: item.paidCurrency }
      : latest
        ? { value: latest.price, currency: latest.currency }
        : null;

  let proteinPerCurrency: MarketValues["proteinPerCurrency"] = null;
  if (per100g.proteinG !== null && per100g.proteinG > 0) {
    if (paidPrice !== null) {
      const grams = packageGrams(item);
      if (grams !== null) {
        proteinPerCurrency = {
          value: (per100g.proteinG * grams) / 100 / paidPrice,
          currency: item.paidCurrency,
        };
      }
    } else if (latest) {
      const food: Food =
        item.packageWeightG !== null
          ? { ...item.food, packageBasis: { amount: item.packageWeightG, unit: "g" } }
          : item.food;
      proteinPerCurrency = proteinPerDollar(food, item.nutrition, latest);
    }
  }

  const proteinPer100Kcal =
    per100g.proteinG !== null && per100g.energyKcal !== null && per100g.energyKcal > 0
      ? (per100g.proteinG / per100g.energyKcal) * 100
      : null;

  return {
    proteinG: per100g.proteinG,
    energyKcal: per100g.energyKcal,
    price,
    proteinPerCurrency,
    proteinPer100Kcal,
  };
}
