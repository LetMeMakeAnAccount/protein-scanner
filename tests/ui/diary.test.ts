import { describe, expect, it } from "vitest";
import { DIARY_KEY, diaryEntryValues, loadDiary, saveDiary } from "../../src/client/diary";

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
import type { DiaryEntry } from "../../src/contracts/types";

const entry: DiaryEntry = {
  id: "1",
  food: { name: "Yogurt", source: { kind: "user", label: "Your entry" }, packageBasis: { amount: 200, unit: "g" }, servingSize: null, servingsPerPackage: null },
  nutrition: { proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" }, source: { kind: "user", label: "Your entry" } },
  amount: { amount: 200, unit: "g" },
  date: "2026-11-01",
};

describe("device-local diary storage", () => {
  it("round-trips entries through localStorage and scales nutrition with convertBasis", () => {
    saveDiary([entry]);
    expect(localStorage.getItem(DIARY_KEY)).toContain("Yogurt");
    expect(loadDiary()).toEqual([entry]);
    expect(diaryEntryValues(entry)).toEqual({ proteinG: 20, energyKcal: 200 });
  });

  it("omits unknown nutrition instead of inventing zeros, and tolerates broken storage", () => {
    expect(diaryEntryValues({ ...entry, nutrition: null })).toEqual({ proteinG: null, energyKcal: null });
    // grams to litres has no supported conversion, so values stay unknown.
    expect(diaryEntryValues({ ...entry, amount: { amount: 1, unit: "l" } })).toEqual({ proteinG: null, energyKcal: null });
    localStorage.setItem(DIARY_KEY, "{not json");
    expect(loadDiary()).toEqual([]);
    localStorage.setItem(DIARY_KEY, JSON.stringify([{ broken: true }]));
    expect(loadDiary()).toEqual([]);
  });
});
