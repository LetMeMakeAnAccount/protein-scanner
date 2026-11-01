"use client";

import React, { useRef, useState } from "react";
import { ApiError, lookupBarcode, searchFoods, type FoodMatch } from "../client/api";
import { foodKey } from "../client/favorites";
import { formatNumber } from "../client/format";
import { nutritionPer100g } from "../client/history";
import type { FoodServing } from "../client/favorites";

type Props = {
  onAddFood: (item: FoodServing) => boolean;
};

function resultWarning(match: FoodMatch, values: { proteinG: number | null; energyKcal: number | null }): string {
  if (!match.nutrition) {
    return "No nutrition values are listed — this will count as unknown, so today's totals will be partial.";
  }
  if (values.proteinG === null && values.energyKcal === null) {
    return "These values can't be scaled to grams — this will count as unknown, so today's totals will be partial.";
  }
  if (values.proteinG === null || values.energyKcal === null) {
    return "Some values are unavailable, so today's totals will be partial.";
  }
  return "";
}

function describeLookupError(error: unknown): string {
  if (error instanceof ApiError && error.code === "rate_limit") {
    return "Too many lookups were made just now. Nothing was added. Wait a moment and try again.";
  }
  return "Open Food Facts did not respond. Nothing was added. Try again, or enter the values yourself in the Scan tab.";
}

export default function QuickAdd({ onAddFood }: Props) {
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [matches, setMatches] = useState<FoodMatch[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"search" | "barcode" | null>(null);
  const requestRef = useRef(0);

  function begin(): number {
    const id = ++requestRef.current;
    setError("");
    setNotice("");
    setMatches([]);
    return id;
  }

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (!q) {
      setError("Enter a food name to search.");
      setStatus("");
      setNotice("");
      return;
    }
    const id = begin();
    setBusy("search");
    setStatus("Searching Open Food Facts…");
    try {
      const found = await searchFoods(q);
      if (requestRef.current !== id) return;
      setMatches(found);
      setStatus(
        found.length > 0
          ? `Found ${found.length} ${found.length === 1 ? "match" : "matches"}. Check the name and values — nothing is added until you tap Add to today.`
          : "No Open Food Facts match for that name. Try a different search, or add what you already have.",
      );
    } catch (error) {
      if (requestRef.current !== id) return;
      setStatus("");
      setError(describeLookupError(error));
    } finally {
      if (requestRef.current === id) setBusy(null);
    }
  }

  async function handleBarcode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = barcode.trim();
    if (!code) {
      setError("Enter a barcode to look up.");
      setStatus("");
      setNotice("");
      return;
    }
    if (!/^\d{4,24}$/.test(code)) {
      setError("Enter a barcode of 4 to 24 digits.");
      setStatus("");
      setNotice("");
      return;
    }
    const id = begin();
    setBusy("barcode");
    setStatus("Looking up this barcode in Open Food Facts…");
    try {
      const found = await lookupBarcode(code);
      if (requestRef.current !== id) return;
      setMatches(found);
      setStatus(
        found.length > 0
          ? "Found a possible Open Food Facts match below. Check it before adding — nothing is added automatically."
          : "No Open Food Facts match for this barcode. Check the number, or search by name.",
      );
    } catch (error) {
      if (requestRef.current !== id) return;
      setStatus("");
      setError(describeLookupError(error));
    } finally {
      if (requestRef.current === id) setBusy(null);
    }
  }

  function handleAdd(match: FoodMatch, key: string) {
    const raw = amounts[key] ?? "100";
    const grams = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(grams) || grams <= 0) {
      setError("Enter an amount greater than 0 g.");
      setNotice("");
      return;
    }
    const added = onAddFood({
      food: match.food,
      nutrition: match.nutrition,
      amount: { amount: grams, unit: "g" },
    });
    if (added) {
      setError("");
      setNotice(`Added ${match.food.name} to today.`);
    } else {
      setNotice("");
      setError("This browser would not save the entry. Your diary may be unavailable or full.");
    }
  }

  return (
    <section className="card quick-add" aria-labelledby="quick-add-heading">
      <h2 id="quick-add-heading">Find a food</h2>
      <p className="muted small">
        Search Open Food Facts or use a barcode, then choose how much you ate. Values are shown per 100 g and scaled
        only when the basis allows it.
      </p>

      <form className="search-form" onSubmit={handleSearch}>
        <div className="field">
          <label htmlFor="food-search">Search Open Food Facts</label>
          <input
            id="food-search"
            type="search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button type="submit" className="button" disabled={busy !== null}>
          {busy === "search" ? "Searching…" : "Search"}
        </button>
      </form>

      <form className="barcode-form" onSubmit={handleBarcode}>
        <div className="field">
          <label htmlFor="quick-barcode">Barcode</label>
          <input
            id="quick-barcode"
            type="text"
            inputMode="numeric"
            value={barcode}
            autoComplete="off"
            onChange={(event) => setBarcode(event.target.value)}
          />
        </div>
        <button type="submit" className="button" disabled={busy !== null}>
          {busy === "barcode" ? "Looking up…" : "Look up barcode"}
        </button>
      </form>

      {status && (
        <p role="status" aria-live="polite" className="muted">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="success">
          {notice}
        </p>
      )}

      {matches.length > 0 && (
        <ul className="match-list">
          {matches.map((match, index) => {
            const key = `${foodKey(match.food)}-${index}`;
            const values = nutritionPer100g(match.food, match.nutrition);
            const warning = resultWarning(match, values);
            return (
              <li className="match food-match" key={key}>
                <div className="match-main">
                  <strong>{match.food.name}</strong>
                  <span className="muted small">
                    {match.food.source.label}
                    {match.food.barcode ? ` · ${match.food.barcode}` : ""}
                  </span>
                  <span className="match-values">
                    <span>
                      {values.proteinG === null
                        ? "Protein unavailable"
                        : `${formatNumber(values.proteinG)} g protein per 100 g`}
                    </span>
                    <span>
                      {values.energyKcal === null
                        ? "Energy unavailable"
                        : `${formatNumber(values.energyKcal)} kcal per 100 g`}
                    </span>
                  </span>
                  {warning && <p className="muted small match-warning">{warning}</p>}
                </div>
                <div className="match-add">
                  <div className="field">
                    <label htmlFor={`match-amount-${index}`}>Amount (g)</label>
                    <input
                      id={`match-amount-${index}`}
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={amounts[key] ?? "100"}
                      aria-label={`Amount in grams for ${match.food.name}`}
                      onChange={(event) => setAmounts((current) => ({ ...current, [key]: event.target.value }))}
                    />
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    aria-label={`Add ${match.food.name} to today`}
                    onClick={() => handleAdd(match, key)}
                  >
                    Add to today
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
