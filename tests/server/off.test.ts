import { describe, expect, it, vi } from "vitest";
import { createOffClient } from "../../src/server/nutrition/off";

const product = { code: "12345678", product_name: "Protein food", product_quantity: 200, product_quantity_unit: "g", nutriments: { proteins_100g: 10, "energy-kcal_100g": 100, energy_100g: 418 } };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

describe("Open Food Facts mapping", () => {
  it("returns selectable candidates with source provenance and kcal, never interpreting kJ as kcal", async () => {
    const fetcher = vi.fn(async () => response({ status: 1, product }));
    const client = createOffClient({ fetch: fetcher });
    const [food] = await client.lookupBarcode("12345678");
    expect(food).toMatchObject({ name: "Protein food", barcode: "12345678", packageBasis: { amount: 200, unit: "g" }, source: { kind: "off", productId: "12345678", url: "https://world.openfoodfacts.org/product/12345678" } });
    expect(await client.nutritionForFood("12345678")).toMatchObject({ proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" }, source: food.source });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const noKcal = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, nutriments: { energy_100g: 418 } } }) });
    expect(await noKcal.nutritionForFood("12345678")).toMatchObject({ proteinG: null, energyKcal: null });
  });
  it("does not fabricate missing, malformed, contradictory or liquid nutrition", async () => {
    for (const nutriments of [{}, { proteins_100g: -1, "energy-kcal_100g": "bad" }, { proteins_100g: Infinity }]) {
      const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, nutriments } }) });
      expect(await client.nutritionForFood("12345678")).toMatchObject({ proteinG: null, energyKcal: null });
    }
    const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, product_quantity_unit: "ml" } }) });
    expect(await client.nutritionForFood("12345678")).toBeNull();
    const ambiguous = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, product_quantity_unit: undefined, nutrition_data_per: "100g" } }) });
    expect(await ambiguous.nutritionForFood("12345678")).toBeNull();
  });
  it("searches without selecting a match, and exposes honest no-match", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ products: [product, { ...product, code: "87654321" }] }));
    const foods = await createOffClient({ fetch: fetcher }).searchFood("protein & food");
    expect(foods).toHaveLength(2);
    expect(String(fetcher.mock.calls[0][0])).toContain("search_terms=protein+%26+food");
    const missing = createOffClient({ fetch: async () => response({ status: 0 }) });
    expect(await missing.lookupBarcode("12345678")).toEqual([]);
    expect(await missing.nutritionForFood("12345678")).toBeNull();
  });
  it("accepts OFF's leading-zero normalization of UPC-A without losing canonical provenance", async () => {
    const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, code: "0036000291452" } }) });
    expect(await client.lookupBarcode("036000291452")).toMatchObject([{ barcode: "0036000291452", id: "0036000291452", source: { productId: "0036000291452", url: "https://world.openfoodfacts.org/product/0036000291452" } }]);
    expect(await client.nutritionForFood("036000291452")).toMatchObject({ proteinG: 10, source: { productId: "0036000291452" } });
    const unpadded = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, code: "036000291452" } }) });
    expect(await unpadded.lookupBarcode("0036000291452")).toMatchObject([{ barcode: "036000291452" }]);
  });
  it.each([
    ["036000291452", "0036000291453"],
    ["036000291452", "1036000291452"],
    ["036000291452", "00036000291452"],
    ["36000291452", "036000291452"],
    ["0036000291452", "0036000291453"],
  ])("rejects unrelated barcode %s returned as %s", async (query, returned) => {
    const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, code: returned } }) });
    await expect(client.lookupBarcode(query)).rejects.toThrow("Food lookup unavailable");
    await expect(client.nutritionForFood(query)).rejects.toThrow("Food lookup unavailable");
  });
  it("does not assert a package total from ambiguous or conflicting quantity text", async () => {
    for (const quantity of ["4 x 125 g", "500 g"]) {
      const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, quantity } }) });
      expect((await client.lookupBarcode("12345678"))[0].packageBasis).toBeNull();
    }
    const client = createOffClient({ fetch: async () => response({ status: 1, product: { ...product, quantity: "0.2 kg" } }) });
    expect((await client.lookupBarcode("12345678"))[0].packageBasis).toEqual({ amount: 200, unit: "g" });
  });
  it("rejects invalid identifiers, network errors, timeout and malformed responses explicitly", async () => {
    const fetcher = vi.fn(async () => response({}));
    await expect(createOffClient({ fetch: fetcher }).lookupBarcode("../bad")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createOffClient({ fetch: async () => { throw new Error("network detail"); } }).lookupBarcode("12345678")).rejects.toThrow("Food lookup unavailable");
    await expect(createOffClient({ fetch: () => new Promise(() => {}), timeoutMs: 5 }).lookupBarcode("12345678")).rejects.toThrow("Food lookup unavailable");
    await expect(createOffClient({ fetch: async () => response({ status: 1, product: {} }) }).lookupBarcode("12345678")).rejects.toThrow("Food lookup unavailable");
    await expect(createOffClient({ fetch: async () => response({ status: 1, product: { ...product, code: "87654321" } }) }).lookupBarcode("12345678")).rejects.toThrow("Food lookup unavailable");
  });
});
