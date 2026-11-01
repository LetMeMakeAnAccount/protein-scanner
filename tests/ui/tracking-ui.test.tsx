import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryStorage, makeEntry, makeFood, makeNutrition, offSource } from "./testUtils";

installMemoryStorage();

import Home from "../../src/app/page";
import { DIARY_KEY } from "../../src/client/diary";
import { GOALS_KEY } from "../../src/client/goals";
import { FAVORITES_KEY } from "../../src/client/favorites";
import { todayISO } from "../../src/client/history";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function openTab(name: "Scan" | "Diary" | "Progress") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function todayRegion() {
  return within(screen.getByRole("region", { name: "Today" }));
}

const offFood = makeFood("Oats from OFF", { barcode: "12345678", source: offSource });
const offNutrition = makeNutrition(13, 370, { amount: 100, unit: "g" }, offSource);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("tab navigation", () => {
  it("keeps Scan as the primary default tab and opens Diary and Progress", () => {
    render(<Home />);
    expect(screen.getByRole("tab", { name: "Scan" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /scan with camera/i })).toBeInTheDocument();

    openTab("Diary");
    expect(screen.getByRole("tab", { name: "Diary" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: /^today$/i })).toBeInTheDocument();

    openTab("Progress");
    expect(screen.getByRole("heading", { name: /^progress$/i })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Progress" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Scan" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("daily goals and today's progress", () => {
  it("persists goals, shows consumed against goal and remaining numbers, and labels partial totals", async () => {
    const today = todayISO();
    localStorage.setItem(
      DIARY_KEY,
      JSON.stringify([
        makeEntry({ id: "known", date: today, amount: { amount: 200, unit: "g" } }),
        makeEntry({ id: "unknown", date: today, nutrition: null }),
      ]),
    );

    const view = render(<Home />);
    openTab("Diary");

    expect(todayRegion().getAllByText("Set a daily goal")).toHaveLength(2);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/daily protein goal/i), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText(/daily calorie goal/i), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /save goals/i }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(GOALS_KEY) ?? "null")).toEqual({ proteinG: 120, energyKcal: 2000 }),
    );
    expect(await screen.findByText(/goals saved/i)).toBeInTheDocument();

    const proteinBar = screen.getByRole("progressbar", { name: /protein progress toward daily goal/i });
    expect(proteinBar).toHaveAttribute("aria-valuemax", "120");
    expect(proteinBar).toHaveAttribute("aria-valuenow", "20");
    expect(proteinBar.getAttribute("aria-valuetext")).toMatch(/20 g of 120 g protein/i);
    expect(proteinBar.getAttribute("aria-valuetext")).toMatch(/partial/i);

    const calorieBar = screen.getByRole("progressbar", { name: /calories progress toward daily goal/i });
    expect(calorieBar).toHaveAttribute("aria-valuemax", "2000");
    expect(calorieBar).toHaveAttribute("aria-valuenow", "200");

    expect(todayRegion().getByText("100 g remaining")).toBeInTheDocument();
    expect(todayRegion().getByText("1,800 kcal remaining")).toBeInTheDocument();
    expect(todayRegion().getAllByText(/partial/i).length).toBeGreaterThan(0);

    view.unmount();
    render(<Home />);
    openTab("Diary");
    await waitFor(() => expect(screen.getByLabelText(/daily protein goal/i)).toHaveValue(120));
    expect(screen.getByLabelText(/daily calorie goal/i)).toHaveValue(2000);
    expect(screen.getByRole("progressbar", { name: /protein progress toward daily goal/i })).toHaveAttribute(
      "aria-valuemax",
      "120",
    );
  });

  it("rejects a non-positive goal with a message and saves nothing", async () => {
    render(<Home />);
    openTab("Diary");

    fireEvent.change(screen.getByLabelText(/daily protein goal/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /save goals/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/greater than 0/i);
    expect(localStorage.getItem(GOALS_KEY)).toBeNull();
    expect(todayRegion().getAllByText("Set a daily goal")).toHaveLength(2);
  });

  it("lists partial total labels when an unknown entry is the only entry", async () => {
    localStorage.setItem(DIARY_KEY, JSON.stringify([makeEntry({ id: "unknown", date: todayISO(), nutrition: null })]));
    render(<Home />);
    openTab("Diary");
    fireEvent.change(screen.getByLabelText(/daily protein goal/i), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /save goals/i }));

    const proteinBar = await screen.findByRole("progressbar", { name: /protein progress toward daily goal/i });
    expect(proteinBar).not.toHaveAttribute("aria-valuenow");
    expect(proteinBar.getAttribute("aria-valuetext")).toMatch(/not known/i);
    expect(todayRegion().getByText(/protein not known/i)).toBeInTheDocument();
  });
});

