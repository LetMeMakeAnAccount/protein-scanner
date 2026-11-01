"use client";

import React, { useEffect, useState } from "react";
import type { DiaryEntry } from "../contracts/types";
import { formatNumber } from "../client/format";
import { NO_GOALS, parseGoalInput, type DailyGoals } from "../client/goals";
import { todayISO, totalsFor } from "../client/history";

type Props = {
  entries: DiaryEntry[];
  goals: DailyGoals;
  onSaveGoals: (goals: DailyGoals) => boolean;
};

type GoalBarProps = {
  label: string;
  unit: "g" | "kcal";
  consumed: number | null;
  goal: number | null;
  partial: boolean;
};

function GoalBar({ label, unit, consumed, goal, partial }: GoalBarProps) {
  if (goal === null) {
    return (
      <div className="goal-card">
        <div className="goal-head">
          <h3>{label}</h3>
        </div>
        <p className="goal-value goal-unset">Set a daily goal</p>
        <p className="goal-remaining">
          {consumed === null ? "Logged amount not known yet." : `${formatNumber(consumed)} ${unit} logged today`}
        </p>
      </div>
    );
  }

  const percent = consumed === null ? 0 : Math.min((consumed / goal) * 100, 100);
  const over = consumed !== null && consumed > goal;
  const valueText =
    consumed === null
      ? `${label} total is not known yet${partial ? ", partial totals" : ""}.`
      : `${formatNumber(consumed)} ${unit} of ${formatNumber(goal)} ${unit} ${label.toLowerCase()}${
          partial ? ", partial totals" : ""
        }.`;

  return (
    <div className={`goal-card${over ? " is-over" : ""}`}>
      <div className="goal-head">
        <h3>{label}</h3>
        <span className="muted small">
          {formatNumber(goal)} {unit} goal
        </span>
      </div>
      <p className="goal-value">
        {consumed === null ? "Not known yet" : `${formatNumber(consumed)} ${unit}`}
        <span className="goal-value-suffix">
          {" "}
          of {formatNumber(goal)} {unit}
          {partial ? " (partial)" : ""}
        </span>
      </p>
      <div
        className={`progress-track${over ? " is-over" : ""}`}
        role="progressbar"
        aria-label={`${label} progress toward daily goal`}
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-valuenow={consumed === null ? undefined : Math.min(consumed, goal)}
        aria-valuetext={valueText}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="goal-remaining">
        {consumed === null
          ? "Remaining amount not known yet."
          : over
            ? `${formatNumber(consumed - goal)} ${unit} over goal`
            : consumed === goal
              ? "Goal met."
              : `${formatNumber(goal - consumed)} ${unit} remaining`}
      </p>
    </div>
  );
}

export default function GoalsProgress({ entries, goals, onSaveGoals }: Props) {
  const [proteinInput, setProteinInput] = useState(goals.proteinG === null ? "" : String(goals.proteinG));
  const [energyInput, setEnergyInput] = useState(goals.energyKcal === null ? "" : String(goals.energyKcal));
  const [errors, setErrors] = useState<{ protein?: string; energy?: string; form?: string }>({});
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setProteinInput(goals.proteinG === null ? "" : String(goals.proteinG));
    setEnergyInput(goals.energyKcal === null ? "" : String(goals.energyKcal));
  }, [goals.proteinG, goals.energyKcal]);

  const today = todayISO();
  const todaysEntries = entries.filter((entry) => entry.date === today);
  const totals = totalsFor(todaysEntries);
  const hasGoal = goals.proteinG !== null || goals.energyKcal !== null;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const protein = parseGoalInput(proteinInput, "g");
    const energy = parseGoalInput(energyInput, "kcal");
    const nextErrors: typeof errors = {
      protein: protein.ok ? undefined : protein.message,
      energy: energy.ok ? undefined : energy.message,
    };
    setErrors(nextErrors);
    setNotice("");
    if (!protein.ok || !energy.ok) return;

    const saved = onSaveGoals({ proteinG: protein.value, energyKcal: energy.value });
    if (saved) {
      setNotice("Goals saved. They stay on this device.");
    } else {
      setErrors({ form: "This browser would not save your goals. They may be unavailable right now." });
    }
  }

  function handleClear() {
    setErrors({});
    setNotice("");
    if (onSaveGoals(NO_GOALS)) {
      setNotice("Goals cleared.");
    } else {
      setErrors({ form: "This browser would not clear your goals. They may be unavailable right now." });
    }
  }

  return (
    <section className="card" aria-labelledby="today-heading">
      <div className="diary-head">
        <h2 id="today-heading">Today</h2>
        {totals.partial && <span className="badge partial-badge">Partial totals</span>}
      </div>

      <form className="goal-form" onSubmit={handleSubmit} noValidate>
        <h3 className="goal-form-heading">Daily goals</h3>
        <p className="muted small">
          Your own targets, saved on this device only. The app never assumes a goal for you.
        </p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="goal-protein">Daily protein goal (g)</label>
            <input
              id="goal-protein"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={proteinInput}
              aria-invalid={Boolean(errors.protein)}
              aria-describedby={errors.protein ? "goal-protein-error" : undefined}
              onChange={(event) => {
                setProteinInput(event.target.value);
                setErrors((current) => ({ ...current, protein: undefined, form: undefined }));
                setNotice("");
              }}
            />
            {errors.protein && (
              <p className="field-error" id="goal-protein-error" role="alert">
                {errors.protein}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="goal-energy">Daily calorie goal (kcal)</label>
            <input
              id="goal-energy"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={energyInput}
              aria-invalid={Boolean(errors.energy)}
              aria-describedby={errors.energy ? "goal-energy-error" : undefined}
              onChange={(event) => {
                setEnergyInput(event.target.value);
                setErrors((current) => ({ ...current, energy: undefined, form: undefined }));
                setNotice("");
              }}
            />
            {errors.energy && (
              <p className="field-error" id="goal-energy-error" role="alert">
                {errors.energy}
              </p>
            )}
          </div>
        </div>
        <div className="action-row">
          <button type="submit" className="button button-primary">
            Save goals
          </button>
          {hasGoal && (
            <button type="button" className="button button-quiet" onClick={handleClear}>
              Clear goals
            </button>
          )}
        </div>
        {errors.form && (
          <p role="alert" className="alert">
            {errors.form}
          </p>
        )}
        {notice && (
          <p role="status" aria-live="polite" className="success">
            {notice}
          </p>
        )}
      </form>

      <div className="today-summary">
        <h3 className="today-summary-heading">Logged today</h3>
        <p className="today-totals">
          {totals.proteinG === null ? "Protein not known" : `${formatNumber(totals.proteinG)} g protein`}
          {" · "}
          {totals.energyKcal === null ? "energy not known" : `${formatNumber(totals.energyKcal)} kcal`}
          {totals.partial ? " — partial totals, some entries have unknown values." : ""}
        </p>
        <div className="goal-grid">
          <GoalBar label="Protein" unit="g" consumed={totals.proteinG} goal={goals.proteinG} partial={totals.partial} />
          <GoalBar
            label="Calories"
            unit="kcal"
            consumed={totals.energyKcal}
            goal={goals.energyKcal}
            partial={totals.partial}
          />
        </div>
        {todaysEntries.length === 0 && (
          <p className="muted small">Nothing logged today yet. Add a food below or scan one from the Scan tab.</p>
        )}
      </div>
    </section>
  );
}
