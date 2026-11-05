import type {
  Basis,
  Candidate,
  Food,
  Nutrition,
  PackageSize,
  Source,
} from "../../contracts/types";

export type EnrichDependencies = {
  lookupBarcode(code: string): Promise<Food[]>;
  searchFood(query: string): Promise<Food[]>;
  nutritionForFood(id: string): Promise<Nutrition | null>;
  timeoutMs?: number;
};

type Match = { food: Food; nutrition: Nutrition };
type ScoredMatch = Match & { score: number };

const DEFAULT_TIMEOUT_MS = 2500;
const MAX_SEARCH_RESULTS = 8;
const MATCH_THRESHOLD = 0.5;
const BARCODE = /^\d{4,24}$/;
const OFF_ORIGIN = "https://world.openfoodfacts.org";
const NAME_MATCH_NOTE =
  "Nutrition matched by name from Open Food Facts - check it.";

// Words that carry no product identity when comparing names. Unit tokens and
// pure numbers are dropped separately so quantities cannot inflate a score.
const STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "of",
  "greek",
  "plain",
  "original",
  "classic",
  "nonfat",
  "with",
  "in",
  "a",
]);
const UNIT_TOKENS = new Set(["g", "kg", "oz", "lb", "ml", "l", "kcal", "cal"]);
const CURRENCY_SYMBOLS = /[$€£¥₹₽₩]/g;
const CURRENCY_CODE = /\b(?:usd|eur|gbp|cad|aud|jpy|inr|chf)\b\.?/gi;
const NET_WEIGHT =
  /\bnet\s*(?:wt|weight)\b\.?|\bnet\b\.?|\bwt\b\.?|\bweight\b\.?/gi;
const QUANTITY =
  /\b\d+(?:[.,]\d+)?\s*(?:fl\.?\s*oz|kg|g|mg|oz|lbs?|lb|ml|cl|kcal|cal|l)\b/gi;
const NUMBER = /\b\d+(?:[.,]\d+)?\b/g;
const UNIT_WORDS =
  /\b(?:kilograms?|grams?|ounces?|pounds?|millilit(?:er|re)s?|lit(?:er|re)s?|fluid|kg|kcal|ml|lbs?|oz|cal|cl|g|l)\b/gi;

function hasLabelNutrition(nutrition: Nutrition | null): boolean {
  return (
    nutrition !== null &&
    (nutrition.proteinG !== null || nutrition.energyKcal !== null)
  );
}

function identifier(food: Food): string | null {
  const value = food.barcode ?? food.id ?? null;
  return value !== null && BARCODE.test(value) ? value : null;
}

/** Lowercase, strip diacritics, and split into comparable words. */
function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bnon[\s-]?fat\b/g, " nonfat ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function distinctiveTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of words(value)) {
    if (/^\p{N}+$/u.test(token)) continue;
    if (STOPWORDS.has(token) || UNIT_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Removes prices, net weights and quantities while keeping product words. */
function searchQuery(value: string): string {
  return value
    .replace(CURRENCY_SYMBOLS, " ")
    .replace(CURRENCY_CODE, " ")
    .replace(NET_WEIGHT, " ")
    .replace(QUANTITY, " ")
    .replace(NUMBER, " ")
    .replace(UNIT_WORDS, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!?-]+|[\s,;:.!?-]+$/g, "")
    .trim();
}

function packageSizeFor(basis: Basis): PackageSize | null {
  switch (basis.unit) {
    case "g":
    case "kg":
    case "ml":
      return { amount: basis.amount, unit: basis.unit };
    case "l":
      return { amount: basis.amount * 1000, unit: "ml" };
    default:
      return null;
  }
}

function gramsFor(basis: Basis): number | null {
  if (!Number.isFinite(basis.amount) || basis.amount <= 0) return null;
  if (basis.unit === "g") return basis.amount;
  if (basis.unit === "kg") return basis.amount * 1000;
  return null;
}

async function bestNameMatch(
  foods: Food[],
  itemName: string,
  deps: EnrichDependencies,
): Promise<ScoredMatch | null> {
  if (!Array.isArray(foods)) return null;
  const itemTokens = distinctiveTokens(itemName);
  if (itemTokens.size === 0) return null;

  const scored: { food: Food; score: number }[] = [];
  for (const food of foods.slice(0, MAX_SEARCH_RESULTS)) {
    if (!food || typeof food.name !== "string") continue;
    let shared = 0;
    for (const token of distinctiveTokens(food.name)) {
      if (itemTokens.has(token)) shared++;
    }
    if (shared === 0) continue;
    scored.push({ food, score: shared / itemTokens.size });
  }
  // Stable sort keeps the earlier OFF result for equal scores.
  scored.sort((left, right) => right.score - left.score);

  for (const candidate of scored) {
    const id = identifier(candidate.food);
    if (id === null) continue;
    const nutrition = await deps.nutritionForFood(id);
    if (nutrition !== null) {
      return { food: candidate.food, nutrition, score: candidate.score };
    }
  }
  return null;
}

