import type { Basis, Food, Nutrition, Source } from "../../contracts/types";

type Fetch = typeof globalThis.fetch;
type Options = { fetch?: Fetch; timeoutMs?: number };
type RecordValue = Record<string, unknown>;
const origin = "https://world.openfoodfacts.org";
const maxResponseBytes = 1_048_576;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function barcode(value: unknown): value is string {
  return typeof value === "string" && /^\d{4,24}$/.test(value);
}
function normalizedBarcode(value: string): string {
  return value.length === 12 ? `0${value}` : value;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function mapFood(value: unknown): Food | null {
  const product = record(value);
  if (!product || !barcode(product.code) || typeof product.product_name !== "string" || !product.product_name.trim() || product.product_name.length > 1000) return null;
  const id = product.code;
  const source: Source = { kind: "off", label: "Open Food Facts", productId: id, url: `${origin}/product/${id}` };
  const quantity = number(product.product_quantity);
  const unit = product.product_quantity_unit;
  let packageBasis: Basis | null = null;
  if (quantity !== null && quantity > 0 && (unit === "g" || unit === "kg" || unit === "ml" || unit === "l")) {
    let agrees = true;
    if (product.quantity !== undefined && product.quantity !== null && product.quantity !== "") {
      const match = typeof product.quantity === "string" ? /^\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\s*$/i.exec(product.quantity) : null;
      if (!match) agrees = false;
      else {
        const reported = Number(match[1].replace(",", "."));
        const reportedUnit = match[2].toLowerCase();
        const dimension = unit === "g" || unit === "kg" ? "mass" : "volume";
        const reportedDimension = reportedUnit === "g" || reportedUnit === "kg" ? "mass" : "volume";
        const normalized = quantity * (unit === "kg" || unit === "l" ? 1000 : 1);
        const reportedNormalized = reported * (reportedUnit === "kg" || reportedUnit === "l" ? 1000 : 1);
        agrees = dimension === reportedDimension && Number.isFinite(normalized) && Number.isFinite(reportedNormalized) && Math.abs(normalized - reportedNormalized) <= 1e-9 * Math.max(normalized, reportedNormalized);
      }
    }
    if (agrees) packageBasis = { amount: quantity, unit };
  }
  return { id, name: product.product_name, barcode: id, source, packageBasis, servingSize: null, servingsPerPackage: null };
}
function mapNutrition(value: unknown): Nutrition | null {
  const product = record(value);
  const food = mapFood(value);
  if (!product || !food) return null;
  const unit = product.product_quantity_unit;
  const declared = product.nutrition_data_per;
  const nutriments = record(product.nutriments) ?? {};
  // The declaration wins; otherwise the package's own unit decides. Without
  // either, the values could describe an unknown serving, so they are unusable.
  const basis: Basis | null =
    declared === "100g" || ((unit === "g" || unit === "kg") && declared !== "100ml")
      ? { amount: 100, unit: "g" }
      : declared === "100ml" || unit === "ml" || unit === "l"
        ? { amount: 100, unit: "ml" }
        : null;
  if (basis === null) return null;
  const proteinG = nutriments.proteins_unit === undefined || nutriments.proteins_unit === "g" ? number(nutriments.proteins_100g) : null;
  const energyKcal = nutriments["energy-kcal_unit"] === undefined || nutriments["energy-kcal_unit"] === "kcal" ? number(nutriments["energy-kcal_100g"]) : null;
  return { proteinG, energyKcal, basis, source: food.source };
}

export function createOffClient(options: Options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  async function get(url: string): Promise<RecordValue> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await fetcher(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "ProteinScanner/0.1 (food lookup)" } });
        if (!response.ok || !response.body) throw new Error("bad response");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.length;
            if (length > maxResponseBytes) { controller.abort(); throw new Error("oversized response"); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const data = record(JSON.parse(new TextDecoder().decode(bytes)));
        if (!data) throw new Error("malformed response");
        return data;
      })();
      return await Promise.race([request, timeout]);
    } catch { throw new Error("Food lookup unavailable"); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function productFor(id: string): Promise<unknown | null> {
    if (!barcode(id)) throw new Error("Invalid barcode");
    const data = await get(`${origin}/api/v2/product/${id}.json`);
    if (data.status === 0) return null;
    const food = mapFood(data.product);
    if (data.status !== 1 || !food?.barcode || normalizedBarcode(food.barcode) !== normalizedBarcode(id)) throw new Error("Food lookup unavailable");
    return data.product;
  }
  return {
    async lookupBarcode(code: string): Promise<Food[]> {
      const product = await productFor(code);
      return product === null ? [] : [mapFood(product)!];
    },
    async searchFood(query: string): Promise<Food[]> {
      if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("Invalid search");
      // The legacy cgi/search.pl endpoint is rate-limited to 503s; Search-a-licious
      // is the supported full-text service. Fall back to the legacy endpoint only
      // if the modern one is unavailable.
      const modern = new URLSearchParams({
        q: query.trim(),
        page_size: "20",
        fields: "code,product_name,brands,quantity",
      });
      let products: unknown[] | null = null;
      try {
        const data = await get(`https://search.openfoodfacts.org/search?${modern}`);
        if (Array.isArray(data.hits)) products = data.hits;
      } catch {
        // fall through to the legacy endpoint
      }
      if (products === null) {
        const legacy = new URLSearchParams({ search_terms: query.trim(), search_simple: "1", action: "process", json: "1", page_size: "20" });
        const data = await get(`${origin}/cgi/search.pl?${legacy}`);
        if (!Array.isArray(data.products)) throw new Error("Food lookup unavailable");
        products = data.products;
      }
      return products
        .slice(0, 20)
        .map((product) => mapFood(product))
        .filter((food): food is Food => food !== null);
    },
    async nutritionForFood(id: string): Promise<Nutrition | null> {
      const product = await productFor(id);
      return product === null ? null : mapNutrition(product);
    },
  };
}

const defaultClient = createOffClient();
export const lookupBarcode = defaultClient.lookupBarcode;
export const searchFood = defaultClient.searchFood;
export const nutritionForFood = defaultClient.nutritionForFood;
