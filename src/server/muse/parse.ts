import { z } from "zod";
import { basisSchema, nutritionSchema, parseCandidate, priceSchema, sourceSchema } from "../../contracts/schemas";
import type { Candidate } from "../../contracts/types";

const basis = basisSchema.omit({ count: true });
const labelSource = sourceSchema.pick({ label: true, visibleText: true }).extend({ kind: z.literal("label"), visibleText: sourceSchema.shape.visibleText.unwrap() }).strict();
const modelCandidate = z.object({
  item: z.string().max(1000).refine((value) => value.trim().length > 0).nullable(),
  barcode: z.string().max(1000).refine((value) => value.trim().length > 0).nullable(),
  price: priceSchema.omit({ observedAt: true }).extend({ basis, source: z.literal("label") }).strict().nullable(),
  labelNutrition: nutritionSchema.extend({ basis, source: labelSource }).strict().nullable(),
  uncertainties: z.array(z.string().max(1000).refine((value) => value.trim().length > 0)).max(100),
}).strict();

const MAX_PRICE = 100_000;
const MAX_PROTEIN_G = 100;
const MAX_ENERGY_KCAL = 900;
const MAX_UNCERTAINTIES = 100;
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));

const priceUncertainty = "Price looked implausible and was ignored; enter it yourself.";
const proteinUncertainty = "Protein value looked implausible and was ignored.";
const energyUncertainty = "Energy value looked implausible and was ignored.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlausibleNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isPlausiblePrice(price: Record<string, unknown>): boolean {
  if (typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount <= 0 || price.amount > MAX_PRICE) return false;
  if (typeof price.currency !== "string") return false;
  const currency = price.currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) && currencyCodes.has(currency);
}

function addUncertainty(uncertainties: unknown[], message: string): void {
  // The contract caps the list; keep screening from making an otherwise valid candidate invalid.
  if (uncertainties.length >= MAX_UNCERTAINTIES) uncertainties.shift();
  uncertainties.push(message);
}

/**
 * Screen model values for plausibility without discarding the candidate.
 * Structural problems are still left to the strict contract validation below.
 */
function screen(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const result: Record<string, unknown> = { ...raw };
  const uncertainties = Array.isArray(raw.uncertainties) ? [...raw.uncertainties] : null;

  if (typeof raw.item === "string") {
    const item = raw.item.trim();
    result.item = item.length > 0 ? item : null;
  }
  if (typeof raw.barcode === "string") {
    const barcode = raw.barcode.trim();
    result.barcode = barcode.length > 0 ? barcode : null;
  }

  if (isRecord(raw.price) && Object.hasOwn(raw.price, "amount") && Object.hasOwn(raw.price, "currency")) {
    const price = { ...raw.price };
    if (typeof price.currency === "string") price.currency = price.currency.trim().toUpperCase();
    if (isPlausiblePrice(price)) {
      result.price = price;
    } else {
      result.price = null;
      if (uncertainties) addUncertainty(uncertainties, priceUncertainty);
    }
  }

  if (isRecord(raw.labelNutrition)) {
    const nutrition = { ...raw.labelNutrition };
    if (Object.hasOwn(nutrition, "proteinG") && nutrition.proteinG !== null && !isPlausibleNumber(nutrition.proteinG, 0, MAX_PROTEIN_G)) {
      nutrition.proteinG = null;
      if (uncertainties) addUncertainty(uncertainties, proteinUncertainty);
    }
    if (Object.hasOwn(nutrition, "energyKcal") && nutrition.energyKcal !== null && !isPlausibleNumber(nutrition.energyKcal, 0, MAX_ENERGY_KCAL)) {
      nutrition.energyKcal = null;
      if (uncertainties) addUncertainty(uncertainties, energyUncertainty);
    }
    if (Object.hasOwn(nutrition, "proteinG") && Object.hasOwn(nutrition, "energyKcal") && nutrition.proteinG === null && nutrition.energyKcal === null) {
      result.labelNutrition = null;
    } else {
      result.labelNutrition = nutrition;
    }
  }

  if (uncertainties) result.uncertainties = uncertainties;
  return result;
}

function screenCandidate(raw: unknown): unknown {
  try {
    return screen(raw);
  } catch {
    // Screening must never reject a candidate that contract validation would accept.
    return raw;
  }
}

/** Treat model output as untrusted candidate data, never as confirmed nutrition. */
export function parseMuseResponse(raw: unknown): Candidate {
  try {
    if (typeof raw === "string" && raw.length > 65536) throw new Error();
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parseCandidate(modelCandidate.parse(screenCandidate(value)));
  } catch {
    throw new Error("Invalid model response");
  }
}