describe("recent and favourite foods", () => {
  it("deduplicates recent foods by name and barcode and adds the latest amount in one tap without a request", async () => {
    const today = todayISO();
    localStorage.setItem(
      DIARY_KEY,
      JSON.stringify([
        makeEntry({ id: "new", date: today, name: "Yogurt", barcode: "111", amount: { amount: 250, unit: "g" } }),
        makeEntry({ id: "old", date: today, name: "Yogurt", barcode: "111", amount: { amount: 100, unit: "g" } }),
        makeEntry({ id: "oats", date: today, name: "Oats" }),
      ]),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openTab("Diary");

    const recent = within(screen.getByRole("region", { name: "Recent" }));
    expect(recent.getAllByText("Yogurt")).toHaveLength(1);
    expect(recent.getByText("250 g")).toBeInTheDocument();

    fireEvent.click(recent.getByRole("button", { name: /add yogurt again from recent/i }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(4));
    const stored = JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]");
    expect(stored[0]).toMatchObject({
      food: { name: "Yogurt", barcode: "111" },
      amount: { amount: 250, unit: "g" },
      date: today,
    });
    expect(await screen.findByText(/added yogurt to today/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toggles a diary entry into device-local favourites, adds it again in one tap, and removes it", async () => {
    localStorage.setItem(DIARY_KEY, JSON.stringify([makeEntry({ id: "one", date: todayISO(), name: "Yogurt" })]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<Home />);
    openTab("Diary");

    const star = screen.getByRole("button", { name: "Favourite Yogurt" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    expect(star).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")).toHaveLength(1));

    view.unmount();
    render(<Home />);
    openTab("Diary");

    const favourites = within(await screen.findByRole("region", { name: "Favourites" }));
    expect(favourites.getByText("Yogurt")).toBeInTheDocument();
    fireEvent.click(favourites.getByRole("button", { name: /add yogurt again from favourites/i }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(2));
    expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")[0].amount).toEqual({ amount: 100, unit: "g" });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(favourites.getByRole("button", { name: /remove yogurt from favourites/i }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")).toHaveLength(0));
    expect(favourites.getByText(/star an entry to keep it here/i)).toBeInTheDocument();
  });
});

describe("quick search and barcode", () => {
  it("searches, shows per-100 g values and source, and logs a chosen gram amount", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/foods/search?q=Oats");
      return jsonResponse({ ok: true, data: [{ food: offFood, nutrition: offNutrition }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openTab("Diary");

    fireEvent.change(screen.getByLabelText(/search open food facts/i), { target: { value: "Oats" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByText("Oats from OFF")).toBeInTheDocument();
    expect(screen.getByText("13 g protein per 100 g")).toBeInTheDocument();
    expect(screen.getByText("370 kcal per 100 g")).toBeInTheDocument();
    const resultItem = screen.getByText("Oats from OFF").closest("li");
    expect(resultItem).not.toBeNull();
    expect(within(resultItem as HTMLElement).getByText(/open food facts/i)).toBeInTheDocument();

    const amount = screen.getByLabelText(/amount in grams for oats from off/i);
    expect(amount).toHaveValue(100);
    fireEvent.change(amount, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /add oats from off to today/i }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(1));
    const stored = JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]");
    expect(stored[0]).toMatchObject({
      food: { name: "Oats from OFF", barcode: "12345678" },
      nutrition: offNutrition,
      amount: { amount: 150, unit: "g" },
      date: todayISO(),
    });
    expect(await screen.findByText(/added oats from off to today/i)).toBeInTheDocument();
  });

  it("looks up a barcode and adds the default 100 g amount", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/foods/lookup?barcode=12345678");
      return jsonResponse({ ok: true, data: [{ food: offFood, nutrition: offNutrition }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openTab("Diary");
    fireEvent.change(screen.getByLabelText(/^barcode$/i), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /look up barcode/i }));

    expect(await screen.findByText("Oats from OFF")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add oats from off to today/i }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")[0].amount).toEqual({ amount: 100, unit: "g" });
  });

  it("allows adding a result with no nutrition and warns that totals will be partial", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: [{ food: offFood, nutrition: null }] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openTab("Diary");
    fireEvent.change(screen.getByLabelText(/search open food facts/i), { target: { value: "Oats" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByText(/no nutrition values are listed/i)).toBeInTheDocument();
    expect(screen.getByText(/count as unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/protein unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add oats from off to today/i }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")[0].nutrition).toBeNull();
    expect(todayRegion().getAllByText(/partial/i).length).toBeGreaterThan(0);
    expect(todayRegion().getByText(/protein not known/i)).toBeInTheDocument();
  });

  it("reports a 503 without adding anything or pretending a match exists", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "unavailable", message: "Open Food Facts did not respond." } }, 503),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Home />);
    openTab("Diary");
    fireEvent.change(screen.getByLabelText(/search open food facts/i), { target: { value: "Oats" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/open food facts did not respond/i);
    expect(screen.queryByText(/add oats from off to today/i)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(DIARY_KEY) ?? "[]")).toHaveLength(0);
  });
});

describe("history and weekly view", () => {
  it("lists days with entries, averages only over those days, and marks partial days", async () => {
    localStorage.setItem(
      DIARY_KEY,
      JSON.stringify([
        makeEntry({ id: "a", date: "2026-10-20", amount: { amount: 200, unit: "g" } }),
        makeEntry({ id: "b1", date: "2026-10-19" }),
        makeEntry({ id: "b2", date: "2026-10-19", nutrition: null }),
        makeEntry({ id: "c", date: "2026-10-18", nutrition: makeNutrition(30, 300) }),
        makeEntry({ id: "d", date: "2026-10-17", nutrition: null }),
      ]),
    );

    render(<Home />);
    openTab("Progress");

    expect(screen.getByRole("heading", { name: /7-day average/i })).toBeInTheDocument();
    expect(screen.getByText("20 g protein per day")).toBeInTheDocument();
    expect(screen.getByText("200 kcal per day")).toBeInTheDocument();
    expect(screen.getByText(/averaged over 4 days with entries/i)).toBeInTheDocument();
    expect(screen.getByText(/partial — some included days/i)).toBeInTheDocument();

    const list = within(screen.getByRole("list", { name: /days with entries/i }));
    expect(list.getAllByRole("listitem")).toHaveLength(4);
    expect(list.getByText("20 g protein")).toBeInTheDocument();
    expect(list.getByText("10 g protein")).toBeInTheDocument();
    expect(list.getByText("30 g protein")).toBeInTheDocument();
    expect(list.getByText(/protein not known/i)).toBeInTheDocument();
    expect(list.getAllByText(/partial/i).length).toBeGreaterThan(0);
  });

  it("limits history to seven days that have entries and never zero-fills gaps", async () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      makeEntry({
        id: `day-${index}`,
        date: `2026-10-${String(20 - index).padStart(2, "0")}`,
        nutrition: makeNutrition((index + 1) * 10, 100),
      }),
    );
    localStorage.setItem(DIARY_KEY, JSON.stringify(entries));

    render(<Home />);
    openTab("Progress");

    expect(screen.getByText(/averaged over 7 days with entries/i)).toBeInTheDocument();
    const list = within(screen.getByRole("list", { name: /days with entries/i }));
    expect(list.getAllByRole("listitem")).toHaveLength(7);
    expect(list.queryByText(/Oct 13/i)).not.toBeInTheDocument();
  });

  it("shows an honest empty state when there are no entries", () => {
    render(<Home />);
    openTab("Progress");
    expect(screen.getByRole("heading", { name: /7-day average/i })).toBeInTheDocument();
    expect(screen.getByText(/no days with entries yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 g protein per day/i)).not.toBeInTheDocument();
  });
});