function addNote(uncertainties: string[], note: string): string[] {
  return uncertainties.includes(note) ? uncertainties : [...uncertainties, note];
}

function withMatch(
  candidate: Candidate,
  match: Match,
  extraNote?: string,
): Candidate {
  const { food, nutrition } = match;
  const productId =
    nutrition.source.productId ??
    food.source.productId ??
    food.id ??
    food.barcode;
  const url =
    nutrition.source.url ??
    food.source.url ??
    (productId ? `${OFF_ORIGIN}/product/${productId}` : undefined);
  const source: Source = { kind: "off", label: "Open Food Facts" };
  if (url) source.url = url;
  if (productId) source.productId = productId;

  const note = `Nutrition filled from Open Food Facts for "${food.name}" - check it.`;
  let uncertainties = Array.isArray(candidate.uncertainties)
    ? candidate.uncertainties
    : [];
  uncertainties = addNote(uncertainties, note);
  if (extraNote) uncertainties = addNote(uncertainties, extraNote);
  const result: Candidate = {
    ...candidate,
    labelNutrition: {
      proteinG: nutrition.proteinG,
      energyKcal: nutrition.energyKcal,
      basis: nutrition.basis,
      source,
    },
    barcode:
      candidate.barcode ?? food.barcode ?? (food.id && BARCODE.test(food.id) ? food.id : null),
    uncertainties,
  };

  if (result.packageSize == null && food.packageBasis) {
    const size = packageSizeFor(food.packageBasis);
    if (size) result.packageSize = size;
  }
  if (result.packageSizeGrams == null && food.packageBasis) {
    const grams = gramsFor(food.packageBasis);
    if (grams !== null) result.packageSizeGrams = grams;
  }
  return result;
}

async function resolve(
  candidate: Candidate,
  deps: EnrichDependencies,
): Promise<Candidate> {
  if (candidate.barcode !== null && BARCODE.test(candidate.barcode)) {
    const foods = await deps.lookupBarcode(candidate.barcode);
    const first = Array.isArray(foods) ? foods[0] : undefined;

    if (first) {
      const id = identifier(first);
      if (id !== null) {
        const nutrition = await deps.nutritionForFood(id);
        if (nutrition !== null) return withMatch(candidate, { food: first, nutrition });
      }
    }

    // A barcode that resolves to no usable nutrition still leaves the printed
    // name as a useful search term; try it exactly once.
    const reference = candidate.item?.trim() || first?.name?.trim() || "";
    const query = searchQuery(reference);
    if (query) {
      const match = await bestNameMatch(
        await deps.searchFood(query),
        reference,
        deps,
      );
      if (match) {
        return withMatch(
          candidate,
          match,
          match.score >= MATCH_THRESHOLD ? undefined : NAME_MATCH_NOTE,
        );
      }
    }
    return candidate;
  }

  const item = candidate.item ?? "";
  if (item.replace(/\s+/g, "").length < 3) return candidate;
  if (distinctiveTokens(item).size === 0) return candidate;
  const query = searchQuery(item);
  if (!query) return candidate;
  const match = await bestNameMatch(await deps.searchFood(query), item, deps);
  return match
    ? withMatch(
        candidate,
        match,
        match.score >= MATCH_THRESHOLD ? undefined : NAME_MATCH_NOTE,
      )
    : candidate;
}

function timeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}

async function withinBudget<T>(work: Promise<T>, budget: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("enrichment timeout")), budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fills a missing nutrition panel from Open Food Facts. This is best effort:
 * any failure, timeout, or empty result returns the candidate unchanged so
 * enrichment can never fail a scan.
 */
export async function enrichCandidate(
  candidate: Candidate,
  deps: EnrichDependencies,
): Promise<Candidate> {
  // A printed label beats a database.
  if (hasLabelNutrition(candidate.labelNutrition)) return candidate;
  try {
    return await withinBudget(resolve(candidate, deps), timeoutMs(deps.timeoutMs));
  } catch {
    return candidate;
  }
}
