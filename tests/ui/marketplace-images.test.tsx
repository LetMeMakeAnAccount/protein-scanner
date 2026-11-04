import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage, makeFood, makeNutrition, offSource } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";
import { CATALOG } from "../../src/client/catalog";
import { clearImageCache, loadImages } from "../../src/client/images";
import { MARKET_KEY, marketKey, type MarketItem } from "../../src/client/market";

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  elements: Set<Element>;
};

let observers: ObserverRecord[] = [];

/** jsdom has no IntersectionObserver; this records targets and lets a test reveal them. */
class FakeIntersectionObserver {
  private record: ObserverRecord;
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[] = [0];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, options, elements: new Set() };
    this.rootMargin = options?.rootMargin ?? "0px";
    observers.push(this.record);
  }

  observe(target: Element) {
    this.record.elements.add(target);
  }

  unobserve(target: Element) {
    this.record.elements.delete(target);
  }

  disconnect() {
    this.record.elements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function stubObserver(): void {
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
}

function reveal(elements: Element[]): void {
  for (const observer of [...observers]) {
    const entries = elements
      .filter((target) => observer.elements.has(target))
      .map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
    if (entries.length === 0) continue;
    observer.callback(entries, observer as unknown as IntersectionObserver);
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function photo(code: string): string {
  return `https://images.openfoodfacts.org/images/products/${code}.jpg`;
}

type FetchMock = ReturnType<typeof vi.fn>;

function photoRequests(fetchMock: FetchMock): string[][] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === "/api/images")
    .map((url) => (url.searchParams.get("barcodes") ?? "").split(",").filter(Boolean));
}

/** Answers /api/images with the given URLs, and null for everything else. */
function stubImageApi(images: Record<string, string | null> = {}): FetchMock {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/images") throw new Error(`Unexpected request: ${url}`);
    const requested = (url.searchParams.get("barcodes") ?? "").split(",").filter(Boolean);
    const found: Record<string, string | null> = {};
    for (const code of requested) found[code] = images[code] ?? null;
    return jsonResponse({ ok: true, data: { images: found } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openMarketplace(): void {
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
}

function catalogList(): HTMLElement {
  return screen.getByRole("list", { name: "Catalog foods" });
}

function catalogRows(): HTMLElement[] {
  return within(catalogList()).getAllByRole("listitem");
}

function catalogRow(name: string): HTMLElement {
  const row = within(catalogList()).getByRole("heading", { name }).closest("li");
  if (!row) throw new Error(`No catalog row for ${name}`);
  return row as HTMLElement;
}

function savedSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Saved" }).closest("section");
  if (!section) throw new Error("No saved section");
  return section as HTMLElement;
}

function savedRow(name: string): HTMLElement {
  const row = within(savedSection()).getByRole("heading", { name }).closest("li");
  if (!row) throw new Error(`No saved row for ${name}`);
  return row as HTMLElement;
}

function storedItem(name: string, barcode?: string): MarketItem {
  const food = makeFood(name, { barcode, source: offSource });
  return {
    key: marketKey(food),
    food,
    nutrition: makeNutrition(10, 60, { amount: 100, unit: "g" }, offSource),
    observations: [],
    packageWeightG: null,
    paidPrice: null,
    paidCurrency: "USD",
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearImageCache();
  observers = [];
});

afterEach(() => {
  cleanup();
});

describe("Marketplace product thumbnails", () => {
  it("asks for photos only for catalog rows near the viewport, in one batch", async () => {
    stubObserver();
    const requests = CATALOG.slice(0, 2);
    const fetchMock = stubImageApi(Object.fromEntries(requests.map((food) => [food.code, photo(food.code)])));

    render(<Home />);
    openMarketplace();
    const rows = catalogRows();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      reveal([rows[0], rows[1]]);
    });

    await waitFor(() =>
      expect(photoRequests(fetchMock)).toEqual([requests.map((food) => food.code)]),
    );
    await waitFor(() => expect(rows[0].querySelector("img")).toHaveAttribute("src", photo(requests[0].code)));
    expect(rows[1].querySelector("img")).toHaveAttribute("src", photo(requests[1].code));
    expect(rows[2].querySelector("img")).toBeNull();
    expect(observers[0].options?.rootMargin).toBe("200px");
  });

  it("keeps off-screen rows quiet and serves cached photos without another request", async () => {
    stubObserver();
    const requests = CATALOG.slice(0, 2);
    const fetchMock = stubImageApi(Object.fromEntries(requests.map((food) => [food.code, photo(food.code)])));

    render(<Home />);
    openMarketplace();
    const firstPass = catalogRows();
    await act(async () => {
      reveal([firstPass[0], firstPass[1]]);
    });
    await waitFor(() => expect(firstPass[0].querySelector("img")).toHaveAttribute("src", photo(requests[0].code)));
    expect(photoRequests(fetchMock)).toHaveLength(1);
    expect(firstPass[2].querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Scan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
    const secondPass = catalogRows();
    await act(async () => {
      reveal([secondPass[0], secondPass[1]]);
    });

    await waitFor(() => expect(secondPass[0].querySelector("img")).toHaveAttribute("src", photo(requests[0].code)));
    expect(secondPass[1].querySelector("img")).toHaveAttribute("src", photo(requests[1].code));
    expect(photoRequests(fetchMock)).toHaveLength(1);
    expect(secondPass[2].querySelector("img")).toBeNull();
    expect(secondPass[2].querySelector(".product-thumb-fallback")).not.toBeNull();
  });

  it("shows the letter tile when the endpoint resolves a null photo", async () => {
    stubObserver();
    const fetchMock = stubImageApi();

    render(<Home />);
    openMarketplace();
    const row = catalogRows()[0];
    const first = CATALOG[0].name.charAt(0).toUpperCase();

    await act(async () => {
      reveal([row]);
    });
    await waitFor(() => expect(photoRequests(fetchMock)).toHaveLength(1));
    await act(async () => undefined);

    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".product-thumb-fallback")).toHaveTextContent(first);
  });

  it("shows the letter tile when the photo request fails", async () => {
    stubObserver();
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openMarketplace();
    const row = catalogRows()[0];

    await act(async () => {
      reveal([row]);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => undefined);

    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".product-thumb-fallback")).toHaveTextContent(
      CATALOG[0].name.charAt(0).toUpperCase(),
    );
  });

  it("swaps a photo that fails to load for the letter tile", async () => {
    stubObserver();
    const code = CATALOG[0].code;
    stubImageApi({ [code]: photo(code) });

    render(<Home />);
    openMarketplace();
    const row = catalogRows()[0];
    await act(async () => {
      reveal([row]);
    });
    await waitFor(() => expect(row.querySelector("img")).not.toBeNull());

    fireEvent.error(row.querySelector("img") as HTMLImageElement);

    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".product-thumb-fallback")).toHaveTextContent(
      CATALOG[0].name.charAt(0).toUpperCase(),
    );
  });

  it("loads photos for visible saved rows through the same loader", async () => {
    const barcode = "012345678905";
    localStorage.setItem(MARKET_KEY, JSON.stringify([storedItem("Greek Yogurt", barcode)]));
    stubObserver();
    const fetchMock = stubImageApi({ [barcode]: photo(barcode) });

    render(<Home />);
    openMarketplace();
    const row = savedRow("Greek Yogurt");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      reveal([row]);
    });

    await waitFor(() => expect(photoRequests(fetchMock)).toEqual([[barcode]]));
    await waitFor(() => expect(row.querySelector("img")).toHaveAttribute("src", photo(barcode)));
  });

  it("does not request a photo for a saved food without a barcode", () => {
    localStorage.setItem(MARKET_KEY, JSON.stringify([storedItem("Loose Oats")]));
    stubObserver();
    const fetchMock = stubImageApi();

    render(<Home />);
    openMarketplace();

    expect(savedRow("Loose Oats").querySelector(".product-thumb-fallback")).toHaveTextContent("L");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the first eight catalog photos when IntersectionObserver is unavailable", async () => {
    const expected = CATALOG.slice(0, 8).map((food) => food.code);
    const fetchMock = stubImageApi(Object.fromEntries(expected.map((code) => [code, photo(code)])));

    render(<Home />);
    openMarketplace();

    await waitFor(() => expect(photoRequests(fetchMock)).toHaveLength(1));
    expect(photoRequests(fetchMock)[0]).toEqual(expected);
    await waitFor(() =>
      expect(catalogRows()[0].querySelector("img")).toHaveAttribute("src", photo(expected[0])),
    );
    expect(catalogRows()[8].querySelector("img")).toBeNull();
  });

  it("credits the catalog and its images on one line", () => {
    render(<Home />);
    openMarketplace();

    const credit = screen.getByText("Catalog and images: Open Food Facts (ODbL, CC BY-SA)");
    expect(credit).toHaveClass("market-credit");
    expect(credit.querySelector("a")).toBeNull();
  });
});

