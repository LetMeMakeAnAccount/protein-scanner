import type { Basis, Food } from "../contracts/types";
import { basisSchema } from "../contracts/schemas";

type Physical = { dimension: "mass" | "volume"; quantity: number };

function physical(basis: Basis | null): Physical | null {
  if (!basis || !basisSchema.safeParse(basis).success) return null;
  let result: Physical;
  switch (basis.unit) {
    case "g": result = { dimension: "mass", quantity: basis.amount }; break;
    case "kg": result = { dimension: "mass", quantity: basis.amount * 1000 }; break;
    case "ml": result = { dimension: "volume", quantity: basis.amount }; break;
    case "l": result = { dimension: "volume", quantity: basis.amount * 1000 }; break;
    default: return null;
  }
  return Number.isFinite(result.quantity) && result.quantity > 0 ? result : null;
}

/** Convert a value per `from` basis to a value per `to` basis, not a physical amount. */
export function convertBasis(amount: number, from: Basis, to: Basis, food: Food): number | null {
  if (!Number.isFinite(amount) || amount < 0 || !basisSchema.safeParse(from).success || !basisSchema.safeParse(to).success) return null;
  const packageCount = food.packageBasis?.count;
  for (const basis of [from, to]) {
    if (basis.unit === "serving" && basis.count !== undefined) return null;
    if (basis.unit === "package" && basis.count !== undefined && basis.count !== packageCount) return null;
  }

  const directFrom = physical(from);
  const directTo = physical(to);
  if (directFrom && directTo) {
    if (directFrom.dimension !== directTo.dimension) return null;
    const result = amount * (directTo.quantity / directFrom.quantity);
    return Number.isFinite(result) && (amount === 0 || result > 0) ? result : null;
  }

  let pack = physical(food.packageBasis);
  let serving = physical(food.servingSize);
  const servings = food.servingsPerPackage;
  if (servings !== null && (!Number.isFinite(servings) || servings <= 0)) return null;
  if (pack && serving && servings !== null) {
    if (pack.dimension !== serving.dimension) return null;
    const expected = serving.quantity * servings;
    if (!Number.isFinite(expected) || Math.abs(pack.quantity - expected) > 1e-9 * Math.max(pack.quantity, expected)) return null;
  }
  if (!pack && serving && servings !== null) pack = { dimension: serving.dimension, quantity: serving.quantity * servings };
  if (!serving && pack && servings !== null) serving = { dimension: pack.dimension, quantity: pack.quantity / servings };

  if (from.unit === to.unit && (from.unit === "serving" || from.unit === "package")) {
    const result = amount * (to.amount / from.amount);
    return Number.isFinite(result) && (amount === 0 || result > 0) ? result : null;
  }
  if ((from.unit === "serving" && to.unit === "package") || (from.unit === "package" && to.unit === "serving")) {
    if (servings === null) return null;
    const factor = from.unit === "serving" ? servings : 1 / servings;
    const result = amount * (to.amount / from.amount) * factor;
    return Number.isFinite(result) && (amount === 0 || result > 0) ? result : null;
  }
  const resolve = (basis: Basis): Physical | null => {
    if (basis.unit === "package" && pack) return { dimension: pack.dimension, quantity: pack.quantity * basis.amount };
    if (basis.unit === "serving" && serving) return { dimension: serving.dimension, quantity: serving.quantity * basis.amount };
    return physical(basis);
  };
  const source = resolve(from);
  const target = resolve(to);
  if (!source || !target || source.dimension !== target.dimension || !Number.isFinite(source.quantity) || !Number.isFinite(target.quantity) || source.quantity <= 0 || target.quantity <= 0) return null;
  const result = amount * (target.quantity / source.quantity);
  return Number.isFinite(result) && (amount === 0 || result > 0) ? result : null;
}
