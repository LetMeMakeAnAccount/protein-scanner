import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage, makeFood, makeNutrition, offSource } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";
import { CATALOG } from "../../src/client/catalog";
import { MARKET_KEY } from "../../src/client/market";

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

const food = makeFood("Greek Yogurt", { barcode: "012345678905", source: offSource });
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

type ApiOptions = {
  search?: unknown[];
  lookup?: unknown[];
  prices?: Observation[];
  pricesStatus?: number;
};

function stubApi(options: ApiOptions = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/foods/search")) {
      return jsonResponse({ ok: true, data: options.search ?? [] });
    }
    if (url.includes("/api/foods/lookup")) {
      return jsonResponse({ ok: true, data: options.lookup ?? [] });
    }
    if (url.includes("/api/prices")) {
      if (options.pricesStatus && options.pricesStatus >= 400) {
        return jsonResponse(
          { ok: false, error: { code: "unavailable", message: "Price service unavailable" } },
          options.pricesStatus,
        );
      }
      return jsonResponse({ ok: true, data: { observations: options.prices ?? [] } });
    }
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

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("Marketplace tab", () => {
  it("keeps only the fields, the short price note and the Open Prices credit", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    expect(screen.getByRole("heading", { name: "Marketplace" })).toBeInTheDocument();
    expect(screen.getByLabelText(/search open food facts/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^barcode$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look up" })).toBeInTheDocument();
    expect(screen.getByText("Community prices, not live shelf prices.")).toBeInTheDocument();
    expect(screen.getByText(/Open Database License \(ODbL\)/)).toBeInTheDocument();

    expect(screen.queryByText(/browse, don't buy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/find a packaged food/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/community prices are past reports/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/start with a name or barcode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/opens the retailer's search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/can't work out protein per dollar/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no community price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/newest observation only/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Results" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Saved" })).not.toBeInTheDocument();
  });

  it("shows search results in compact columns and adds one to the saved list with its price", async () => {
    const fetchMock = stubApi({ search: [{ food, nutrition }], prices: [observation()] });
    render(<Home />);
    openMarketplace();

    await searchFor("greek yogurt");
    const result = await screen.findByRole("heading", { name: "Greek Yogurt" });
    const resultRow = result.closest("li") as HTMLElement;
    expect(cell(resultRow, "protein")).toHaveTextContent("10 g");
    expect(cell(resultRow, "kcal")).toHaveTextContent("60 kcal");
    expect(cell(resultRow, "price")).toHaveTextContent("—");
    expect(cell(resultRow, "per-dollar")).toHaveTextContent("—");
    expect(cell(resultRow, "per-kcal")).toHaveTextContent("16.67 g/100 kcal");

    addResult("Greek Yogurt");

    await waitFor(() => expect(cell(rowFor("Greek Yogurt"), "price")).toHaveTextContent("4.5 USD"));
    const savedRow = rowFor("Greek Yogurt");
    expect(cell(savedRow, "protein")).toHaveTextContent("10 g");
    expect(cell(savedRow, "kcal")).toHaveTextContent("60 kcal");
    expect(cell(savedRow, "per-dollar")).toHaveTextContent("22.22 g/USD");
    expect(cell(savedRow, "per-kcal")).toHaveTextContent("16.67 g/100 kcal");

    expect(await screen.findByText("Whole Foods")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/prices?barcode=012345678905")).toBe(true);
  });

  it("adds barcode results automatically, shows observations, date and discount, and dedupes", async () => {
    const second = observation({
      price: 5,
      store: null,
      city: null,
      country: null,
      date: null,
      discounted: true,
      pricePer: "UNIT",
    });
    const fetchMock = stubApi({ lookup: [{ food, nutrition }], prices: [observation(), second] });
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");

    const row = await screen.findByRole("heading", { name: "Greek Yogurt" });
    expect(row).toBeInTheDocument();
    await waitFor(() => expect(cell(rowFor("Greek Yogurt"), "price")).toHaveTextContent("4.5 USD"));

    expect(await screen.findByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Austin, United States")).toBeInTheDocument();
    expect(screen.getByText("2026-10-01")).toBeInTheDocument();
    expect(screen.getByText("Discounted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search Walmart" })).toHaveAttribute(
      "href",
      "https://www.walmart.com/search?q=00012345678905",
    );
    expect(screen.getByRole("link", { name: "Search Instacart" })).toHaveAttribute(
      "href",
      "https://www.instacart.com/store/s?k=Greek%20Yogurt",
    );
    expect(screen.getByRole("link", { name: "Search Target" })).toHaveAttribute(
      "href",
      "https://www.target.com/s?searchTerm=Greek%20Yogurt",
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/prices?barcode=012345678905")).toBe(true);

    await lookupFor("012345678905");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")).toHaveLength(1));
    expect(screen.getAllByRole("heading", { name: "Greek Yogurt" })).toHaveLength(1);

    expect(screen.queryByText(/opens the retailer's search/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/prices there are not ours/i)).not.toBeInTheDocument();
  });

  it("shows dashes for every value that is not known, without a sentence", async () => {
    const bare = makeFood("Mystery Bar", { source: offSource });
    stubApi({ search: [{ food: bare, nutrition: null }] });
    render(<Home />);
    openMarketplace();

    await searchFor("mystery");
    await screen.findByRole("heading", { name: "Mystery Bar" });
    addResult("Mystery Bar");

    const row = rowFor("Mystery Bar");
    expect(cell(row, "price")).toHaveTextContent("—");
    expect(cell(row, "protein")).toHaveTextContent("—");
    expect(cell(row, "kcal")).toHaveTextContent("—");
    expect(cell(row, "per-dollar")).toHaveTextContent("—");
    expect(cell(row, "per-kcal")).toHaveTextContent("—");
    expect(screen.queryByText(/no community price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not listed/i)).not.toBeInTheDocument();
  });

  it("renders the entered price and ratios when package weight and price paid are known", async () => {
    const bare = makeFood("Loose Oats", { source: offSource });
    stubApi({ search: [{ food: bare, nutrition }] });
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    addResult("Loose Oats");

    fireEvent.change(screen.getByLabelText(/package weight \(g\)/i), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText(/price paid/i), { target: { value: "5" } });

    await waitFor(() => expect(cell(rowFor("Loose Oats"), "price")).toHaveTextContent("5 USD"));
    expect(cell(rowFor("Loose Oats"), "per-dollar")).toHaveTextContent("10 g/USD");
    expect(cell(rowFor("Loose Oats"), "per-kcal")).toHaveTextContent("16.67 g/100 kcal");
  });

  it("shows short loading and error states without leaving stale results", async () => {
    let release: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/foods/search")) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        if (url.includes("/api/foods/lookup")) return Promise.resolve(jsonResponse({ ok: true, data: [] }));
        return Promise.resolve(jsonResponse({ ok: true, data: { observations: [] } }));
      }),
    );
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");

    await act(async () => {
      release(jsonResponse({ ok: true, data: [] }));
    });
    expect(await screen.findByRole("status")).toHaveTextContent("No match.");
    expect(screen.queryByText(/no open food facts match/i)).not.toBeInTheDocument();

    await lookupFor("012345678905");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No match."));

    fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^look up$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Barcode must be 4–24 digits.");
  });

  it("skips the Walmart link and the price request when an item has no barcode", async () => {
    const bare = makeFood("Loose Oats", { source: offSource });
    const fetchMock = stubApi({ search: [{ food: bare, nutrition }] });
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    addResult("Loose Oats");

    expect(await screen.findByRole("link", { name: "Search Instacart" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search Target" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Search Walmart" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/prices"))).toBe(false);
  });
});

describe("Marketplace bundled catalog", () => {
  function catalogList(): HTMLElement {
    return screen.getByRole("list", { name: "Catalog foods" });
  }

  function catalogRow(name: string): HTMLElement {
    const heading = screen.getByRole("heading", { name });
    const row = heading.closest("li");
    if (!row) throw new Error(`No catalog row found for ${name}`);
    return row as HTMLElement;
  }

  it("browses seed rows without typing and keeps the first page at 40", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    expect(screen.getByRole("heading", { name: "Browse foods" })).toBeInTheDocument();
    expect(within(catalogList()).getAllByRole("listitem")).toHaveLength(40);

    const first = CATALOG[0];
    const row = catalogRow(first.name);
    expect(cell(row, "protein")).toHaveTextContent("82 g");
    expect(cell(row, "kcal")).toHaveTextContent("361 kcal");
    expect(cell(row, "per-kcal")).toHaveTextContent("22.71 g/100 kcal");
    expect(cell(row, "per-dollar")).toHaveTextContent("—");
    expect(screen.getByText("Catalog: Open Food Facts (ODbL)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show more/i })).toBeInTheDocument();
  });

  it("narrows the catalog with the filter input and hides Show more", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    fireEvent.change(screen.getByLabelText(/filter foods/i), { target: { value: "Isopure" } });

    expect(within(catalogList()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: CATALOG[0].name })).toBeInTheDocument();
    expect(screen.queryByText(CATALOG[1].name)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("adds a catalog row and prefills its package weight", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    const food = CATALOG.find((entry) => entry.name === "RXBAR Chocolate Sea Salt");
    if (!food) throw new Error("Seed row missing");

    fireEvent.change(screen.getByLabelText(/filter foods/i), { target: { value: "RXBAR Chocolate Sea Salt" } });
    fireEvent.click(screen.getByRole("button", { name: `Add ${food.name} to list` }));

    expect(screen.getByLabelText(/package weight \(g\)/i)).toHaveValue(food.packageGrams);
    const stored = JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].food).toMatchObject({
      name: food.name,
      barcode: food.code,
      source: { kind: "off", label: "Open Food Facts" },
      packageBasis: { amount: food.packageGrams, unit: "g" },
    });
    expect(stored[0].nutrition).toMatchObject({
      proteinG: food.proteinG,
      energyKcal: food.kcal,
      basis: { amount: 100, unit: "g" },
    });
    expect(stored[0].packageWeightG).toBe(food.packageGrams);
  });

  it("expands the catalog in pages of 40 with Show more", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    expect(within(catalogList()).getAllByRole("listitem")).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(within(catalogList()).getAllByRole("listitem")).toHaveLength(80);
    expect(screen.getByText(CATALOG[40].name)).toBeInTheDocument();
  });

  it("shows protein per dollar once a saved price exists", () => {
    stubApi();
    render(<Home />);
    openMarketplace();

    const food = CATALOG.find((entry) => entry.name === "RXBAR Chocolate Sea Salt");
    if (!food) throw new Error("Seed row missing");

    fireEvent.change(screen.getByLabelText(/filter foods/i), { target: { value: "RXBAR Chocolate Sea Salt" } });
    fireEvent.click(screen.getByRole("button", { name: `Add ${food.name} to list` }));
    fireEvent.change(screen.getByLabelText(/price paid/i), { target: { value: "2" } });

    const catalog = catalogList();
    const row = within(catalog).getByRole("heading", { name: food.name }).closest("li") as HTMLElement;
    expect(cell(row, "per-dollar")).toHaveTextContent("6.01 g/USD");
  });
});
