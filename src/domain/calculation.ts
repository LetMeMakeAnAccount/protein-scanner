import type { Calculation, ConfirmedInput, Metric } from "../contracts/types";
import { foodSchema, nutritionSchema, priceSchema } from "../contracts/schemas";
import { convertBasis } from "./units";

const unavailable = (reason: string): Metric => ({ unavailable: reason });

export function calculate(input: ConfirmedInput): Calculation {
  const parsedNutrition = nutritionSchema.safeParse(input?.nutrition);
  const nutrition = parsedNutrition.success ? parsedNutrition.data : null;
  let proteinPerCurrency: Metric = unavailable("A valid price and matching nutrition quantity are required.");
  let proteinPer100Kcal: Metric = unavailable("Protein and positive kcal on the same basis are required.");
  if (nutrition?.proteinG !== null && nutrition?.proteinG !== undefined) {
    if (nutrition.energyKcal !== null && nutrition.energyKcal > 0) {
      const value = (nutrition.proteinG / nutrition.energyKcal) * 100;
      if (Number.isFinite(value)) proteinPer100Kcal = { value, unit: "g/100 kcal" };
    }
    const price = priceSchema.safeParse(input.price);
    const food = foodSchema.safeParse(input.food);
    if (price.success && food.success) {
      const protein = convertBasis(nutrition.proteinG, nutrition.basis, price.data.basis, food.data);
      if (protein !== null) {
        const value = protein / price.data.amount;
        if (Number.isFinite(value)) proteinPerCurrency = { value, unit: `g/${price.data.currency}` };
      }
    }
  }
  return { proteinPerCurrency, proteinPer100Kcal };
}
