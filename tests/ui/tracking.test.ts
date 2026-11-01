import { beforeEach, describe, expect, it } from "vitest";
import { installMemoryStorage, makeEntry, makeNutrition } from "./testUtils";

installMemoryStorage();

import { GOALS_KEY, clearGoals, loadGoals, parseGoalInput, saveGoals } from "../../src/client/goals";
import {
  FAVORITES_KEY,
  entryAsSavedFood,
  foodKey,
  loadFavorites,
  saveFavorites,
  toggleFavorite,
} from "../../src/client/favorites";
import {
  nutritionPer100g,
  recentFoods,
  summarizeDays,
  totalsFor,
  weeklyAverage,
} from "../../src/client/history";
import { diaryEntryValues } from "../../src/client/diary";

const date = "2026-10-20";

beforeEach(() => {
  localStorage.clear();
});

describe("device-local goals", () => {
  it("persists valid goals, reloads them, and clears on request", () => {
    saveGoals({ proteinG: 120, energyKcal: 2000 });
    expect(JSON.parse(localStorage.getItem(GOALS_KEY) ?? "null")).toEqual({ proteinG: 120, energyKcal: 2000 });
    expect(loadGoals()).toEqual({ proteinG: 120, energyKcal: 2000 });
    clearGoals();
    expect(loadGoals()).toEqual({ proteinG: null, energyKcal: null });
  });

  it("rejects zero, negative, and non-numeric goals while allowing a blank unset goal", () => {
    expect(parseGoalInput("120", "g")).toEqual({ ok: true, value: 120 });
    expect(parseGoalInput("  ", "g")).toEqual({ ok: true, value: null });
    expect(parseGoalInput("0", "g").ok).toBe(false);
    expect(parseGoalInput("-2", "kcal").ok).toBe(false);
    expect(parseGoalInput("abc", "g").ok).toBe(false);
    expect(parseGoalInput("Infinity", "g").ok).toBe(false);
  });

  it("ignores invalid stored goals instead of inventing a target", () => {
    localStorage.setItem(GOALS_KEY, JSON.stringify({ proteinG: 0, energyKcal: -5 }));
    expect(loadGoals()).toEqual({ proteinG: null, energyKcal: null });
    localStorage.setItem(GOALS_KEY, "{not json");
    expect(loadGoals()).toEqual({ proteinG: null, energyKcal: null });
  });
});

describe("today's totals", () => {
  it("sums known values and marks totals partial whenever any entry is unknown", () => {
    const known = makeEntry({ id: "known", date, amount: { amount: 200, unit: "g" } });
    const unknown = makeEntry({ id: "unknown", date, nutrition: null });

    expect(totalsFor([known])).toEqual({ proteinG: 20, energyKcal: 200, entryCount: 1, partial: false });
    expect(totalsFor([known, unknown])).toMatchObject({ proteinG: 20, energyKcal: 200, entryCount: 2, partial: true });
    expect(totalsFor([unknown])).toMatchObject({ proteinG: null, energyKcal: null, partial: true });
    expect(totalsFor([])).toMatchObject({ proteinG: 0, energyKcal: 0, entryCount: 0, partial: false });
  });
});

describe("recent foods", () => {
  it("deduplicates by name and barcode, keeps the most recent amount, and returns at most six", () => {
    const entries = [
      makeEntry({ id: "new", date, name: "Yogurt", barcode: "111", amount: { amount: 250, unit: "g" } }),
      makeEntry({ id: "old", date, name: "Yogurt", barcode: "111", amount: { amount: 100, unit: "g" } }),
      makeEntry({ id: "no-barcode", date, name: "Yogurt", amount: { amount: 50, unit: "g" } }),
      ...["Oats", "Eggs", "Tofu", "Beans", "Lentils"].map((name, index) =>
        makeEntry({ id: `food-${index}`, date, name }),
      ),
    ];

    const recent = recentFoods(entries);
    expect(recent).toHaveLength(6);
    expect(recent[0]).toMatchObject({ key: "yogurt::111", amount: { amount: 250, unit: "g" } });
    expect(recent[1].key).toBe(foodKey(entries[2].food));
    expect(recent.filter((item) => item.food.name === "Yogurt")).toHaveLength(2);
  });
});

