import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function stubCamera() {
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 480 });
  return getUserMedia;
}

/** Uploads decode through createImageBitmap before the canvas re-encode in jsdom. */
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

/** jsdom has no canvas rendering, so stand in a context and an encoded JPEG. */
function stubFrameCapture() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,preview");
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
    callback(new Blob(["frame"], { type: "image/jpeg" })),
  );
}

const emptyCandidate = { item: null, barcode: null, price: null, labelNutrition: null, uncertainties: [] };

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
    vi.useRealTimers();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts camera scanning and upload immediately, with one static notice and no consent checkbox", async () => {
    const getUserMedia = stubCamera();
    render(<Home />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByText("Photos are analyzed by Meta's AI and are not kept by this app."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /scan with camera/i })).toBeEnabled();
    expect(screen.getByLabelText(/upload photo/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /try example/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: /scan with camera/i })).toBeInTheDocument();
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

  it("adds to the diary, stays in this browser, reloads, and deletes", async () => {
    const view = render(<Home />);
    await fillManualAndConfirm();
    fireEvent.click(await screen.findByRole("button", { name: /add to today's diary/i }));
    expect(await screen.findByText(/added to today's diary/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Diary" }));
    expect(screen.getByText(/entries stay in this browser/i)).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].food.name).toBe("Test food");
    expect(stored[0]).not.toHaveProperty("price");

    view.unmount();
    render(<Home />);
    fireEvent.click(screen.getByRole("tab", { name: "Diary" }));
    expect((await screen.findAllByText(/test food/i)).length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole("tab", { name: "Diary" }));
    expect((await screen.findAllByText(/seeded food/i)).length).toBeGreaterThan(0);
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

  it("analyzes an uploaded photo immediately with only the image in the form, pre-filling label nutrition as checkable", async () => {
    const candidate = {
      item: "Uploaded bars",
      barcode: null,
      price: { amount: 3.5, currency: "USD", basis: { amount: 1, unit: "package" }, source: "label" },
      labelNutrition: { proteinG: 20, energyKcal: 200, basis: { amount: 100, unit: "g" }, source: { kind: "label", label: "Visible label", visibleText: "Protein 20 g per 100 g" } },
      uncertainties: ["Check the price"],
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.has("metaConsent")).toBe(false);
      expect(body.get("image")).toBeInstanceOf(Blob);
      return jsonResponse({ ok: true, data: { candidate } });
    });
    vi.stubGlobal("fetch", fetchMock);
    stubImageDecode();
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });

    render(<Home />);
    const input = screen.getByLabelText(/upload photo/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["fake"], "photo.jpg", { type: "image/jpeg" })] } });

    expect(await screen.findByDisplayValue("Uploaded bars")).toBeInTheDocument();
    expect(screen.getByText(/from label — check it/i)).toBeInTheDocument();
    expect(screen.getByText(/check the price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/protein \(g\)/i)).toHaveValue(20);
  });

  it("explains a denied camera on the home screen without blocking manual entry", async () => {
    const getUserMedia = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    expect(await screen.findByText(/camera permission was denied/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^start$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /scan with camera/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeInTheDocument();
  });

  it("stops sampling on an item with no price, opens review with the name filled and price blank, and stays honest through results and diary", async () => {
    vi.useFakeTimers();
    stubCamera();
    stubFrameCapture();
    const candidate = {
      item: "Multivitamin bottle",
      barcode: null,
      price: null,
      labelNutrition: {
        proteinG: 10,
        energyKcal: 100,
        basis: { amount: 100, unit: "g" },
        source: { kind: "label", label: "Visible label", visibleText: "10 g protein per 100 g" },
      },
      uncertainties: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { candidate } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    for (let tick = 0; tick < 4 && fetchMock.mock.calls.length < 1; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/item name/i)).toHaveValue("Multivitamin bottle");
    expect(screen.getByLabelText(/price amount/i)).toHaveValue(null);
    expect(screen.queryByText(/enter an item name before confirming/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm and see results/i }));
    expect(
      await screen.findByText(/Unavailable: A valid price and matching nutrition quantity are required\./),
    ).toBeInTheDocument();
    expect(screen.getByText("10 g/100 kcal")).toBeInTheDocument();
    expect(screen.getByText(/price: not given/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/amount to add/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /add to today's diary/i }));
    expect(await screen.findByText(/added to today's diary/i)).toBeInTheDocument();
  });

  it("keeps the item prominent when both price and nutrition are missing, shows both unavailable reasons, and offers a name search", async () => {
    vi.useFakeTimers();
    stubCamera();
    stubFrameCapture();
    const candidate = { ...emptyCandidate, item: "Multivitamin bottle" };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/api/scan/analyze")) return jsonResponse({ ok: true, data: { candidate } });
      if (target.includes("/api/foods/search")) return jsonResponse({ ok: true, data: [] });
      throw new Error(`Unexpected request: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    for (let tick = 0; tick < 4 && fetchMock.mock.calls.length < 1; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    vi.useRealTimers();

    expect(screen.getByRole("heading", { level: 3, name: "Multivitamin bottle" })).toBeInTheDocument();
    expect(screen.getByLabelText(/item name/i)).toHaveValue("Multivitamin bottle");
    expect(screen.getByLabelText(/price amount/i)).toHaveValue(null);

    fireEvent.click(screen.getByRole("button", { name: /confirm and see results/i }));
    expect(await screen.findByText(/item: multivitamin bottle/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Unavailable: A valid price and matching nutrition quantity are required\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Unavailable: Protein and positive kcal on the same basis are required\./),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /find nutrition by name/i }));
    expect(await screen.findByText(/no open food facts match for that name/i)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/foods/search?q=Multivitamin%20bottle")),
    ).toBe(true);
  });

  it.each([
    [403, "forbidden", "Origin not allowed", /not allowed to use photo analysis \(403\).*ALLOWED_ORIGINS/i],
    [429, "rate_limit", "Request rate limit reached", /too many photos were scanned just now \(429\)/i],
    [503, "unavailable", "Image analysis unavailable", /unavailable right now \(503\).*may not be configured/i],
    [503, "ai_auth_failed", "AI request was not authorized", /AI key was rejected.*MUSE_API_KEY in the deployment settings/i],
    [503, "ai_billing", "AI account has no billing", /no credits or billing set up.*Meta developer portal/i],
    [503, "ai_forbidden", "AI provider rejected the request", /AI provider refused this request.*region or key restriction/i],
    [503, "ai_model_missing", "AI model not found", /configured AI model wasn't found.*MUSE_MODEL/i],
    [503, "ai_rate_limited", "AI is rate limiting requests", /AI is rate-limiting right now.*enter the values yourself/i],
    [503, "ai_timeout", "AI request timed out", /AI took too long to respond.*closer, brighter photo/i],
    [400, "invalid_input", "Invalid input", /retake it with the camera or choose a JPEG\/PNG/i],
    [415, "unsupported_media_type", "Expected multipart image", /retake it with the camera or choose a JPEG\/PNG/i],
  ])("shows an honest message for a %i analysis response (%s)", async (status, code, message, expected) => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: { code, message } }, status));
    vi.stubGlobal("fetch", fetchMock);
    stubImageDecode();
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:preview"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });

    render(<Home />);
    fireEvent.change(screen.getByLabelText(/upload photo/i), {
      target: { files: [new File(["fake"], "photo.heic", { type: "image/heic" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(screen.getByRole("button", { name: /enter manually/i })).toBeInTheDocument();
  });

  it("stops after four empty analyses and opens review with the fallback message", async () => {
    vi.useFakeTimers();
    stubCamera();
    stubFrameCapture();
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { candidate: emptyCandidate } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: /scan with camera/i }));
    for (let tick = 0; tick < 12 && fetchMock.mock.calls.length < 4; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    vi.useRealTimers();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("heading", { name: /check the details/i })).toBeInTheDocument();
    expect(screen.getByText(/couldn't read the label\. type the item name and what you can see\./i)).toBeInTheDocument();
    expect(screen.getByLabelText(/item name/i)).toHaveValue("");
    expect(screen.getByLabelText(/price amount/i)).toHaveValue(null);
  });
});
