"use client";

import React, { useState } from "react";
import type { DiaryEntry } from "../contracts/types";
import { servingValues } from "../client/diary";
import type { FoodServing, SavedFood } from "../client/favorites";
import { formatNumber } from "../client/format";
import { recentFoods } from "../client/history";

type Props = {
  entries: DiaryEntry[];
  favorites: SavedFood[];
  onAddFood: (item: FoodServing) => boolean;
  onToggleFavorite: (item: FoodServing) => boolean;
};

function valuesLine(item: FoodServing): string {
  const values = servingValues(item.food, item.nutrition, item.amount);
  const protein = values.proteinG === null ? "protein not known" : `${formatNumber(values.proteinG)} g protein`;
  const energy = values.energyKcal === null ? "energy not known" : `${formatNumber(values.energyKcal)} kcal`;
  return `${protein} · ${energy}`;
}

export default function FoodShortcuts({ entries, favorites, onAddFood, onToggleFavorite }: Props) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const recent = recentFoods(entries);

  function addAgain(item: FoodServing) {
    if (onAddFood(item)) {
      setError("");
      setNotice(`Added ${item.food.name} to today.`);
    } else {
      setNotice("");
      setError("This browser would not save the entry. Your diary may be unavailable or full.");
    }
  }

  function removeFavorite(item: FoodServing) {
    if (onToggleFavorite(item)) {
      setError("");
      setNotice(`${item.food.name} removed from favourites.`);
    } else {
      setNotice("");
      setError("This browser would not save that change. Your favourites may be unavailable right now.");
    }
  }

  function row(item: SavedFood, source: "recent" | "favourites") {
    return (
      <li className="match shortcut-row" key={item.key}>
        <div className="match-main">
          <strong>{item.food.name}</strong>
          <span className="shortcut-meta">
            <span>
              {formatNumber(item.amount.amount)} {item.amount.unit}
            </span>
            <span>{valuesLine(item)}</span>
          </span>
        </div>
        <div className="shortcut-actions">
          <button
            type="button"
            className="button button-primary"
            aria-label={`Add ${item.food.name} again from ${source}`}
            onClick={() => addAgain(item)}
          >
            Add again
          </button>
          {source === "favourites" && (
            <button
              type="button"
              className="star-button"
              aria-pressed="true"
              aria-label={`Remove ${item.food.name} from favourites`}
              onClick={() => removeFavorite(item)}
            >
              <span aria-hidden="true">★</span>
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <section className="card shortcuts" aria-labelledby="shortcuts-heading">
      <h2 id="shortcuts-heading">Add again</h2>
      <p className="muted small">One tap logs the same food and amount to today. No lookup is needed.</p>

      <section className="shortcut-block" aria-labelledby="recent-heading">
        <h3 id="recent-heading">Recent</h3>
        {recent.length === 0 ? (
          <p className="muted small">Foods you log in the diary will show up here.</p>
        ) : (
          <ul className="match-list">{recent.map((item) => row(item, "recent"))}</ul>
        )}
      </section>

      <section className="shortcut-block" aria-labelledby="favourites-heading">
        <h3 id="favourites-heading">Favourites</h3>
        {favorites.length === 0 ? (
          <p className="muted small">Star an entry to keep it here.</p>
        ) : (
          <ul className="match-list">{favorites.map((item) => row(item, "favourites"))}</ul>
        )}
      </section>

      {notice && (
        <p role="status" aria-live="polite" className="success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}
