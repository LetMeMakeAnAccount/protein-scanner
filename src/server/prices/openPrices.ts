export type PricePer = "UNIT" | "KG" | "L";

export type PriceObservation = {
  price: number;
  currency: string;
  date: string | null;
  store: string | null;
  city: string | null;
  country: string | null;
  pricePer: PricePer | null;
  discounted: boolean;
  source: "open_prices";
};

type Fetch = typeof globalThis.fetch;
type Options = { fetch?: Fetch; timeoutMs?: number };
type RecordValue = Record<string, unknown>;
type BoundedText = { ok: true; value: string | null } | { ok: false };

const origin = "https://prices.openfoodfacts.org";
const maxObservations = 5;
const maxUpstreamRows = 200;
const maxResponseBytes = 1_048_576;
const maxTextLength = 120;
const pricePerAliases = new Map<string, PricePer>([
  ["UNIT", "UNIT"],
  ["KG", "KG"],
  ["KILOGRAM", "KG"],
  ["L", "L"],
  ["LITER", "L"],
  ["LITRE", "L"],
]);

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function currency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
function boundedText(value: unknown): BoundedText {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  return trimmed.length <= maxTextLength ? { ok: true, value: trimmed } : { ok: false };
}
function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? candidate
    : null;
}
function pricePer(value: unknown): PricePer | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? pricePerAliases.get(value) : undefined;
}

function mapObservation(value: unknown, barcode: string): PriceObservation | null {
  const row = record(value);
  if (!row) return null;
  // Do not trust an upstream filter that may return another product's rows.
  if (row.product_code !== undefined && String(row.product_code) !== barcode) return null;
  const price = positiveNumber(row.price);
  const code = currency(row.currency);
  if (price === null || code === null || typeof row.price_is_discounted !== "boolean") return null;
  const location = record(row.location);
  const store = boundedText(row.store ?? location?.osm_name ?? location?.osm_brand);
  const city = boundedText(row.city ?? location?.osm_address_city ?? location?.city);
  const country = boundedText(row.country ?? location?.osm_address_country ?? location?.country);
  const per = pricePer(row.price_per);
  if (!store.ok || !city.ok || !country.ok || per === undefined) return null;
  return {
    price,
    currency: code,
    date: isoDate(row.date),
    store: store.value,
    city: city.value,
    country: country.value,
    pricePer: per,
    discounted: row.price_is_discounted,
    source: "open_prices",
  };
}

function newestFirst(a: PriceObservation, b: PriceObservation): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return b.date.localeCompare(a.date);
}

export function createOpenPricesClient(options: Options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  async function get(barcode: string): Promise<RecordValue> {
    const url = new URL("/api/v1/prices", origin);
    url.searchParams.set("product_code", barcode);
    url.searchParams.set("size", "100");
    url.searchParams.set("order_by", "-date");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await fetcher(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "ProteinScanner/0.1 (price observations)",
          },
        });
        if (!response.ok) throw new Error("bad response");
        const body = await response.text();
        if (body.length > maxResponseBytes) throw new Error("oversized response");
        const data = record(JSON.parse(body));
        if (!data) throw new Error("malformed response");
        return data;
      })();
      return await Promise.race([request, timeout]);
    } catch {
      throw new Error("Price observations unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async observationsFor(barcode: string): Promise<PriceObservation[]> {
      if (typeof barcode !== "string" || !/^\d{4,24}$/.test(barcode)) {
        throw new Error("Invalid barcode");
      }
      const data = await get(barcode);
      if (!Array.isArray(data.items)) throw new Error("Price observations unavailable");
      return data.items
        .slice(0, maxUpstreamRows)
        .map((value) => mapObservation(value, barcode))
        .filter((observation): observation is PriceObservation => observation !== null)
        .sort(newestFirst)
        .slice(0, maxObservations);
    },
  };
}

const defaultClient = createOpenPricesClient();
export const priceObservationsFor = defaultClient.observationsFor;
