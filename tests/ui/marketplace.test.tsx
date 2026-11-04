import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage, makeFood, makeNutrition, offSource } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";

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
  prices?: Observation[] | null;
  pricesStatus?: number;
  pricesError?: { code: string; message: string };
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
          {
            ok: false,
            error: options.pricesError ?? { code: "unavailable", message: "Prices are unavailable" },
          },
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

async function searchFor(query: string) {
  fireEvent.change(screen.getByLabelText(/search open food facts/i), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

async function lookupFor(barcode: string) {
  fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: barcode } });
  fireEvent.click(screen.getByRole("button", { name: /look up barcode/i }));
}

function cardFor(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const card = heading.closest("li");
  if (!card) throw new Error(`No card found for ${name}`);
  return card as HTMLElement;
}

function selectCard(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`view community prices for ${name}`, "i") }));
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
  it("sits after Progress and searches food by name into result cards", async () => {
    stubApi({ search: [{ food, nutrition }] });
    render(<Home />);

    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Scan", "Diary", "Progress", "Marketplace"]);

    openMarketplace();
    expect(screen.getByRole("heading", { name: "Marketplace" })).toBeInTheDocument();

    await searchFor("greek yogurt");
    await screen.findByRole("heading", { name: "Greek Yogurt" });

    const card = cardFor("Greek Yogurt");
    expect(card).toHaveTextContent("Open Food Facts");
    expect(card).toHaveTextContent("10 g protein per 100 g");
    expect(card).toHaveTextContent("60 kcal per 100 g");
    expect(card).toHaveTextContent("012345678905");
  });

  it("fetches prices after a barcode lookup and lists store, location, price, date and discount", async () => {
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
    await screen.findByRole("heading", { name: "Greek Yogurt" });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/prices"))).toBe(false);

    selectCard("Greek Yogurt");
    expect(await screen.findByText("Community price observations (Open Prices)")).toBeInTheDocument();
    expect(await screen.findByText("Whole Foods")).toBeInTheDocument();

    expect(screen.getByText("4.5 USD")).toBeInTheDocument();
    expect(screen.getByText("5 USD")).toBeInTheDocument();
    expect(screen.getByText("Austin, United States")).toBeInTheDocument();
    expect(screen.getByText("Observed 2026-10-01")).toBeInTheDocument();
    expect(screen.getByText("Date unknown")).toBeInTheDocument();
    expect(screen.getByText("Store unknown")).toBeInTheDocument();
    expect(screen.getByText("Discounted")).toBeInTheDocument();
    expect(screen.getByText(/Open Database License \(ODbL\)/)).toBeInTheDocument();
    expect(screen.getByText("Protein per dollar")).toBeInTheDocument();
    expect(screen.getByText(/22\.22 g\/USD/)).toBeInTheDocument();

    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/prices?barcode=012345678905")).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/foods/lookup?barcode=012345678905"),
    ).toBe(true);
  });

  it("says when there are no community prices instead of showing a figure", async () => {
    stubApi({ lookup: [{ food, nutrition }], prices: [] });
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    await screen.findByRole("heading", { name: "Greek Yogurt" });
    selectCard("Greek Yogurt");

    expect(await screen.findByText("No community price for this item yet.")).toBeInTheDocument();
    expect(screen.queryByText("Protein per dollar")).not.toBeInTheDocument();
  });

  it("shows an honest message when prices are unavailable (503)", async () => {
    stubApi({
      lookup: [{ food, nutrition }],
      pricesStatus: 503,
      pricesError: { code: "unavailable", message: "Price service unavailable" },
    });
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    await screen.findByRole("heading", { name: "Greek Yogurt" });
    selectCard("Greek Yogurt");

    expect(await screen.findByRole("alert")).toHaveTextContent("Prices are unavailable right now.");
    expect(screen.queryByText("No community price for this item yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("Protein per dollar")).not.toBeInTheDocument();
  });

  it("builds the Walmart GTIN-14 link and the encoded Instacart and Target name links", async () => {
    stubApi({ search: [{ food, nutrition }], prices: [] });
    render(<Home />);
    openMarketplace();

    await searchFor("Greek Yogurt");
    await screen.findByRole("heading", { name: "Greek Yogurt" });
    selectCard("Greek Yogurt");

    const walmart = screen.getByRole("link", { name: "Search Walmart" });
    expect(walmart).toHaveAttribute("href", "https://www.walmart.com/search?q=00012345678905");
    expect(walmart).toHaveAttribute("target", "_blank");
    expect(walmart.getAttribute("rel")).toContain("noopener");
    expect(walmart.getAttribute("rel")).toContain("noreferrer");

    expect(screen.getByRole("link", { name: "Search Instacart" })).toHaveAttribute(
      "href",
      "https://www.instacart.com/store/s?k=Greek%20Yogurt",
    );
    expect(screen.getByRole("link", { name: "Search Target" })).toHaveAttribute(
      "href",
      "https://www.target.com/s?searchTerm=Greek%20Yogurt",
    );
    expect(
      screen.getByText("Opens the retailer's search. Prices there are not ours."),
    ).toBeInTheDocument();
  });

  it("skips the price fetch and the Walmart link when an item has no barcode", async () => {
    const noBarcode = makeFood("Loose Oats", { source: offSource });
    const fetchMock = stubApi({ search: [{ food: noBarcode, nutrition }] });
    render(<Home />);
    openMarketplace();

    await searchFor("oats");
    await screen.findByRole("heading", { name: "Loose Oats" });
    selectCard("Loose Oats");

    expect(await screen.findByRole("link", { name: "Search Instacart" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search Target" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Search Walmart" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/no barcode/i).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/prices"))).toBe(false);
  });

  it("never averages prices or presents an observation as a current price", async () => {
    stubApi({
      lookup: [{ food, nutrition }],
      prices: [observation({ price: 4, currency: "USD", pricePer: "UNIT" }), observation({ price: 6, currency: "USD", pricePer: "UNIT" })],
    });
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    await screen.findByRole("heading", { name: "Greek Yogurt" });
    selectCard("Greek Yogurt");

    expect(await screen.findByText("4 USD")).toBeInTheDocument();
    expect(screen.getByText("6 USD")).toBeInTheDocument();
    expect(screen.queryByText("5 USD")).not.toBeInTheDocument();
    expect(screen.queryByText("5.00 USD")).not.toBeInTheDocument();
    expect(screen.queryByText(/current price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/live price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/average/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not ours/i)).toBeInTheDocument();
  });

  it("shows an Open Food Facts error without leaving stale results", async () => {
    stubApi({});
    render(<Home />);
    openMarketplace();

    await lookupFor("012345678905");
    expect(await screen.findByText(/no open food facts match for this barcode/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /look up barcode/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a barcode of 4 to 24 digits.");

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Greek Yogurt" })).not.toBeInTheDocument());
  });
});
