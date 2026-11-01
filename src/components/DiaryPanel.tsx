"use client";

import React, { useState } from "react";
import type { DiaryEntry } from "../contracts/types";
import { diaryEntryValues } from "../client/diary";
import { entryAsSavedFood, foodKey, type FoodServing, type SavedFood } from "../client/favorites";
import { formatNumber } from "../client/format";
import { formatDayLabel, todayISO } from "../client/history";
import FoodShortcuts from "./FoodShortcuts";
import GoalsProgress from "./GoalsProgress";
import QuickAdd from "./QuickAdd";
import type { DailyGoals } from "../client/goals";

export { formatNumber } from "../client/format";

type Props = {
  entries: DiaryEntry[];
  goals: DailyGoals;
  favorites: SavedFood[];
  onDelete: (id: string) => boolean;
  onClearAll: () => boolean;
  onSaveGoals: (goals: DailyGoals) => boolean;
  onToggleFavorite: (item: FoodServing) => boolean;
  onAddFood: (item: FoodServing) => boolean;
};

export default function DiaryPanel({
  entries,
  goals,
  favorites,
  onDelete,
  onClearAll,
  onSaveGoals,
  onToggleFavorite,
  onAddFood,
}: Props) {
  const [entryError, setEntryError] = useState("");
  const [favoriteError, setFavoriteError] = useState("");
  const today = todayISO();
  const favoriteKeys = new Set(favorites.map((item) => item.key));

  function handleToggleFavorite(item: FoodServing) {
    if (onToggleFavorite(item)) {
      setFavoriteError("");
      return true;
    }
    setFavoriteError("This browser would not save that change. Your favourites may be unavailable right now.");
    return false;
  }

  function handleDelete(id: string) {
    if (onDelete(id)) {
      setEntryError("");
    } else {
      setEntryError("This browser would not save that change. Your diary may be unavailable or full.");
    }
  }

  function handleClearAll() {
    if (onClearAll()) {
      setEntryError("");
    } else {
      setEntryError("This browser would not save that change. Your diary may be unavailable or full.");
    }
  }

  return (
    <>
      <GoalsProgress entries={entries} goals={goals} onSaveGoals={onSaveGoals} />
      <QuickAdd onAddFood={onAddFood} />
      <FoodShortcuts
        entries={entries}
        favorites={favorites}
        onAddFood={onAddFood}
        onToggleFavorite={handleToggleFavorite}
      />

      <section className="card diary" aria-labelledby="diary-heading">
        <div className="diary-head">
          <h2 id="diary-heading">Diary</h2>
          {entries.length > 0 && (
            <button type="button" className="button button-quiet" onClick={handleClearAll}>
              Clear all
            </button>
          )}
        </div>
        <p className="muted small">
          Entries stay in this browser, along with favourites and goals — clearing browser data or changing devices
          will lose them.
        </p>

        {entries.length === 0 ? (
          <p className="muted">Nothing saved yet. Confirm a food from the Scan tab, or add one above.</p>
        ) : (
          <>
            <ul className="diary-list">
              {entries.map((entry) => {
                const values = diaryEntryValues(entry);
                const favorite = favoriteKeys.has(foodKey(entry.food));
                return (
                  <li key={entry.id} className="diary-entry">
                    <div className="diary-entry-main">
                      <strong>{entry.food.name}</strong>
                      <span className="muted small">
                        {formatDayLabel(entry.date, today)} · {formatNumber(entry.amount.amount)} {entry.amount.unit}
                      </span>
                      <span className="diary-values">
                        {values.proteinG !== null && <span>{formatNumber(values.proteinG)} g protein</span>}
                        {values.energyKcal !== null && <span>{formatNumber(values.energyKcal)} kcal</span>}
                        {values.proteinG === null && values.energyKcal === null && (
                          <span>Protein and energy not known</span>
                        )}
                        {(values.proteinG === null || values.energyKcal === null) &&
                          !(values.proteinG === null && values.energyKcal === null) && (
                            <span className="partial-tag">partial</span>
                          )}
                      </span>
                    </div>
                    <div className="entry-actions">
                      <button
                        type="button"
                        className="star-button"
                        aria-pressed={favorite}
                        aria-label={`${favorite ? "Unfavourite" : "Favourite"} ${entry.food.name}`}
                        onClick={() => handleToggleFavorite(entryAsSavedFood(entry))}
                      >
                        <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        aria-label={`Delete ${entry.food.name}`}
                        onClick={() => handleDelete(entry.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="muted small diary-count">
              {entries.length} {entries.length === 1 ? "entry" : "entries"} saved in this browser. Open Progress for
              per-day totals.
            </p>
          </>
        )}

        {entryError && (
          <p role="alert" className="alert">
            {entryError}
          </p>
        )}
        {favoriteError && (
          <p role="alert" className="alert">
            {favoriteError}
          </p>
        )}
      </section>
    </>
  );
}
