import type { Basis, DiaryEntry, Food, Nutrition, Source } from "../../src/contracts/types";

/** Node 22's experimental global localStorage shadows jsdom's Storage in Vitest. */
export class MemoryStorage implements Storage {
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

export function installMemoryStorage(): void {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
}

export const userSource: Source = { kind: "user", label: "Your entry" };
export const offSource: Source = {
  kind: "off",
  label: "Open Food Facts",
  productId: "12345678",
  url: "https://world.openfoodfacts.org/product/12345678",
};

export function makeNutrition(
  proteinG: number | null,
  energyKcal: number | null,
  basis: Basis = { amount: 100, unit: "g" },
  source: Source = userSource,
): Nutrition {
  return { proteinG, energyKcal, basis, source };
}

export function makeFood(name: string, options: { barcode?: string; source?: Source } = {}): Food {
  return {
    name,
    ...(options.barcode ? { barcode: options.barcode } : {}),
    source: options.source ?? userSource,
    packageBasis: null,
    servingSize: null,
    servingsPerPackage: null,
  };
}

export function makeEntry(options: {
  id: string;
  date: string;
  name?: string;
  barcode?: string;
  amount?: Basis;
  nutrition?: Nutrition | null;
}): DiaryEntry {
  const name = options.name ?? "Yogurt";
  return {
    id: options.id,
    date: options.date,
    food: makeFood(name, { barcode: options.barcode }),
    nutrition:
      options.nutrition === undefined ? makeNutrition(10, 100) : options.nutrition,
    amount: options.amount ?? { amount: 100, unit: "g" },
  };
}
