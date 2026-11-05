import { describe, expect, it, vi } from "vitest";
import type { Candidate, Food, Nutrition } from "../../contracts/types";
import { enrichCandidate, type EnrichDependencies } from "./enrich";

const source = {
  kind: "off" as const,
  label: "Open Food Facts",
  url: "https://world.openfoodfacts.org/product/12345678",
  productId: "12345678",
};

function food(overrides: Partial<Food> = {}): Food {
  return {
    id: "12345678",
    name: "Protein bar",
    barcode: "12345678",
    source,
    packageBasis: { amount: 40, unit: "g" },
    servingSize: null,
    servingsPerPackage: null,
    ...overrides,
  };
}

function nutrition(overrides: Partial<Nutrition> = {}): Nutrition {
  return {
    proteinG: 10,
    energyKcal: 150,
    basis: { amount: 100, unit: "g" },
    source,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    item: null,
    barcode: null,
    price: null,
    labelNutrition: null,
    uncertainties: [],
    ...overrides,
  };
}

function deps(overrides: Partial<EnrichDependencies> = {}): EnrichDependencies {
  return {
    lookupBarcode: vi.fn(async () => []),
    searchFood: vi.fn(async () => []),
    nutritionForFood: vi.fn(async () => null),
    ...overrides,
  };
}

