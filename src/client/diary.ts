import type { Basis, DiaryEntry, Food, Nutrition } from "../contracts/types";
import { convertBasis } from "../domain/units";

export const DIARY_KEY = "protein-scanner-diary-v1";

function isDiaryEntry(value: unknown): value is DiaryEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<DiaryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.date === "string" &&
    entry.food !== null &&
    typeof entry.food === "object" &&
    typeof (entry.food as { name?: unknown }).name === "string" &&
    entry.amount !== null &&
    typeof entry.amount === "object" &&
    typeof (entry.amount as { amount?: unknown }).amount === "number"
  );
}

/** Entries live only in this browser. Broken or foreign data is ignored, never repaired with invented values. */
export function loadDiary(storage: Pick<Storage, "getItem"> = localStorage): DiaryEntry[] {
  try {
    const raw = storage.getItem(DIARY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDiaryEntry);
  } catch {
    return [];
  }
}

export function saveDiary(entries: DiaryEntry[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(DIARY_KEY, JSON.stringify(entries));
}

/** Protein/kcal for one serving at `amount`, or null when no supported conversion exists. */
export function servingValues(
  food: Food,
  nutrition: Nutrition | null,
  amount: Basis,
): { proteinG: number | null; energyKcal: number | null } {
  if (!nutrition) return { proteinG: null, energyKcal: null };
  const { proteinG, energyKcal, basis } = nutrition;
  return {
    proteinG: proteinG === null ? null : convertBasis(proteinG, basis, amount, food),
    energyKcal: energyKcal === null ? null : convertBasis(energyKcal, basis, amount, food),
  };
}

/** Protein/kcal for the amount actually eaten, or null when no supported conversion exists. */
export function diaryEntryValues(entry: DiaryEntry): { proteinG: number | null; energyKcal: number | null } {
  return servingValues(entry.food, entry.nutrition, entry.amount);
}
