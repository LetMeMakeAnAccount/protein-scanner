import type { Basis, Candidate, ConfirmedInput, Food, Nutrition, Source } from "../contracts/types";
import { EXAMPLE } from "../client/example";

export type PhysicalUnit = "g" | "kg" | "ml" | "l";

export const UNITS: PhysicalUnit[] = ["g", "kg", "ml", "l"];
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];

const USER_SOURCE: Source = { kind: "user", label: "Your entry" };
const FIXTURE_SOURCE: Source = { kind: "fixture", label: "Sample data (fixture)" };

export type Draft = {
  name: string;
  barcode: string;
  priceAmount: string;
  currency: string;
  priceSource: "user" | "label";
  packageAmount: string;
  packageUnit: PhysicalUnit;
  /** True when the package weight was filled in as a fallback rather than read. */
  packageEstimated: boolean;
  proteinG: string;
  energyKcal: string;
  basisAmount: string;
  basisUnit: PhysicalUnit;
  provenanceLabel: string;
  provenanceUrl: string;
  foodSource: Source;
  nutritionSource: Source;
  nutritionNote: string;
  uncertainties: string[];
  previewUrl: string | null;
  isExample: boolean;
};

export function emptyDraft(): Draft {
  return {
    name: "",
    barcode: "",
    priceAmount: "",
    currency: "USD",
    priceSource: "user",
    packageAmount: "",
    packageUnit: "g",
    packageEstimated: false,
    proteinG: "",
    energyKcal: "",
    basisAmount: "100",
    basisUnit: "g",
    provenanceLabel: "Your entry",
    provenanceUrl: "",
    foodSource: USER_SOURCE,
    nutritionSource: USER_SOURCE,
    nutritionNote: "",
    uncertainties: [],
    previewUrl: null,
    isExample: false,
  };
}

export function isPhysical(unit: Basis["unit"]): unit is PhysicalUnit {
  return (UNITS as string[]).includes(unit);
}

/** Exact mass conversion, used only when a candidate predates packageSizeGrams. */
function gramsFromPackageSize(candidate: Candidate): number | null {
  const size = candidate.packageSize;
  if (!size) return null;
  const factor = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 }[size.unit as "g" | "kg" | "oz" | "lb"];
  if (!factor || !Number.isFinite(size.amount) || size.amount <= 0) return null;
  const grams = size.amount * factor;
  return Number.isFinite(grams) && grams > 0 && grams <= 100_000 ? Math.round(grams * 100) / 100 : null;
}

function knownPackageGrams(candidate: Candidate): number | null {
  const grams = candidate.packageSizeGrams;
  if (grams === null) return null;
  if (typeof grams === "number" && Number.isFinite(grams) && grams > 0) return grams;
  return gramsFromPackageSize(candidate);
}

export function candidateToDraft(candidate: Candidate, previewUrl: string | null): Draft {
  const draft = emptyDraft();
  draft.name = candidate.item ?? "";
  draft.barcode = candidate.barcode ?? "";
  draft.previewUrl = previewUrl;
  draft.uncertainties = candidate.uncertainties;
  // Use the printed net weight when the scan could read it. A scan without a
  // usable weight starts at 100 g and marks it as an estimate so protein per
  // dollar is still useful.
  const grams = knownPackageGrams(candidate);
  if (grams !== null) {
    draft.packageAmount = String(grams);
    draft.packageUnit = "g";
    draft.packageEstimated = false;
  } else {
    draft.packageAmount = "100";
    draft.packageUnit = "g";
    draft.packageEstimated = true;
  }
  if (candidate.price) {
    draft.priceAmount = String(candidate.price.amount);
    draft.currency = candidate.price.currency;
    draft.priceSource = candidate.price.source;
  }
  if (candidate.labelNutrition) {
    const nutrition = candidate.labelNutrition;
    draft.proteinG = nutrition.proteinG === null ? "" : String(nutrition.proteinG);
    draft.energyKcal = nutrition.energyKcal === null ? "" : String(nutrition.energyKcal);
    if (isPhysical(nutrition.basis.unit)) {
      draft.basisAmount = String(nutrition.basis.amount);
      draft.basisUnit = nutrition.basis.unit;
    }
    draft.nutritionSource = nutrition.source;
    draft.provenanceLabel = "Meta label";
    draft.nutritionNote = "From label";
  } else if (candidate.item || candidate.price) {
    draft.provenanceLabel = "Meta scan — check it";
  }
  return draft;
}

export function exampleDraft(): Draft {
  const draft = emptyDraft();
  draft.name = EXAMPLE.name;
  draft.priceAmount = EXAMPLE.priceAmount;
  draft.currency = EXAMPLE.currency;
  draft.packageAmount = EXAMPLE.packageAmount;
  draft.packageUnit = EXAMPLE.packageUnit;
  draft.proteinG = EXAMPLE.proteinG;
  draft.energyKcal = EXAMPLE.energyKcal;
  draft.basisAmount = EXAMPLE.basisAmount;
  draft.basisUnit = EXAMPLE.basisUnit;
  draft.provenanceLabel = "Sample data (fixture)";
  draft.foodSource = FIXTURE_SOURCE;
  draft.nutritionSource = FIXTURE_SOURCE;
  draft.isExample = true;
  return draft;
}

export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The package weight used for maths, falling back to an explicit 100 g estimate. */
export function effectivePackage(draft: Draft): {
  amount: number;
  unit: PhysicalUnit;
  estimated: boolean;
} {
  const parsed = parseNumber(draft.packageAmount);
  if (parsed !== null && parsed > 0) {
    return { amount: parsed, unit: draft.packageUnit, estimated: draft.packageEstimated };
  }
  return { amount: 100, unit: "g", estimated: true };
}

/** Fills an unknown package weight with the labelled 100 g estimate. */
export function ensurePackageWeight(draft: Draft): Draft {
  const parsed = parseNumber(draft.packageAmount);
  if (parsed !== null && parsed > 0) return draft;
  return { ...draft, packageAmount: "100", packageUnit: "g", packageEstimated: true };
}

export function draftToInput(draft: Draft): ConfirmedInput {
  const packageInfo = effectivePackage(draft);
  const proteinG = parseNumber(draft.proteinG);
  const energyKcal = parseNumber(draft.energyKcal);
  const priceAmount = parseNumber(draft.priceAmount);
  const basisAmount = parseNumber(draft.basisAmount);

  const food: Food = {
    name: draft.name.trim() || "Item",
    ...(draft.barcode.trim() ? { barcode: draft.barcode.trim() } : {}),
    source: draft.foodSource,
    packageBasis: { amount: packageInfo.amount, unit: packageInfo.unit },
    servingSize: null,
    servingsPerPackage: null,
  };
  const nutrition: Nutrition | null =
    proteinG === null && energyKcal === null
      ? null
      : {
          proteinG,
          energyKcal,
          basis: { amount: basisAmount !== null && basisAmount > 0 ? basisAmount : 100, unit: draft.basisUnit },
          source: draft.nutritionSource,
        };
  const price: ConfirmedInput["price"] =
    priceAmount !== null && priceAmount > 0
      ? {
          amount: priceAmount,
          currency: draft.currency,
          basis: { amount: 1, unit: "package" },
          source: draft.priceSource,
        }
      : null;
  return { food, nutrition, price };
}

/** The short, honest provenance labels used on results. */
export function sourceTag(source: Source | null | undefined): string | null {
  if (!source) return null;
  switch (source.kind) {
    case "off":
      return "From Open Food Facts";
    case "label":
      return "From label";
    case "user":
      return "Your entry";
    default:
      return null;
  }
}
