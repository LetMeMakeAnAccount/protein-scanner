import { describe, expect, it, vi } from "vitest";
import { createOffImageClient } from "../../src/server/images/offImages";

const photo = "https://images.openfoodfacts.org/images/products/123/456/789/0123/front_en.3.200.jpg";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const product = (code: string, overrides: Record<string, unknown> = {}) =>
  json({ status: 1, product: { code, ...overrides } });

const codeFrom = (input: RequestInfo | URL): string => {
  const url = new URL(String(input));
  return url.pathname.split("/").pop() ?? "";
};

describe("Open Food Facts product images", () => {
  it("prefers the small front photo and asks the v2 product endpoint for both fields", async () => {
    const front = "https://images.openfoodfacts.org/images/products/123/front.jpg";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      product("12345678", {
        image_front_small_url: photo,
        image_front_url: front,
      }),
    );
    const client = createOffImageClient({ fetch: fetcher });

    expect(await client.imagesFor(["12345678"])).toEqual({ "12345678": photo });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe("https://world.openfoodfacts.org");
    expect(url.pathname).toBe("/api/v2/product/12345678");
    expect(url.searchParams.get("fields")).toBe(
      "code,image_front_small_url,image_front_url",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/ProteinScanner/);
  });

  it("falls back to the full front photo only when the small photo is missing", async () => {
    const client = createOffImageClient({
      fetch: async () =>
        product("12345678", {
          image_front_url: photo,
        }),
    });
    expect(await client.imagesFor(["12345678"])).toEqual({ "12345678": photo });
  });

  it.each([
    ["http", "http://images.openfoodfacts.org/front.jpg"],
    ["another host", "https://example.com/front.jpg"],
    ["a lookalike host", "https://images.openfoodfacts.org.evil.example/front.jpg"],
    ["a non-photo scheme", "ftp://images.openfoodfacts.org/front.jpg"],
    ["a malformed URL", "not a url"],
  ])("rejects %s image URLs", async (_label, candidate) => {
    const client = createOffImageClient({
      fetch: async () => product("12345678", { image_front_url: candidate }),
    });
    expect(await client.imagesFor(["12345678"])).toEqual({ "12345678": null });
  });

  it("accepts both the Open Food Facts root and its image subdomain over https", async () => {
    const rootPhoto = "https://openfoodfacts.org/front.jpg";
    const subdomainPhoto = "https://images.openfoodfacts.org/front.jpg";
    const root = createOffImageClient({
      fetch: async () => product("12345678", { image_front_url: rootPhoto }),
    });
    const subdomain = createOffImageClient({
      fetch: async () => product("87654321", { image_front_url: subdomainPhoto }),
    });
    expect(await root.imagesFor(["12345678"])).toEqual({ "12345678": rootPhoto });
    expect(await subdomain.imagesFor(["87654321"])).toEqual({ "87654321": subdomainPhoto });
  });

  it("keeps a bad product from failing the rest of the batch", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const code = codeFrom(input);
      if (code === "11111111") return product(code, { image_front_url: photo });
      if (code === "22222222") return new Response("upstream down", { status: 500 });
      if (code === "33333333") throw new Error("private network detail");
      if (code === "44444444") return new Response("{not json", { status: 200 });
      return json({ status: 0 });
    });
    const client = createOffImageClient({ fetch: fetcher });

    expect(
      await client.imagesFor(["11111111", "22222222", "33333333", "44444444", "55555555"]),
    ).toEqual({
      "11111111": photo,
      "22222222": null,
      "33333333": null,
      "44444444": null,
      "55555555": null,
    });
  });

  it("caches both photos and missing photos for the next request", async () => {
    const fetcher = vi.fn(async () => product("12345678", { image_front_url: photo }));
    const client = createOffImageClient({ fetch: fetcher });

    await client.imagesFor(["12345678"]);
    await client.imagesFor(["12345678"]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const missingFetcher = vi.fn(async () => json({ status: 0 }));
    const missingClient = createOffImageClient({ fetch: missingFetcher });
    expect(await missingClient.imagesFor(["87654321"])).toEqual({ "87654321": null });
    expect(await missingClient.imagesFor(["87654321"])).toEqual({ "87654321": null });
    expect(missingFetcher).toHaveBeenCalledTimes(1);
  });

  it("shares one upstream fetch for concurrent requests for the same barcode", async () => {
    let release: (value: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(() => gate);
    const client = createOffImageClient({ fetch: fetcher });

    const first = client.imagesFor(["12345678"]);
    const second = client.imagesFor(["12345678"]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release(product("12345678", { image_front_url: photo }));

    expect(await Promise.all([first, second])).toEqual([
      { "12345678": photo },
      { "12345678": photo },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns null for a barcode whose upstream request times out", async () => {
    const client = createOffImageClient({
      fetch: () => new Promise<Response>(() => undefined),
      timeoutMs: 10,
      budgetMs: 100,
    });
    expect(await client.imagesFor(["12345678"])).toEqual({ "12345678": null });
  });

  it("resolves the whole batch to null when the endpoint budget runs out", async () => {
    const client = createOffImageClient({
      fetch: () => new Promise<Response>(() => undefined),
      concurrency: 1,
      timeoutMs: 5_000,
      budgetMs: 30,
    });
    const started = Date.now();
    const result = await client.imagesFor(["11111111", "22222222", "33333333"]);
    expect(result).toEqual({
      "11111111": null,
      "22222222": null,
      "33333333": null,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("limits concurrent upstream requests to four", async () => {
    let active = 0;
    let highest = 0;
    const fetcher = vi.fn(async () => {
      active += 1;
      highest = Math.max(highest, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({ status: 0 });
    });
    const client = createOffImageClient({ fetch: fetcher });

    const codes = Array.from({ length: 12 }, (_, index) => String(10_000_000 + index));
    const result = await client.imagesFor(codes);
    expect(Object.keys(result)).toHaveLength(12);
    expect(Object.values(result).every((value) => value === null)).toBe(true);
    expect(highest).toBeGreaterThan(1);
    expect(highest).toBeLessThanOrEqual(4);
  });
});