describe("favourites", () => {
  it("toggles a food on and off by name and barcode and survives a storage round-trip", () => {
    const item = entryAsSavedFood(
      makeEntry({ id: "one", date, name: "Yogurt", barcode: "111", amount: { amount: 250, unit: "g" } }),
    );
    const saved = toggleFavorite([], item);
    expect(saved).toHaveLength(1);
    expect(saved[0].key).toBe("yogurt::111");

    // Toggling the same food again removes it, regardless of a changed amount.
    expect(toggleFavorite(saved, { ...item, amount: { amount: 300, unit: "g" } })).toEqual([]);

    saveFavorites(saved);
    expect(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")).toHaveLength(1);
    expect(loadFavorites()).toEqual(saved);
  });

  it("drops duplicate stored favourites and malformed records", () => {
    const item = entryAsSavedFood(makeEntry({ id: "one", date, name: "Yogurt", barcode: "111" }));
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([item, item, { broken: true }]));
    expect(loadFavorites()).toEqual([item]);
  });
});

describe("history and weekly average", () => {
  it("summarizes only days with entries, newest first, and marks partial days", () => {
    const entries = [
      makeEntry({ id: "a", date: "2026-10-20", amount: { amount: 200, unit: "g" } }),
      makeEntry({ id: "b1", date: "2026-10-19" }),
      makeEntry({ id: "b2", date: "2026-10-19", nutrition: null }),
      makeEntry({ id: "c", date: "2026-10-18", nutrition: makeNutrition(30, 300) }),
    ];

    const days = summarizeDays(entries);
    expect(days.map((day) => day.date)).toEqual(["2026-10-20", "2026-10-19", "2026-10-18"]);
    expect(days[0]).toMatchObject({ proteinG: 20, energyKcal: 200, partial: false, entryCount: 1 });
    expect(days[1]).toMatchObject({ proteinG: 10, energyKcal: 100, partial: true, entryCount: 2 });
    expect(days[2]).toMatchObject({ proteinG: 30, energyKcal: 300, partial: false, entryCount: 1 });
  });

  it("limits history to the last seven days that have entries", () => {
    const entries = Array.from({ length: 8 }, (_, index) => {
      const day = String(20 - index).padStart(2, "0");
      return makeEntry({ id: `day-${index}`, date: `2026-10-${day}`, nutrition: makeNutrition((index + 1) * 10, 100) });
    });
    const days = summarizeDays(entries);
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2026-10-20");
    expect(days[6].date).toBe("2026-10-14");
    expect(days.some((day) => day.date === "2026-10-13")).toBe(false);
  });

  it("averages only over included days with entries, never zero-filling unknown values", () => {
    const days = summarizeDays([
      makeEntry({ id: "a", date: "2026-10-20", amount: { amount: 200, unit: "g" } }),
      makeEntry({ id: "b1", date: "2026-10-19" }),
      makeEntry({ id: "b2", date: "2026-10-19", nutrition: null }),
      makeEntry({ id: "c", date: "2026-10-18", nutrition: makeNutrition(30, 300) }),
    ]);

    expect(weeklyAverage(days)).toMatchObject({
      proteinG: 20,
      energyKcal: 200,
      partial: true,
      dayCount: 3,
    });
    expect(weeklyAverage([])).toMatchObject({ proteinG: null, energyKcal: null, partial: false, dayCount: 0 });
  });

  it("scales search results to per 100 g only when a conversion exists", () => {
    const food = makeEntry({ id: "x", date }).food;
    expect(nutritionPer100g(food, makeNutrition(10, 100))).toEqual({ proteinG: 10, energyKcal: 100 });
    expect(nutritionPer100g(food, makeNutrition(20, 200, { amount: 200, unit: "g" }))).toEqual({
      proteinG: 10,
      energyKcal: 100,
    });
    expect(nutritionPer100g(food, null)).toEqual({ proteinG: null, energyKcal: null });
    // A serving basis cannot be scaled without a serving size.
    expect(nutritionPer100g(food, makeNutrition(5, 50, { amount: 1, unit: "serving" }))).toEqual({
      proteinG: null,
      energyKcal: null,
    });
  });
});

describe("existing diary values", () => {
  it("keeps scaling diary nutrition for actual amounts", () => {
    expect(
      diaryEntryValues(makeEntry({ id: "y", date, amount: { amount: 200, unit: "g" } })),
    ).toEqual({ proteinG: 20, energyKcal: 200 });
  });
});
