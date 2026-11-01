import type { Basis, DiaryEntry, Food, Nutrition } from "../contracts/types";
import { convertBasis } from "../domain/units";
import { diaryEntryValues } from "./diary";
import { entryAsSavedFood, type SavedFood } from "./favorites";

/** The user's local calendar day, matching how a food diary is usually counted. */
export function todayISO(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type DayTotals = {
  proteinG: number | null;
  energyKcal: number | null;
  entryCount: number;
  partial: boolean;
};

export type DaySummary = DayTotals & { date: string };

/**
 * Sums only known values. A day with entries but no known protein reports null,
 * never zero. Any unknown entry marks the whole day's totals partial.
 */
export function totalsFor(entries: DiaryEntry[]): DayTotals {
  if (entries.length === 0) {
    return { proteinG: 0, energyKcal: 0, entryCount: 0, partial: false };
  }
  let proteinG: number | null = null;
  let energyKcal: number | null = null;
  let partial = false;
  for (const entry of entries) {
    const values = diaryEntryValues(entry);
    if (values.proteinG === null || values.energyKcal === null) partial = true;
    if (values.proteinG !== null) proteinG = (proteinG ?? 0) + values.proteinG;
    if (values.energyKcal !== null) energyKcal = (energyKcal ?? 0) + values.energyKcal;
  }
  return { proteinG, energyKcal, entryCount: entries.length, partial };
}

/** The most recent `limit` distinct days that have entries, newest first. Missing days are never filled in. */
export function summarizeDays(entries: DiaryEntry[], limit = 7): DaySummary[] {
  const groups = new Map<string, DiaryEntry[]>();
  for (const entry of entries) {
    const day = groups.get(entry.date);
    if (day) day.push(entry);
    else groups.set(entry.date, [entry]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .slice(0, limit)
    .map(([date, dayEntries]) => ({ date, ...totalsFor(dayEntries) }));
}

export type WeeklyAverage = {
  proteinG: number | null;
  energyKcal: number | null;
  partial: boolean;
  dayCount: number;
};

/**
 * Averages the included days only. Unknown values are skipped, not counted as
 * zero, and the result is partial when any included day is partial.
 */
export function weeklyAverage(days: DaySummary[]): WeeklyAverage {
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    proteinG: mean(days.flatMap((day) => (day.proteinG === null ? [] : [day.proteinG]))),
    energyKcal: mean(days.flatMap((day) => (day.energyKcal === null ? [] : [day.energyKcal]))),
    partial: days.some((day) => day.partial),
    dayCount: days.length,
  };
}

/** Last distinct foods from the diary (newest first), with their most recent amount. */
export function recentFoods(entries: DiaryEntry[], limit = 6): SavedFood[] {
  const seen = new Set<string>();
  const result: SavedFood[] = [];
  for (const entry of entries) {
    const item = entryAsSavedFood(entry);
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

/** Protein/kcal scaled to 100 g for a search result, or null where no conversion exists. */
export function nutritionPer100g(
  food: Food,
  nutrition: Nutrition | null,
): { proteinG: number | null; energyKcal: number | null } {
  if (!nutrition) return { proteinG: null, energyKcal: null };
  const per100g: Basis = { amount: 100, unit: "g" };
  return {
    proteinG: nutrition.proteinG === null ? null : convertBasis(nutrition.proteinG, nutrition.basis, per100g, food),
    energyKcal:
      nutrition.energyKcal === null ? null : convertBasis(nutrition.energyKcal, nutrition.basis, per100g, food),
  };
}

/** Human label for a diary date; "Today" for the current day, otherwise a short date. */
export function formatDayLabel(date: string, today: string = todayISO()): string {
  if (date === today) return "Today";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
