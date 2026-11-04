import { describe, expect, it, vi } from "vitest";
import { createImagesHandlers } from "../../src/server/composition";
import { createOffImageClient } from "../../src/server/images/offImages";
import { GET as imagesRoute } from "../../src/app/api/images/route";

vi.mock("server-only", () => ({}));

const photo = "https://images.openfoodfacts.org/images/products/123/456/front_en.1.200.jpg";
const invalidBody = { ok: false, error: { code: "invalid_input", message: "Invalid input" } };
const publicCache = "public, max-age=3600, stale-while-revalidate=86400";
const request = (path: string) => new Request(`https://app.example${path}`);
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function codes(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(10_000_000 + index));
}

describe("product image route", () => {
  it("returns one entry per barcode with the exact public cache header", async () => {
    const requested = codes(12);
    const imagesFor = vi.fn(async (values: string[]) =>
      Object.fromEntries(values.map((code, index) => [code, index === 0 ? photo : null])),
    );
    const response = await createImagesHandlers({ imagesFor }).lookup(
      request(`/api/images?barcodes=${requested.join(",")}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(publicCache);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        images: Object.fromEntries(requested.map((code, index) => [code, index === 0 ? photo : null])),
      },
    });
    expect(imagesFor).toHaveBeenCalledWith(requested);
  });

  it("rejects missing, malformed, duplicated, over-limit and unknown parameters before lookup", async () => {
    const imagesFor = vi.fn(async (values: string[]) =>
      Object.fromEntries(values.map((code) => [code, null])),
    );
    const handlers = createImagesHandlers({ imagesFor });
    const tooMany = codes(13).join(",");
    const paths = [
      "/api/images",
      "/api/images?barcodes=",
      "/api/images?barcodes=123",
      "/api/images?barcodes=1234567890123456789012345",
      "/api/images?barcodes=1234,1234",
      "/api/images?barcodes=1234,",
      "/api/images?barcodes=abcd",
      "/api/images?barcodes=1234&barcodes=5678",
      "/api/images?barcodes=1234&extra=1",
      `/api/images?barcodes=${tooMany}`,
    ];

    for (const path of paths) {
      const response = await handlers.lookup(request(path));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(invalidBody);
    }
    expect(imagesFor).not.toHaveBeenCalled();
  });

  it("keeps valid rows and reports each bad, missing or foreign photo as null", async () => {
    const imagesFor = async (values: string[]) => ({
      [values[0]]: photo,
      [values[1]]: null,
      [values[2]]: "http://images.openfoodfacts.org/front.jpg",
    });
    const response = await createImagesHandlers({ imagesFor }).lookup(
      request("/api/images?barcodes=11111111,22222222,33333333,44444444"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(publicCache);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        images: {
          "11111111": photo,
          "22222222": null,
          "33333333": null,
          "44444444": null,
        },
      },
    });
  });

  it("turns an upstream timeout into nulls with a 200 and the public header", async () => {
    const client = createOffImageClient({
      fetch: () => new Promise<Response>(() => undefined),
      timeoutMs: 10,
      budgetMs: 100,
    });
    const response = await createImagesHandlers(client).lookup(
      request("/api/images?barcodes=12345678,87654321"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(publicCache);
    expect(await response.json()).toEqual({
      ok: true,
      data: { images: { "12345678": null, "87654321": null } },
    });
  });

  it("never echoes an internal error or a secret in the body", async () => {
    const imagesFor = vi.fn(async () => {
      throw new Error("private-secret-key");
    });
    const response = await createImagesHandlers({ imagesFor }).lookup(
      request("/api/images?barcodes=12345678"),
    );
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(publicCache);
    expect(raw).not.toContain("private-secret-key");
    expect(JSON.parse(raw)).toEqual({
      ok: true,
      data: { images: { "12345678": null } },
    });
  });

  it("wires the Next GET route through composition and caches the second lookup", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const code = url.pathname.split("/").pop() ?? "";
      return json({
        status: 1,
        product: { code, image_front_small_url: photo },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const path = "/api/images?barcodes=9081726354455";
      const first = await imagesRoute(request(path));
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe(publicCache);
      expect(await first.json()).toEqual({
        ok: true,
        data: { images: { "9081726354455": photo } },
      });

      const second = await imagesRoute(request(path));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        ok: true,
        data: { images: { "9081726354455": photo } },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.origin).toBe("https://world.openfoodfacts.org");
      expect(url.pathname).toBe("/api/v2/product/9081726354455");
      expect(url.searchParams.get("fields")).toBe(
        "code,image_front_small_url,image_front_url",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