describe("runtime image loader", () => {
  it("makes no request when there are no barcodes", async () => {
    const fetchMock = stubImageApi();
    const result = await loadImages([]);

    expect(Object.keys(result)).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches each barcode once when the same batch is requested twice", async () => {
    const code = CATALOG[0].code;
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = loadImages([code]);
    const second = loadImages([code]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(jsonResponse({ ok: true, data: { images: { [code]: photo(code) } } }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult[code]).toBe(photo(code));
    expect(secondResult[code]).toBe(photo(code));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("splits barcodes into requests of at most twelve", async () => {
    const codes = CATALOG.slice(0, 25).map((food) => food.code);
    const fetchMock = stubImageApi(Object.fromEntries(codes.map((code) => [code, photo(code)])));

    const result = await loadImages(codes);
    const requests = photoRequests(fetchMock);

    expect(requests.map((batch) => batch.length)).toEqual([12, 12, 1]);
    expect(requests.flat()).toEqual(codes);
    expect(result[codes[24]]).toBe(photo(codes[24]));
  });

  it("caches nulls so a missing photo is not requested again", async () => {
    const code = CATALOG[0].code;
    const fetchMock = stubImageApi();

    expect((await loadImages([code]))[code]).toBeNull();
    expect((await loadImages([code]))[code]).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps codes the endpoint cannot accept out of the batch", async () => {
    const code = CATALOG[0].code;
    const fetchMock = stubImageApi({ [code]: photo(code) });

    const result = await loadImages(["Loose Oats", code]);

    expect(photoRequests(fetchMock)).toEqual([[code]]);
    expect(result["Loose Oats"]).toBeNull();
    expect(result[code]).toBe(photo(code));
  });
});