describe("enrichCandidate", () => {
  it("keeps usable label nutrition and performs no lookup", async () => {
    const label = {
      proteinG: 12,
      energyKcal: null,
      basis: { amount: 100, unit: "g" as const },
      source: { kind: "label" as const, label: "Label", visibleText: "protein 12 g" },
    };
    const input = candidate({
      item: "Protein bar",
      barcode: "12345678",
      labelNutrition: label,
    });
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    });

    await expect(enrichCandidate(input, dependencies)).resolves.toBe(input);
    expect(dependencies.lookupBarcode).not.toHaveBeenCalled();
    expect(dependencies.searchFood).not.toHaveBeenCalled();
    expect(dependencies.nutritionForFood).not.toHaveBeenCalled();
  });

  it("fills a barcode hit with OFF nutrition, barcode, package and one note", async () => {
    const input = candidate({ barcode: "12345678" });
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => [food()]),
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    const result = await enrichCandidate(input, dependencies);

    expect(dependencies.lookupBarcode).toHaveBeenCalledWith("12345678");
    expect(dependencies.nutritionForFood).toHaveBeenCalledWith("12345678");
    expect(dependencies.searchFood).not.toHaveBeenCalled();
    expect(result).not.toBe(input);
    expect(result.labelNutrition).toEqual({
      proteinG: 10,
      energyKcal: 150,
      basis: { amount: 100, unit: "g" },
      source: {
        kind: "off",
        label: "Open Food Facts",
        url: "https://world.openfoodfacts.org/product/12345678",
        productId: "12345678",
      },
    });
    expect(result.barcode).toBe("12345678");
    expect(result.packageSize).toEqual({ amount: 40, unit: "g" });
    expect(result.packageSizeGrams).toBe(40);
    expect(result.uncertainties).toEqual([
      'Nutrition filled from Open Food Facts for "Protein bar" - check it.',
    ]);
  });

  it("falls through from a nutrition-less barcode hit to one name search", async () => {
    const first = food({ id: "11111111", barcode: "11111111", name: "Unhelpful record" });
    const match = food({
      id: "22222222",
      barcode: "22222222",
      name: "Matched bar",
      source: {
        ...source,
        url: "https://world.openfoodfacts.org/product/22222222",
        productId: "22222222",
      },
    });
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => [first]),
      nutritionForFood: vi.fn(async (id) =>
        id === "22222222" ? nutrition({ source: match.source }) : null,
      ),
      searchFood: vi.fn(async () => [match]),
    });

    const result = await enrichCandidate(
      candidate({ barcode: "12345678", item: "matched bar" }),
      dependencies,
    );

    expect(dependencies.searchFood).toHaveBeenCalledTimes(1);
    expect(dependencies.searchFood).toHaveBeenCalledWith("matched bar");
    expect(result.labelNutrition?.proteinG).toBe(10);
    expect(result.barcode).toBe("12345678");
    expect(result.uncertainties[0]).toContain('"Matched bar"');
  });

  it("searches by the first record name when the candidate has no item", async () => {
    const first = food({ id: "11111111", barcode: "11111111", name: "Unhelpful record" });
    const match = food({ id: "22222222", barcode: "22222222", name: "Matched bar" });
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => [first]),
      nutritionForFood: vi.fn(async (id) =>
        id === "22222222" ? nutrition() : null,
      ),
      searchFood: vi.fn(async () => [match]),
    });

    await enrichCandidate(candidate({ barcode: "12345678" }), dependencies);

    expect(dependencies.searchFood).toHaveBeenCalledWith("Unhelpful record");
  });

  it("skips the best name match when it has no nutrition and uses the next", async () => {
    const foods = [
      food({ id: "11111111", barcode: "11111111", name: "Protein bar empty" }),
      food({ id: "22222222", barcode: "22222222", name: "Protein bar first" }),
      food({ id: "33333333", barcode: "33333333", name: "Protein bar later" }),
    ];
    const dependencies = deps({
      searchFood: vi.fn(async () => foods),
      nutritionForFood: vi.fn(async (id) =>
        id === "22222222"
          ? nutrition()
          : id === "33333333"
            ? nutrition({ proteinG: 99 })
            : null,
      ),
    });

    const result = await enrichCandidate(candidate({ item: "protein bar" }), dependencies);

    expect(dependencies.nutritionForFood).toHaveBeenCalledTimes(2);
    expect(result.labelNutrition?.proteinG).toBe(10);
    expect(result.uncertainties[0]).toContain('"Protein bar first"');
  });

  it("checks at most eight name-search results", async () => {
    const foods = Array.from({ length: 9 }, (_, index) =>
      food({
        id: `1000000${index}`,
        barcode: `1000000${index}`,
        name: `Protein bar ${index}`,
      }),
    );
    const dependencies = deps({
      searchFood: vi.fn(async () => foods),
      nutritionForFood: vi.fn(async (id) =>
        id === "10000008" ? nutrition() : null,
      ),
    });

    const input = candidate({ item: "protein bar" });
    await expect(enrichCandidate(input, dependencies)).resolves.toBe(input);
    expect(dependencies.nutritionForFood).toHaveBeenCalledTimes(8);
  });

  it("fills package grams from a kg package basis without replacing known values", async () => {
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => [
        food({ packageBasis: { amount: 1.5, unit: "kg" } }),
      ]),
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    const result = await enrichCandidate(candidate({ barcode: "12345678" }), dependencies);
    expect(result.packageSize).toEqual({ amount: 1.5, unit: "kg" });
    expect(result.packageSizeGrams).toBe(1500);

    const known = candidate({
      barcode: "12345678",
      packageSize: { amount: 200, unit: "ml" },
      packageSizeGrams: 200,
    });
    const kept = await enrichCandidate(known, dependencies);
    expect(kept.packageSize).toEqual({ amount: 200, unit: "ml" });
    expect(kept.packageSizeGrams).toBe(200);
  });

  it("appends the enrichment note exactly once", async () => {
    const note = 'Nutrition filled from Open Food Facts for "Protein bar" - check it.';
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => [food()]),
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    const first = await enrichCandidate(candidate({ barcode: "12345678" }), dependencies);
    const again = await enrichCandidate(
      candidate({ barcode: "12345678", uncertainties: [note] }),
      dependencies,
    );

    expect(first.uncertainties.filter((value) => value === note)).toHaveLength(1);
    expect(again.uncertainties).toEqual([note]);
  });

  it("leaves the candidate unchanged when a lookup rejects", async () => {
    const input = candidate({ barcode: "12345678" });
    const dependencies = deps({
      lookupBarcode: vi.fn(async () => {
        throw new Error("network detail");
      }),
    });

    await expect(enrichCandidate(input, dependencies)).resolves.toBe(input);
  });

  it("leaves the candidate unchanged when the deadline expires", async () => {
    const input = candidate({ barcode: "12345678" });
    const dependencies = deps({
      lookupBarcode: vi.fn(() => new Promise<Food[]>(() => {})),
      timeoutMs: 20,
    });

    const started = Date.now();
    await expect(enrichCandidate(input, dependencies)).resolves.toBe(input);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("leaves empty results and short names alone without searching", async () => {
    const empty = candidate({ barcode: "12345678" });
    const emptyDeps = deps();
    await expect(enrichCandidate(empty, emptyDeps)).resolves.toBe(empty);
    expect(emptyDeps.searchFood).not.toHaveBeenCalled();

    const short = candidate({ item: "ab" });
    const shortDeps = deps();
    await expect(enrichCandidate(short, shortDeps)).resolves.toBe(short);
    expect(shortDeps.lookupBarcode).not.toHaveBeenCalled();
    expect(shortDeps.searchFood).not.toHaveBeenCalled();
  });
});

