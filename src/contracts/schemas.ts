import { z } from "zod";
import type { Candidate, ConfirmedInput } from "./types";

const text = z.string().max(1000).refine((value) => value.trim().length > 0);
const longText = z.string().max(5000).refine((value) => value.trim().length > 0);
const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
const currency = z.string().regex(/^[A-Z]{3}$/).refine((value) => currencyCodes.has(value));
const date = z.union([z.string().date(), z.string().datetime({ offset: true })]);
const httpUrl = z.string().url().max(2048).refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
});

export const basisSchema = z.object({
  amount: positive,
  unit: z.enum(["g", "kg", "ml", "l", "serving", "package"]),
  count: z.number().finite().int().positive().safe().optional(),
}).strict();

export const sourceSchema = z.object({
  kind: z.enum(["off", "label", "user", "fixture"]),
  label: text,
  url: httpUrl.optional(),
  productId: text.optional(),
  visibleText: longText.optional(),
}).strict();

export const foodSchema = z.object({
  id: text.optional(),
  name: text,
  barcode: text.optional(),
  source: sourceSchema,
  packageBasis: basisSchema.nullable(),
  servingSize: basisSchema.nullable(),
  servingsPerPackage: positive.nullable(),
}).strict();

export const nutritionSchema = z.object({
  proteinG: nonnegative.nullable(),
  energyKcal: nonnegative.nullable(),
  basis: basisSchema,
  source: sourceSchema,
}).strict();

export const priceSchema = z.object({
  amount: positive,
  currency,
  basis: basisSchema,
  source: z.enum(["user", "label"]),
  observedAt: date.optional(),
}).strict();

export const confirmedInputSchema = z.object({
  food: foodSchema,
  nutrition: nutritionSchema.nullable(),
  price: priceSchema.nullable(),
}).strict();

export const candidateSchema = z.object({
  item: text.nullable(),
  barcode: text.nullable(),
  price: priceSchema.nullable(),
  labelNutrition: nutritionSchema.refine(
    (value) => value.source.kind === "label" && Boolean(value.source.visibleText),
  ).nullable(),
  uncertainties: z.array(text).max(100),
}).strict();

export const metricSchema = z.union([
  z.object({ value: nonnegative, unit: text }).strict(),
  z.object({ unavailable: text }).strict(),
]);
export const calculationSchema = z.object({
  proteinPerCurrency: metricSchema,
  proteinPer100Kcal: metricSchema,
}).strict();
export const imageInputSchema = z.object({ bytes: z.instanceof(Uint8Array), mediaType: text }).strict();
export const analysisResultSchema = z.object({ candidate: candidateSchema }).strict();
export const diaryEntrySchema = z.object({
  id: text, food: foodSchema, nutrition: nutritionSchema.nullable(), amount: basisSchema, date,
}).strict();

/** Deliberately excludes input and validation details, which may contain sensitive text. */
export class ContractValidationError extends Error {
  constructor() {
    super("Invalid input");
    this.name = "ContractValidationError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ContractValidationError();
  return result.data;
}

export function parseCandidate(value: unknown): Candidate {
  return parse(candidateSchema, value);
}

export function parseConfirmedInput(value: unknown): ConfirmedInput {
  return parse(confirmedInputSchema, value);
}
