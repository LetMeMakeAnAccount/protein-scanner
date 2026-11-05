import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";

const productUrl = "https://world.openfoodfacts.org/product/12345678";

const offSource = {
  kind: "off" as const,
  label: "Open Food Facts",
  productId: "12345678",
  url: productUrl,
};

const offNutrition = {
  proteinG: 12,
  energyKcal: 200,
  basis: { amount: 100, unit: "g" as const },
  source: offSource,
};

const offFood = {
  id: "12345678",
  barcode: "12345678",
  name: "Oats from OFF",
  source: offSource,
  packageBasis: { amount: 500, unit: "g" as const },
  servingSize: null,
  servingsPerPackage: null,
};

const serverNote = 'Nutrition filled from Open Food Facts for "Oats from OFF" - check it.';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubImageDecode() {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
    callback(new Blob(["encoded"], { type: "image/jpeg" })),
  );
}

function stubObjectUrls() {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
}

/** Uploads a scan candidate and lets a test answer any follow-up lookups. */
function uploadCandidate(
  candidate: unknown,
  reply: (url: string) => Response = () => jsonResponse({ ok: true, data: { candidate } }),
) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => reply(String(url)));
  vi.stubGlobal("fetch", fetchMock);
  stubImageDecode();
  stubObjectUrls();

  render(<Home />);
  fireEvent.change(screen.getByLabelText(/upload photo/i), {
    target: { files: [new File(["fake"], "photo.jpg", { type: "image/jpeg" })] },
  });
  return fetchMock;
}

describe("nutrition provenance", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("shows the label as the source and keeps Meta's uncertainty text", async () => {
    uploadCandidate({
      item: null,
      barcode: null,
      price: null,
      labelNutrition: {
        proteinG: 10,
        energyKcal: 100,
        basis: { amount: 100, unit: "g" },
        source: { kind: "label", label: "Visible label", visibleText: "10 g protein per 100 g" },
      },
      uncertainties: ["Check the price"],
    });

    expect(await screen.findByRole("heading", { name: /check the details/i })).toBeInTheDocument();
    expect(screen.getByText("From the label")).toBeInTheDocument();
    expect(screen.getByText("Check it against the package")).toBeInTheDocument();
    expect(screen.getByText("Check the price")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open food facts/i })).not.toBeInTheDocument();
  });

  it("marks a barcode match and links the Open Food Facts product page", async () => {
    const candidate = {
      item: null,
      barcode: "12345678",
      price: null,
      labelNutrition: offNutrition,
      uncertainties: ["Check the price", serverNote],
    };
    uploadCandidate(
      candidate,
      (url) =>
        url.includes("/api/foods/lookup")
          ? jsonResponse({ ok: true, data: [] })
          : jsonResponse({ ok: true, data: { candidate } }),
    );

    expect(await screen.findByRole("heading", { name: /check the details/i })).toBeInTheDocument();
    expect(screen.getByText("Matched by barcode")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open food facts/i });
    expect(link).toHaveAttribute("href", productUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Check the price")).toBeInTheDocument();
    expect(screen.queryByText(serverNote)).not.toBeInTheDocument();
  });

  it("says to check a name match", async () => {
    uploadCandidate({
      item: null,
      barcode: null,
      price: null,
      labelNutrition: offNutrition,
      uncertainties: [],
    });

    expect(await screen.findByRole("heading", { name: /check the details/i })).toBeInTheDocument();
    expect(screen.getByText("Matched by name — check it")).toBeInTheDocument();
  });

  it("shows Open Food Facts provenance beside the nutrition fields on results", async () => {
    uploadCandidate({
      item: "Oats from OFF",
      barcode: "12345678",
      price: null,
      labelNutrition: offNutrition,
      uncertainties: ["Check the price", serverNote],
    });

    expect(await screen.findByRole("heading", { name: /^results$/i })).toBeInTheDocument();
    expect(screen.getByText("Nutrition from Open Food Facts — check it.")).toBeInTheDocument();
    expect(screen.queryByText("Check the label — values can be wrong.")).not.toBeInTheDocument();

    const link = screen.getByRole("link", { name: /open food facts product page/i });
    expect(link).toHaveAttribute("href", productUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByText("From Open Food Facts")).toBeInTheDocument();
    expect(screen.getByText("Check the price")).toBeInTheDocument();
    expect(screen.queryByText(serverNote)).not.toBeInTheDocument();
  });

  it("offers Find nutrition, prefilled with the item name, when no values were found", async () => {
    const candidate = {
      item: "Mystery bar",
      barcode: null,
      price: null,
      labelNutrition: null,
      uncertainties: [],
    };
    const fetchMock = uploadCandidate(candidate, (url) =>
      url.includes("/api/foods/search")
        ? jsonResponse({ ok: true, data: [{ food: offFood, nutrition: offNutrition }] })
        : jsonResponse({ ok: true, data: { candidate } }),
    );

    expect(await screen.findByRole("heading", { name: /^results$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/protein \(g\)/i)).toHaveValue(null);
    expect(screen.getByLabelText(/energy \(kcal\)/i)).toHaveValue(null);
    expect(screen.getByRole("button", { name: /^find nutrition$/i })).toBeInTheDocument();
    expect(screen.queryByText(/no nutrition values|enter them from the label/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nutrition from Open Food Facts/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^find nutrition$/i }));

    expect(await screen.findByText("Oats from OFF")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /check the details/i })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/foods/search?q=Mystery%20bar")),
    ).toBe(true);
  });
});
