import { describe, expect, it, vi } from "vitest";
import { createLookupHandlers } from "../../src/server/composition";
import * as composition from "../../src/server/composition";
import { GET as lookupRoute } from "../../src/app/api/foods/lookup/route";
import { GET as searchRoute } from "../../src/app/api/foods/search/route";
vi.mock("server-only", () => ({}));
const source = { kind: "off" as const, label: "Open Food Facts", productId: "12345678", url: "https://world.openfoodfacts.org/product/12345678" };
const food = { id: "12345678", barcode: "12345678", name: "Oats", source, packageBasis: { amount: 200, unit: "g" as const }, servingSize: null, servingsPerPackage: null };
const nutrition = { proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" as const }, source };
const request = (path: string) => new Request(`https://app.example${path}`);

describe("OFF lookup routes", () => {
  it("routes through the real OFF adapter with mocked HTTP and attribution", async () => {
    const product = { code: "12345678", product_name: "Oats", product_quantity: 200, product_quantity_unit: "g", nutriments: { proteins_100g: 10, "energy-kcal_100g": 100 } };
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("search.pl") ? { products: [product] } : { status: 1, product }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const lookup = (await (await lookupRoute(request("/api/foods/lookup?barcode=12345678"))).json()).data;
      const search = (await (await searchRoute(request("/api/foods/search?q=oats"))).json()).data;
      expect(lookup[0].food.source).toEqual(source);
      expect(lookup[0].nutrition).toEqual(nutrition);
      expect(search).toEqual(lookup);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally { vi.unstubAllGlobals(); }
  });
  it("wires both Next GET routes to the configured OFF handler", async () => {
    const handlers = createLookupHandlers({ lookupBarcode: async () => [food], searchFood: async () => [food], nutritionForFood: async () => nutrition });
    const spy = vi.spyOn(composition, "createProductionServices").mockReturnValue({ lookup: () => handlers } as ReturnType<typeof composition.createProductionServices>);
    try {
      expect((await (await lookupRoute(request("/api/foods/lookup?barcode=12345678"))).json()).data).toEqual([{ food, nutrition }]);
      expect((await (await searchRoute(request("/api/foods/search?q=oats"))).json()).data).toEqual([{ food, nutrition }]);
    } finally { spy.mockRestore(); }
  });
  it("returns attributed candidates and their available nutrition", async () => {
    const lookupBarcode = vi.fn().mockResolvedValue([food]), searchFood = vi.fn().mockResolvedValue([food]), nutritionForFood = vi.fn().mockResolvedValue(nutrition);
    const handlers = createLookupHandlers({ lookupBarcode, searchFood, nutritionForFood });
    const lookup = await handlers.lookup(request("/api/foods/lookup?barcode=12345678"));
    expect(lookup.status).toBe(200); expect((await lookup.json()).data).toEqual([{ food, nutrition }]);
    expect((await (await handlers.search(request("/api/foods/search?q=oats"))).json()).data).toEqual([{ food, nutrition }]);
    expect(lookup.headers.get("cache-control")).toBe("no-store");
  });
  it("returns honest empty/no-nutrition results and rejects invalid requests before lookup", async () => {
    const lookupBarcode = vi.fn().mockResolvedValue([]), searchFood = vi.fn().mockResolvedValue([food]), nutritionForFood = vi.fn().mockResolvedValue(null);
    const handlers = createLookupHandlers({ lookupBarcode, searchFood, nutritionForFood });
    expect((await (await handlers.lookup(request("/api/foods/lookup?barcode=12345678"))).json()).data).toEqual([]);
    expect((await (await handlers.search(request("/api/foods/search?q=oat"))).json()).data).toEqual([{ food, nutrition: null }]);
    for (const path of ["/api/foods/lookup", "/api/foods/lookup?barcode=abc", "/api/foods/lookup?barcode=1234&barcode=1234", "/api/foods/search?q=%20", "/api/foods/search?q=a&q=b"]) {
      expect((await (path.includes("lookup") ? handlers.lookup(request(path)) : handlers.search(request(path)))).status).toBe(400);
    }
    expect(lookupBarcode).toHaveBeenCalledTimes(1);
  });
  it("returns a generic no-store error on lookup or nutrition timeout", async () => {
    const handlers = createLookupHandlers({ lookupBarcode: async () => [food], searchFood: async () => { throw new Error("private-secret"); }, nutritionForFood: async () => { throw new Error("timeout-private-secret"); } });
    for (const response of [await handlers.lookup(request("/api/foods/lookup?barcode=12345678")), await handlers.search(request("/api/foods/search?q=oat"))]) {
      expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private-secret");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
