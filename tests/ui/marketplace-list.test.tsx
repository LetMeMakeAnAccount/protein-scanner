import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage, makeFood, makeNutrition, offSource } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";
import { MARKET_KEY, MARKET_LIMIT, marketKey, type MarketItem } from "../../src/client/market";

type Observation = {
  price: number;
  currency: string;
  date: string | null;
  store: string | null;
  city: string | null;
  country: string | null;
  pricePer: "UNIT" | "KG" | "L" | null;
  discounted: boolean;
  source: "open_prices";
};

const nutrition = makeNutrition(10, 60, { amount: 100, unit: "g" }, offSource);

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    price: 4.5,
    currency: "USD",
    date: "2026-10-01",
    store: "Whole Foods",
    city: "Austin",
    country: "United States",
    pricePer: "KG",
    discounted: false,
    source: "open_prices",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubApi(options: { search?: unknown[]; lookup?: unknown[]; prices?: Observation[] } = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/foods/search")) return jsonResponse({ ok: true, data: options.search ?? [] });
    if (url.includes("/api/foods/lookup")) return jsonResponse({ ok: true, data: options.lookup ?? [] });
    if (url.includes("/api/prices")) return jsonResponse({ ok: true, data: { observations: options.prices ?? [] } });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openMarketplace() {
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
}

function searchFor(query: string) {
  fireEvent.change(screen.getByLabelText(/search open food facts/i), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

function lookupFor(barcode: string) {
  fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: barcode } });
  fireEvent.click(screen.getByRole("button", { name: /^look up$/i }));
}

function rowFor(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const row = heading.closest("li");
  if (!row) throw new Error(`No row found for ${name}`);
  return row as HTMLElement;
}

function cell(row: HTMLElement, column: string): HTMLElement {
  const found = row.querySelector(`[data-column="${column}"]`);
  if (!found) throw new Error(`No ${column} cell in row`);
  return found as HTMLElement;
}

function addResult(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`add ${name} to list`, "i") }));
}

function storedItem(name: string, options: { barcode?: string; nutrition?: typeof nutrition | null } = {}): MarketItem {
  const food = makeFood(name, { barcode: options.barcode, source: offSource });
  return {
    key: marketKey(food),
    food,
    nutrition: options.nutrition ?? null,
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
});

afterEach(() => {
  cleanup();
});

describe("Marketplace saved list", () => {
  it("dedupes by lowercase name when a food has no barcode", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (!url.includes("/api/foods/search")) throw new Error(`Unexpected request: ${url}`);
        const name = call++ === 0 ? "Loose Oats" : "loose oats";
        return jsonResponse({ ok: true, data: [{ food: makeFood(name, { source: offSource }), nutrition }] });
      }),
    );
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    addResult("Loose Oats");

    await searchFor("oats");
    await screen.findByRole("heading", { name: "loose oats" });
    addResult("loose oats");

    await waitFor(() => expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")[0].food.name).toBe("loose oats");
    expect(screen.getAllByRole("heading", { name: /loose oats/i })).toHaveLength(1);
  });

  it("dedupes by barcode even when the listed name changes", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/foods/lookup")) {
          const name = call++ === 0 ? "Greek Yogurt" : "Greek Yoghurt";
          return jsonResponse({
            ok: true,
            data: [{ food: makeFood(name, { barcode: "012345678905", source: offSource }), nutrition }],
          });
        }
        if (url.includes("/api/prices")) {
          return jsonResponse({ ok: true, data: { observations: [observation()] } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    await screen.findByRole("heading", { name: "Greek Yogurt" });

    await lookupFor("012345678905");
    await screen.findByRole("heading", { name: "Greek Yoghurt" });

    await waitFor(() => expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(1));
    const savedSection = screen.getByRole("heading", { name: "Saved" }).closest("section") as HTMLElement;
    expect(within(savedSection).getAllByRole("heading", { name: /greek yog/i })).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")[0].food.name).toBe("Greek Yoghurt");
  });

  it("caps the list at 50 and keeps the newest item first", async () => {
    localStorage.setItem(
      MARKET_KEY,
      JSON.stringify(Array.from({ length: MARKET_LIMIT }, (_, index) => storedItem(`Item ${index + 1}`))),
    );
    stubApi({ search: [{ food: makeFood("New Food", { source: offSource }), nutrition }] });
    render(<Home />);
    openMarketplace();

    expect(await screen.findByRole("heading", { name: "Item 1" })).toBeInTheDocument();

    await searchFor("new food");
    await screen.findByRole("heading", { name: "New Food" });
    addResult("New Food");

    await waitFor(() => expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(MARKET_LIMIT));
    const stored = JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]");
    expect(stored[0].food.name).toBe("New Food");
    expect(stored).toHaveLength(MARKET_LIMIT);
    expect(screen.queryByText("Item 50")).not.toBeInTheDocument();
  });

  it("restores the list and its price after a reload without another price request", async () => {
    const fetchMock = stubApi({
      lookup: [{ food: makeFood("Greek Yogurt", { barcode: "012345678905", source: offSource }), nutrition }],
      prices: [observation()],
    });
    const first = render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    await waitFor(() => expect(cell(rowFor("Greek Yogurt"), "price")).toHaveTextContent("4.5 USD"));
    const callsBeforeReload = fetchMock.mock.calls.length;

    first.unmount();
    render(<Home />);
    openMarketplace();

    await screen.findByRole("heading", { name: "Greek Yogurt" });
    expect(cell(rowFor("Greek Yogurt"), "price")).toHaveTextContent("4.5 USD");
    expect(cell(rowFor("Greek Yogurt"), "per-dollar")).toHaveTextContent("22.22 g/USD");
    expect(fetchMock.mock.calls.length).toBe(callsBeforeReload);
  });

  it("persists entered package weight and price paid and recomputes the ratios", async () => {
    stubApi({
      search: [{ food: makeFood("Loose Oats", { source: offSource }), nutrition }],
    });
    const first = render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    addResult("Loose Oats");

    fireEvent.change(screen.getByLabelText(/package weight \(g\)/i), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText(/price paid/i), { target: { value: "5" } });

    await waitFor(() => expect(cell(rowFor("Loose Oats"), "per-dollar")).toHaveTextContent("10 g/USD"));
    expect(cell(rowFor("Loose Oats"), "price")).toHaveTextContent("5 USD");
    expect(cell(rowFor("Loose Oats"), "per-kcal")).toHaveTextContent("16.67 g/100 kcal");

    const stored = JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")[0];
    expect(stored.packageWeightG).toBe(500);
    expect(stored.paidPrice).toBe(5);
    expect(stored.paidCurrency).toBe("USD");

    first.unmount();
    render(<Home />);
    openMarketplace();
    await screen.findByRole("heading", { name: "Loose Oats" });
    expect(cell(rowFor("Loose Oats"), "per-dollar")).toHaveTextContent("10 g/USD");

    fireEvent.click(screen.getByRole("button", { name: /^details$/i }));
    expect(screen.getByLabelText(/package weight \(g\)/i)).toHaveValue(500);
    expect(screen.getByLabelText(/price paid/i)).toHaveValue(5);
  });

  it("removes a row from the list and from this browser's storage", async () => {
    stubApi({
      search: [{ food: makeFood("Loose Oats", { source: offSource }), nutrition }],
    });
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    addResult("Loose Oats");

    fireEvent.click(screen.getByRole("button", { name: /remove loose oats/i }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Loose Oats" })).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(0);
  });
});