describe("name search matching", () => {
  const matchedNote =
    "Nutrition matched by name from Open Food Facts - check it.";

  it("picks the best token match from noisy results", async () => {
    const rows = [
      food({ id: "20000001", barcode: "20000001", name: "Nutella Hazelnut Spread", packageBasis: null }),
      food({ id: "20000002", barcode: "20000002", name: "Danone Greek Yogurt", packageBasis: null }),
      food({ id: "20000003", barcode: "20000003", name: "Chobani Greek Yogurt Plain Nonfat", packageBasis: null }),
    ];
    const nutritionForFood = vi.fn(async (id: string) =>
      nutrition({ proteinG: id === "20000001" ? 1 : id === "20000002" ? 2 : 33 }),
    );
    const dependencies = deps({
      searchFood: vi.fn(async () => rows),
      nutritionForFood,
    });

    const result = await enrichCandidate(
      candidate({ item: "Chobani Greek Yogurt Plain Nonfat 32 oz" }),
      dependencies,
    );

    expect(result.labelNutrition?.proteinG).toBe(33);
    expect(nutritionForFood).toHaveBeenCalledTimes(1);
    expect(nutritionForFood).toHaveBeenCalledWith("20000003");
    expect(result.uncertainties).toEqual([
      'Nutrition filled from Open Food Facts for "Chobani Greek Yogurt Plain Nonfat" - check it.',
    ]);
  });

  it("picks the fairlife row for a Core Power name", async () => {
    const rows = [
      food({ id: "20000011", barcode: "20000011", name: "Nutella Hazelnut Spread", packageBasis: null }),
      food({ id: "20000012", barcode: "20000012", name: "Fairlife Core Power Chocolate", packageBasis: null }),
    ];
    const dependencies = deps({
      searchFood: vi.fn(async () => rows),
      nutritionForFood: vi.fn(async (id) =>
        nutrition({ proteinG: id === "20000012" ? 42 : 1 }),
      ),
    });

    const result = await enrichCandidate(
      candidate({ item: "fairlife Core Power chocolate" }),
      dependencies,
    );

    expect(result.labelNutrition?.proteinG).toBe(42);
    expect(result.uncertainties[0]).toContain('"Fairlife Core Power Chocolate"');
  });

  it("leaves the candidate unchanged when no result shares a distinctive token", async () => {
    const rows = [
      food({ id: "20000021", barcode: "20000021", name: "Nutella Hazelnut Spread", packageBasis: null }),
      food({ id: "20000022", barcode: "20000022", name: "Danone Yaourt Grec", packageBasis: null }),
    ];
    const dependencies = deps({
      searchFood: vi.fn(async () => rows),
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    const input = candidate({ item: "fairlife Core Power chocolate" });
    const result = await enrichCandidate(input, dependencies);

    expect(result).toBe(input);
    expect(result.labelNutrition).toBeNull();
    expect(result.uncertainties).toEqual([]);
    expect(dependencies.nutritionForFood).not.toHaveBeenCalled();
  });

  it("fills a low-score partial match and adds the by-name note", async () => {
    const rows = [
      food({ id: "20000031", barcode: "20000031", name: "Fairlife Vanilla Shake", packageBasis: null }),
    ];
    const dependencies = deps({
      searchFood: vi.fn(async () => rows),
      nutritionForFood: vi.fn(async () => nutrition({ proteinG: 18 })),
    });

    const result = await enrichCandidate(
      candidate({ item: "fairlife Core Power chocolate" }),
      dependencies,
    );

    expect(result.labelNutrition?.proteinG).toBe(18);
    expect(result.uncertainties).toEqual([
      'Nutrition filled from Open Food Facts for "Fairlife Vanilla Shake" - check it.',
      matchedNote,
    ]);
  });

  it("strips quantities, prices and net-weight words from the query", async () => {
    const searchFood = vi.fn(async () => [
      food({ id: "20000041", barcode: "20000041", name: "Chobani Greek Yogurt Plain Nonfat", packageBasis: null }),
    ]);
    const dependencies = deps({
      searchFood,
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    await enrichCandidate(
      candidate({ item: "Chobani Greek Yogurt Plain Nonfat 32 oz $5.49 Net Wt" }),
      dependencies,
    );

    expect(searchFood).toHaveBeenCalledWith("Chobani Greek Yogurt Plain Nonfat");
  });

  it("adds no match-quality note when the score reaches one half", async () => {
    const rows = [
      food({ id: "20000051", barcode: "20000051", name: "Chobani Snacks", packageBasis: null }),
    ];
    const dependencies = deps({
      searchFood: vi.fn(async () => rows),
      nutritionForFood: vi.fn(async () => nutrition()),
    });

    const result = await enrichCandidate(
      candidate({ item: "Chobani Greek Yogurt Plain Nonfat" }),
      dependencies,
    );

    expect(result.labelNutrition).not.toBeNull();
    expect(result.uncertainties).toEqual([
      'Nutrition filled from Open Food Facts for "Chobani Snacks" - check it.',
    ]);
  });
});
