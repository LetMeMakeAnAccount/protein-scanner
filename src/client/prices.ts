import type { ApiResponse, Food, Nutrition } from "../contracts/types";
import { formatNumber } from "./format";
import { nutritionPer100g } from "./history";
import { ApiError } from "./api";

export type PricePer = "UNIT" | "KG" | "L" | null;

/** One community price report from Open Prices. It is an observation, never a live shelf price. */
export type PriceObservation = {
  price: number;
  currency: string;
  date: string | null;
  store: string | null;
  city: string | null;
  country: string | null;
  pricePer: PricePer;
  discounted: boolean;
  source: "open_prices";
};

export type PriceData = { observations: PriceObservation[] };

/** Fetches the newest Open Prices observations for a barcode, newest first. */
export async function fetchPrices(barcode: string): Promise<PriceData> {
  let response: Response;
  try {
    response = await fetch(`/api/prices?barcode=${encodeURIComponent(barcode)}`);
  } catch {
    throw new ApiError("unavailable", "Could not reach the price service.");
  }
  let body: ApiResponse<PriceData> | null = null;
  try {
    body = (await response.json()) as ApiResponse<PriceData>;
  } catch {
    body = null;
  }
  if (body && body.ok) {
    if (!Array.isArray(body.data?.observations)) {
      throw new ApiError("unavailable", "The price service returned an unexpected answer.");
    }
    return body.data;
  }
  if (body && !body.ok) throw new ApiError(body.error.code, body.error.message);
  throw new ApiError("unavailable", "The price service did not respond properly.");
}

/** Pads a numeric barcode to GTIN-14, or null when it cannot be one. */
export function toGtin14(barcode: string | null | undefined): string | null {
  const digits = (barcode ?? "").trim();
  if (!/^\d{1,14}$/.test(digits)) return null;
  return digits.padStart(14, "0");
}

export type RetailerLink = { name: "Walmart" | "Instacart" | "Target"; href: string };

/**
 * Search links only. They are not price sources and no retailer price is stored.
 * Walmart needs a numeric barcode it can pad to GTIN-14; the other two need a name.
 */
export function retailerLinks(food: Pick<Food, "name" | "barcode">): RetailerLink[] {
  const name = food.name.trim();
  const gtin = toGtin14(food.barcode);
  const links: RetailerLink[] = [];
  if (gtin) {
    links.push({ name: "Walmart", href: `https://www.walmart.com/search?q=${encodeURIComponent(gtin)}` });
  }
  if (name) {
    links.push({ name: "Instacart", href: `https://www.instacart.com/store/s?k=${encodeURIComponent(name)}` });
    links.push({ name: "Target", href: `https://www.target.com/s?searchTerm=${encodeURIComponent(name)}` });
  }
  return links;
}

export type ProteinPerCurrency = { value: number; currency: string };

/**
 * Derives protein per currency unit from the newest observation only — never an
 * average and never a made-up price. A price per kg is converted exactly; a
 * price per unit is only used when the package weight is known.
 */
export function proteinPerDollar(
  food: Food,
  nutrition: Nutrition | null,
  observation: PriceObservation,
): ProteinPerCurrency | null {
  const proteinG = nutritionPer100g(food, nutrition).proteinG;
  if (proteinG === null || proteinG <= 0) return null;
  if (!Number.isFinite(observation.price) || observation.price <= 0) return null;

  let pricePer100g: number | null = null;
  if (observation.pricePer === "KG") {
    pricePer100g = observation.price / 10;
  } else if (observation.pricePer !== "L") {
    // UNIT (or an unspecified basis): use the package weight when it is known.
    const packageBasis = food.packageBasis;
    if (!packageBasis || !Number.isFinite(packageBasis.amount) || packageBasis.amount <= 0) return null;
    const grams = packageBasis.unit === "g" ? packageBasis.amount : packageBasis.unit === "kg" ? packageBasis.amount * 1000 : null;
    if (grams === null) return null;
    pricePer100g = (observation.price * 100) / grams;
  }

  if (pricePer100g === null || pricePer100g <= 0) return null;
  const value = proteinG / pricePer100g;
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, currency: observation.currency };
}

export function formatObservationPrice(observation: PriceObservation): string {
  return `${formatNumber(observation.price)} ${observation.currency}`;
}

export function observationLocation(observation: PriceObservation): string | null {
  const parts = [observation.city, observation.country].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(", ") : null;
}

export function pricePerLabel(pricePer: PricePer): string | null {
  if (pricePer === "KG") return "per kg";
  if (pricePer === "L") return "per L";
  if (pricePer === "UNIT") return "per unit";
  return null;
}
