import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";
import { CATALOG } from "../../src/client/catalog";
import { MARKET_KEY } from "../../src/client/market";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function openMarketplace() {
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
}

function catalogList(): HTMLElement {
  return screen.getByRole("list", { name: "Catalog foods" });
}

function filterCatalog(value: string) {
  fireEvent.change(screen.getByLabelText(/filter foods/i), { target: { value } });
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

const withImage = CATALOG.find((food) => typeof food.image === "string" && food.image.length > 0);
const withoutImage = CATALOG.find((food) => !food.image);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, data: [] })));
});

afterEach(() => {
  cleanup();
});

describe("Marketplace product thumbnails", () => {
  it("shows the seed photo as a decorative 44px thumbnail in the catalog", () => {
    if (!withImage?.image) throw new Error("Seed has no photo row");
    render(<Home />);
    openMarketplace();
    filterCatalog(withImage.name);

    const row = catalogRow(withImage.name);
    const image = row.querySelector("img");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", withImage.image);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("width", "44");
    expect(image).toHaveAttribute("height", "44");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(image).toHaveClass("product-thumb");
    expect(row.querySelector(".product-thumb-fallback")).toBeNull();
  });

  it("uses the first letter in the same slot when a food has no photo", () => {
    if (!withoutImage) throw new Error("Seed has no photo-less row");
    render(<Home />);
    openMarketplace();
    filterCatalog(withoutImage.name);

    const row = catalogRow(withoutImage.name);
    expect(row.querySelector("img")).toBeNull();
    const fallback = row.querySelector(".product-thumb-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveTextContent(withoutImage.name.charAt(0).toUpperCase());
    expect(fallback).toHaveClass("product-thumb");
  });

  it("swaps a failed photo for the letter fallback", () => {
    if (!withImage?.image) throw new Error("Seed has no photo row");
    render(<Home />);
    openMarketplace();
    filterCatalog(withImage.name);

    const row = catalogRow(withImage.name);
    const image = row.querySelector("img");
    if (!image) throw new Error("No catalog photo");
    fireEvent.error(image);

    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".product-thumb-fallback")).toHaveTextContent(
      withImage.name.charAt(0).toUpperCase(),
    );
  });

  it("keeps the photo on the saved row after adding from the catalog, including a reload", () => {
    if (!withImage?.image) throw new Error("Seed has no photo row");
    const first = render(<Home />);
    openMarketplace();
    filterCatalog(withImage.name);

    fireEvent.click(screen.getByRole("button", { name: `Add ${withImage.name} to list` }));

    const row = savedRow(withImage.name);
    const image = row.querySelector("img");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", withImage.image);
    expect(JSON.parse(localStorage.getItem(MARKET_KEY) ?? "[]")[0].image).toBe(withImage.image);

    first.unmount();
    render(<Home />);
    openMarketplace();

    expect(savedRow(withImage.name).querySelector("img")).toHaveAttribute("src", withImage.image);
  });

  it("credits the catalog and its images on one line", () => {
    render(<Home />);
    openMarketplace();

    const credit = screen.getByText("Catalog and images: Open Food Facts (ODbL, CC BY-SA)");
    expect(credit).toHaveClass("market-credit");
    expect(credit.querySelector("a")).toBeNull();
  });
});
