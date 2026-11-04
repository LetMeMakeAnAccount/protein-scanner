import { describe, expect, it, vi } from "vitest";
import { createPriceHandlers } from "../../src/server/composition";
import * as composition from "../../src/server/composition";
import { GET as pricesRoute } from "../../src/app/api/prices/route";
vi.mock("server-only", () => ({}));

const observation = {
  price: 2.5,
  currency: "EUR",
  date: "2025-01-10",
  store: "Corner Shop",
  city: "Lyon",
  country: "France",
  pricePer: "UNIT" as const,
  discounted: false,
  source: "open_prices" as const,
};
const request = (path: string) => new Request(`https://app.example${path}`);
const page = { items: [{ product_code: "12345678", price: 2.5, currency: "EUR", date: "2025-01-10", location: { osm_name: "Corner Shop", osm_address_city: "Lyon", osm_address_country: "France" }, price_per: "UNIT", price_is_discounted: false }] };

describe("Open Prices route", () => {
  it("returns observations under data.observations with no-store and source attribution", async () => {
    const observationsFor = vi.fn(async () => [observation]);
    const response = await createPriceHandlers({ observationsFor }).observations(request("/api/prices?barcode=12345678"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { observations: [observation] } });
    expect(observationsFor).toHaveBeenCalledWith("12345678");
    expect(JSON.stringify(observation)).not.toMatch(/key|secret|token/i);
  });

  it("rejects missing, malformed, duplicated and unknown parameters before any lookup", async () => {
    const observationsFor = vi.fn(async () => [observation]);
    const handlers = createPriceHandlers({ observationsFor });
    for (const path of [
      "/api/prices",
      "/api/prices?barcode=",
      "/api/prices?barcode=123",
      "/api/prices?barcode=abcd",
      "/api/prices?barcode=1234&barcode=1234",
      "/api/prices?barcode=1234&extra=1",
      "/api/prices?barcode=1234&barcode=5678",
    ]) {
      const response = await handlers.observations(request(path));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        ok: false,
        error: { code: "invalid_input", message: "Invalid input" },
      });
    }
    expect(observationsFor).not.toHaveBeenCalled();
  });

  it("caps a handler result at five observations", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ ...observation, price: index + 1 }));
    const response = await createPriceHandlers({ observationsFor: async () => many }).observations(request("/api/prices?barcode=12345678"));
    expect((await response.json()).data.observations).toHaveLength(5);
  });

  it("returns a generic no-store 503 when the upstream fails", async () => {
    const response = await createPriceHandlers({
      observationsFor: async () => { throw new Error("private-secret"); },
    }).observations(request("/api/prices?barcode=12345678"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("private-secret");
    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: { code: "unavailable", message: "Price observations unavailable" },
    });
  });

  it("wires the Next GET route through composition to the Open Prices adapter", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await pricesRoute(request("/api/prices?barcode=12345678"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true, data: { observations: [observation] } });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("prices.openfoodfacts.org");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has a production handler available on the composed services", async () => {
    const handlers = createPriceHandlers({ observationsFor: async () => [] });
    const spy = vi.spyOn(composition, "createProductionServices").mockReturnValue({ prices: () => handlers } as ReturnType<typeof composition.createProductionServices>);
    try {
      const response = await pricesRoute(request("/api/prices?barcode=12345678"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: { observations: [] } });
    } finally {
      spy.mockRestore();
    }
  });
});
