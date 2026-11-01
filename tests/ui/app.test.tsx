import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../../src/app/page";
import { DIARY_KEY } from "../../src/client/diary";

// Node 22's experimental global localStorage shadows jsdom's Storage in Vitest
// (window.localStorage is undefined), so install a Storage-shaped stand-in.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const offFood = {
  id: "12345678",
  barcode: "12345678",
  name: "Oats from OFF",
  source: { kind: "off" as const, label: "Open Food Facts", productId: "12345678", url: "https://world.openfoodfacts.org/product/12345678" },
  packageBasis: { amount: 500, unit: "g" as const },
  servingSize: null,
  servingsPerPackage: null,
};
const offNutrition = { proteinG: 13, energyKcal: 370, basis: { amount: 100, unit: "g" as const }, source: offFood.source };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fillManualAndConfirm(overrides: { packageAmount?: string } = {}) {
  fireEvent.click(screen.getByRole("button", { name: /enter manually/i }));
  fireEvent.change(screen.getByLabelText(/item name/i), { target: { value: "Test food" } });
  fireEvent.change(screen.getByLabelText(/price amount/i), { target: { value: "4" } });
  if (overrides.packageAmount !== "") {
    fireEvent.change(screen.getByLabelText(/package amount/i), { target: { value: overrides.packageAmount ?? "200" } });
  }
  fireEvent.change(screen.getByLabelText(/protein \(g\)/i), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText(/energy \(kcal\)/i), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("button", { name: /confirm and see results/i }));
}

describe("Protein Scanner UI", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("gates camera and upload behind one unselected consent checkbox, but not manual or example", () => {
    render(<Home />);
    const checkbox = screen.getByRole("checkbox", { name: /sent to Meta for analysis and is not stored by this app/i });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: /scan with camera/i })).toBeDisabled();
    expect(screen.getByLabelText(/upload photo/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /try example/i })).toBeEnabled();

    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: /scan with camera/i })).toBeEnabled();
    expect(screen.getByLabelText(/upload photo/i)).toBeEnabled();
  });

  it("manual flow calculates 5 g/USD and 10 g/100 kcal for a 200 g, $4 pack at 10 g/100 g", async () => {
    render(<Home />);
    await fillManualAndConfirm();
    expect(await screen.findByText("5 g/USD")).toBeInTheDocument();
    expect(screen.getByText("10 g/100 kcal")).toBeInTheDocument();
    expect(screen.getByText(/test food/i)).toBeInTheDocument();
  });

  it("shows honest Unavailable messaging when the package amount is missing, keeping the per-100-kcal metric", async () => {
    render(<Home />);
    await fillManualAndConfirm({ packageAmount: "" });
    expect(await screen.findByText(/Unavailable:/)).toBeInTheDocument();
    expect(screen.getByText("10 g/100 kcal")).toBeInTheDocument();
  });

  it("adds to the diary, persists on this device only, reloads, and deletes", async () => {
    const view = render(<Home />);
    await fillManualAndConfirm();
    fireEvent.click(await screen.findByRole("button", { name: /add to today's diary/i }));
    expect(await screen.findByText(/added to today's diary/i)).toBeInTheDocument();
    expect(screen.getByText(/saved on this device only/i)).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].food.name).toBe("Test food");
    expect(stored[0]).not.toHaveProperty("price");

    view.unmount();
    render(<Home />);
    expect(await screen.findByText(/test food/i)).toBeInTheDocument();
    // Diary nutrition for the full 200 g pack at 10 g / 100 kcal per 100 g.
    expect(screen.getAllByText(/20 g protein/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/200 kcal/).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: /delete test food/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(0));
    expect(screen.queryByText(/test food/i)).not.toBeInTheDocument();
  });

  it("clears all diary entries", async () => {
    const entry = {
      id: "entry-1",
      food: { name: "Seeded food", source: { kind: "user" as const, label: "Your entry" }, packageBasis: { amount: 100, unit: "g" as const }, servingSize: null, servingsPerPackage: null },
      nutrition: { proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" as const }, source: { kind: "user" as const, label: "Your entry" } },
      amount: { amount: 100, unit: "g" as const },
      date: "2026-11-01",
    };
    localStorage.setItem(DIARY_KEY, JSON.stringify([entry]));
    render(<Home />);
    expect(await screen.findByText(/seeded food/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(0));
  });

  it("labels the example as sample data and never calls the network for it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /try example/i }));
    expect(await screen.findByText(/Example — sample data, not a live lookup/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/item name/i)).toHaveValue("Greek yogurt");
    expect(screen.getByLabelText(/price amount/i)).toHaveValue(5.49);
    fireEvent.click(screen.getByRole("button", { name: /confirm and see results/i }));
    expect(await screen.findByText(/16\.52 g\/USD/)).toBeInTheDocument();
    expect(screen.getByText(/Example — sample data, not a live lookup/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches Open Food Facts by name and only applies a match on explicit selection", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/foods/search?q=");
      return jsonResponse({ ok: true, data: [{ food: offFood, nutrition: offNutrition }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /enter manually/i }));
    fireEvent.change(screen.getByLabelText(/item name/i), { target: { value: "Oats" } });
    fireEvent.click(screen.getByRole("button", { name: /find nutrition/i }));
    expect(await screen.findByText(/oats from off/i)).toBeInTheDocument();
    // Not applied until the user picks it.
    expect(screen.getByLabelText(/protein \(g\)/i)).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: /use this match/i }));
    expect(screen.getByLabelText(/protein \(g\)/i)).toHaveValue(13);
    expect(screen.getByLabelText(/item name/i)).toHaveValue("Oats from OFF");
    expect(screen.getByRole("link", { name: /open food facts/i })).toHaveAttribute("href", offFood.source.url);
    fireEvent.click(screen.getByRole("button", { name: /reject match/i }));
    expect(screen.getByLabelText(/item name/i)).toHaveValue("Oats");
  });

  it("analyzes an uploaded photo only with consent and pre-fills label nutrition as checkable", async () => {
    const candidate = {
      item: "Uploaded bars",
      barcode: null,
      price: { amount: 3.5, currency: "USD", basis: { amount: 1, unit: "package" }, source: "label" },
      labelNutrition: { proteinG: 20, energyKcal: 200, basis: { amount: 100, unit: "g" }, source: { kind: "label", label: "Visible label", visibleText: "Protein 20 g per 100 g" } },
      uncertainties: ["Check the price"],
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("metaConsent")).toBe("true");
      expect(body.get("image")).toBeInstanceOf(Blob);
      return jsonResponse({ ok: true, data: { candidate } });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });

    render(<Home />);
    fireEvent.click(screen.getByRole("checkbox", { name: /sent to meta/i }));
    const input = screen.getByLabelText(/upload photo/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["fake"], "photo.jpg", { type: "image/jpeg" })] } });

    expect(await screen.findByDisplayValue("Uploaded bars")).toBeInTheDocument();
    expect(screen.getByText(/from label — check it/i)).toBeInTheDocument();
    expect(screen.getByText(/check the price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/protein \(g\)/i)).toHaveValue(20);
  });

  it("explains a denied camera without blocking manual entry", async () => {
    const getUserMedia = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    render(<Home />);
    fireEvent.click(screen.getByRole("checkbox", { name: /sent to meta/i }));
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    expect(await screen.findByText(/camera permission was denied/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter manually instead/i })).toBeInTheDocument();
  });
});
