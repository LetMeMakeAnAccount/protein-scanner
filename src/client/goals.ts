export const GOALS_KEY = "protein-scanner-goals-v1";

/** Device-local daily targets. A null field is unset — never silently replaced with a default. */
export type DailyGoals = {
  proteinG: number | null;
  energyKcal: number | null;
};

export const NO_GOALS: DailyGoals = { proteinG: null, energyKcal: null };

function goalValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function loadGoals(storage: Pick<Storage, "getItem"> = localStorage): DailyGoals {
  try {
    const raw = storage.getItem(GOALS_KEY);
    if (!raw) return { ...NO_GOALS };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ...NO_GOALS };
    const record = parsed as { proteinG?: unknown; energyKcal?: unknown };
    return { proteinG: goalValue(record.proteinG), energyKcal: goalValue(record.energyKcal) };
  } catch {
    return { ...NO_GOALS };
  }
}

export function saveGoals(goals: DailyGoals, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(
    GOALS_KEY,
    JSON.stringify({ proteinG: goalValue(goals.proteinG), energyKcal: goalValue(goals.energyKcal) }),
  );
}

export function clearGoals(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(GOALS_KEY);
}

export type GoalInput = { ok: true; value: number | null } | { ok: false; message: string };

/** Blank means unset; anything else must be a positive, finite number. */
export function parseGoalInput(raw: string, unit: "g" | "kcal"): GoalInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      message: `Enter a ${unit === "g" ? "protein" : "calorie"} goal greater than 0 ${unit}, or leave it blank.`,
    };
  }
  return { ok: true, value };
}
