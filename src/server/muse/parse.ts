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

/** Treat model output as untrusted candidate data, never as confirmed nutrition. */
export function parseMuseResponse(raw: unknown): Candidate {
  try {
    if (typeof raw === "string" && raw.length > 65536) throw new Error();
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parseCandidate(modelCandidate.parse(value));
  } catch {
    throw new Error("Invalid model response");
  }
}
