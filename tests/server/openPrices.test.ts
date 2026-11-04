import { describe, expect, it, vi } from "vitest";
import { createOpenPricesClient } from "../../src/server/prices/openPrices";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const item = (overrides: Record<string, unknown> = {}) => ({
  product_code: "12345678",
  price: 2.5,
  currency: "EUR",
  date: "2025-01-10",
  store: "Corner Shop",
  location: { osm_address_city: "Lyon", osm_address_country: "France" },
  price_per: "UNIT",
  price_is_discounted: false,
  ...overrides,
});
const page = (items: unknown[]) => ({ items, count: items.length, page: 1, page_size: 100 });

describe("Open Prices mapping", () => {
  it("maps observations and orders them newest first, with undated rows last", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(page([
        item({ date: "2025-01-01", price: 1 }),
        item({ date: "2025-03-01", price: 3, store: "  Market  ", price_per: "KILOGRAM", price_is_discounted: true }),
        item({ date: null, price: 4, location: null, store: null }),
        item({ date: "2025-02-01", price: 2, store: null, price_per: "LITER", location: { osm_address_city: "Paris", osm_address_country: "France", osm_name: "Carrefour" } }),
      ])),
    );
    const observations = await createOpenPricesClient({ fetch: fetcher }).observationsFor("12345678");
    expect(observations.map((observation) => observation.price)).toEqual([3, 2, 1, 4]);
    expect(observations[0]).toEqual({
      price: 3,
      currency: "EUR",
      date: "2025-03-01",
      store: "Market",
      city: "Lyon",
      country: "France",
      pricePer: "KG",
      discounted: true,
      source: "open_prices",
    });
    expect(observations[3]).toMatchObject({ date: null, store: null, city: null, country: null });
    expect(observations[1]).toMatchObject({ price: 2, pricePer: "L", store: "Carrefour" });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("https://prices.openfoodfacts.org/api/v1/prices?");
    expect(String(url)).toContain("product_code=12345678");
    expect(String(url)).toContain("size=100");
    expect(String(url)).toContain("order_by=-date");
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(String((init?.headers as Record<string, string>)["User-Agent"])).toContain("ProteinScanner");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops malformed rows but keeps valid rows from the same response", async () => {
    const fetcher = async () =>
      json(page([
        item(),
        item({ price: 0 }),
        item({ price: -2 }),
        item({ price: "2.50" }),
        item({ currency: "EU" }),
        item({ price_is_discounted: "false" }),
        item({ product_code: "99999999" }),
        item({ store: "x".repeat(121) }),
        item({ price_per: "SERVING" }),
        item({ date: "not-a-date", price_per: null, price: 7, location: {} }),
        item({ location: null, store: "  ", city: "  ", country: undefined }),
        null,
        [],
        "row",
      ]));
    const observations = await createOpenPricesClient({ fetch: fetcher }).observationsFor("12345678");
    expect(observations).toHaveLength(3);
    expect(observations[0]).toMatchObject({ price: 2.5, pricePer: "UNIT" });
    expect(observations[2]).toMatchObject({
      price: 7,
      date: null,
      pricePer: null,
      city: null,
      country: null,
      store: "Corner Shop",
    });
  });

  it("returns an empty list when no upstream row is valid", async () => {
    const fetch = async () => json(page([{ price: -1 }, { price: "free" }, {}]));
    expect(await createOpenPricesClient({ fetch }).observationsFor("12345678")).toEqual([]);
  });

  it("caps the result at five newest observations", async () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      item({ price: index + 1, date: `2025-01-0${index + 1}` }),
    );
    const observations = await createOpenPricesClient({ fetch: async () => json(page(rows)) }).observationsFor("12345678");
    expect(observations).toHaveLength(5);
    expect(observations.map((observation) => observation.price)).toEqual([8, 7, 6, 5, 4]);
  });

  it("exposes only the allowlisted observation fields and never upstream secrets", async () => {
    const fetcher = async () =>
      json(page([
        item({
          owner: "private@example.com",
          api_key: "upstream-secret",
          location: { osm_address_city: "Lyon", osm_address_country: "France", osm_lat: 45.7, secret: "hidden" },
        }),
      ]));
    const [observation] = await createOpenPricesClient({ fetch: fetcher }).observationsFor("12345678");
    expect(Object.keys(observation).sort()).toEqual([
      "city",
      "country",
      "currency",
      "date",
      "discounted",
      "price",
      "pricePer",
      "source",
      "store",
    ]);
    expect(JSON.stringify(observation)).not.toContain("private@example.com");
    expect(JSON.stringify(observation)).not.toContain("upstream-secret");
    expect(observation.source).toBe("open_prices");
  });

  it("fails closed on upstream errors, malformed envelopes and non-JSON", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => json({ items: [] }, 500),
      async () => new Response("<html>not json</html>", { status: 200 }),
      async () => json({ items: "nope" }),
      async () => json({}),
      async () => { throw new Error("network-secret"); },
    ];
    for (const fetch of cases) {
      await expect(createOpenPricesClient({ fetch: fetch as typeof globalThis.fetch }).observationsFor("12345678"))
        .rejects.toThrow("Price observations unavailable");
    }
  });

  it("aborts on timeout and rejects without leaking details", async () => {
    let aborted = false;
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted-secret"));
          });
        }),
    );
    const client = createOpenPricesClient({ fetch: fetch as typeof globalThis.fetch, timeoutMs: 10 });
    await expect(client.observationsFor("12345678")).rejects.toThrow("Price observations unavailable");
    expect(aborted).toBe(true);
  });

  it("rejects an invalid barcode before making a request", async () => {
    const fetch = vi.fn(async () => json(page([])));
    for (const code of ["", "123", "abcd", "../1234", "1".repeat(25)]) {
      await expect(createOpenPricesClient({ fetch }).observationsFor(code)).rejects.toThrow("Invalid barcode");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
