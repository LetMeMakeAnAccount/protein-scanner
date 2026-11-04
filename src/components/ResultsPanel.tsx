"use client";

import React from "react";
import type { Calculation, ConfirmedInput, Metric } from "../contracts/types";
import { EXAMPLE_BADGE } from "../client/example";
import { formatNumber } from "../client/format";
import {
  CURRENCIES,
  UNITS,
  effectivePackage,
  sourceTag,
  type Draft,
  type PhysicalUnit,
} from "./draft";

type SetField = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

type Props = {
  draft: Draft;
  input: ConfirmedInput;
  calculation: Calculation;
  diaryAmount: string;
  diaryUnit: PhysicalUnit;
  diaryNotice: string;
  diaryError: string;
  onField: SetField;
  onPackageAmount: (value: string) => void;
  onPackageUnit: (value: PhysicalUnit) => void;
  onDiaryAmount: (value: string) => void;
  onDiaryUnit: (value: PhysicalUnit) => void;
  onAddToDiary: () => void;
  onStartAgain: () => void;
};

const RETAILERS = [
  { name: "Walmart", url: (q: string) => `https://www.walmart.com/search?q=${q}` },
  { name: "Instacart", url: (q: string) => `https://www.instacart.com/store/s?k=${q}` },
  { name: "Target", url: (q: string) => `https://www.target.com/s?searchTerm=${q}` },
];

function metricValue(metric: Metric): string | null {
  return "value" in metric ? `${formatNumber(metric.value)} ${metric.unit}` : null;
}

export default function ResultsPanel({
  draft,
  input,
  calculation,
  diaryAmount,
  diaryUnit,
  diaryNotice,
  diaryError,
  onField,
  onPackageAmount,
  onPackageUnit,
  onDiaryAmount,
  onDiaryUnit,
  onAddToDiary,
  onStartAgain,
}: Props) {
  const packageInfo = effectivePackage(draft);
  const perCurrency = metricValue(calculation.proteinPerCurrency);
  const per100Kcal = metricValue(calculation.proteinPer100Kcal);
  const currencyLabel = input.price ? `Protein per ${draft.currency}` : "Protein per dollar";

  const tags = Array.from(
    new Set(
      [
        input.nutrition ? sourceTag(draft.nutritionSource) : null,
        input.price && draft.priceSource === "label" ? "From label" : null,
        packageInfo.estimated ? "Estimated" : null,
      ].filter((tag): tag is string => Boolean(tag)),
    ),
  );

  return (
    <section aria-labelledby="results-heading" className="card results">
      <header className="result-head">
        <div className="result-title">
          <h2 id="results-heading">Results</h2>
          <h3 className="result-item">{draft.name.trim() || "This item"}</h3>
        </div>
        <div className="result-tags">
          {draft.isExample && <p className="badge">{EXAMPLE_BADGE}</p>}
          {tags.map((tag) => (
            <span key={tag} className={`source-tag${tag === "Estimated" ? " is-estimate" : ""}`}>
              {tag}
            </span>
          ))}
        </div>
      </header>

      <div className="metrics" aria-live="polite">
        <div className="metric metric-primary" role="group" aria-label={currencyLabel}>
          <p className="metric-label">{currencyLabel}</p>
          {perCurrency ? (
            <p className="metric-value">{perCurrency}</p>
          ) : (
            <p className="metric-value is-missing">—</p>
          )}
        </div>
        <div className="metric" role="group" aria-label="Protein per 100 kcal">
          <p className="metric-label">Protein per 100 kcal</p>
          {per100Kcal ? (
            <p className="metric-value metric-value-small">{per100Kcal}</p>
          ) : (
            <p className="metric-value metric-value-small is-missing">—</p>
          )}
        </div>
      </div>

      <p className="check-line">Check the label — values can be wrong.</p>

      <section className="edit-values" aria-labelledby="edit-values-heading">
        <h3 id="edit-values-heading">Edit values</h3>
        <form onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="result-item-name">Item name</label>
            <input
              id="result-item-name"
              type="text"
              value={draft.name}
              autoComplete="off"
              onChange={(event) => onField("name", event.target.value)}
            />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="result-price-amount">Price amount</label>
              <input
                id="result-price-amount"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={draft.priceAmount}
                onChange={(event) => onField("priceAmount", event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="result-currency">Currency</label>
              <select
                id="result-currency"
                value={draft.currency}
                onChange={(event) => onField("currency", event.target.value)}
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid-2">
            <div className="field">
              <div className="field-label">
                <label htmlFor="result-package-amount">Package amount</label>
                {packageInfo.estimated && (
                  <span id="result-package-estimate" className="field-note">
                    Estimated 100 g
                  </span>
                )}
              </div>
              <input
                id="result-package-amount"
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={draft.packageAmount}
                aria-describedby={packageInfo.estimated ? "result-package-estimate" : undefined}
                onChange={(event) => onPackageAmount(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="result-package-unit">Package unit</label>
              <select
                id="result-package-unit"
                value={draft.packageUnit}
                onChange={(event) => onPackageUnit(event.target.value as PhysicalUnit)}
              >
                {UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className="nutrition">
            <legend>Nutrition</legend>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="result-protein-g">Protein (g)</label>
                <input
                  id="result-protein-g"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={draft.proteinG}
                  onChange={(event) => onField("proteinG", event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="result-energy-kcal">Energy (kcal)</label>
                <input
                  id="result-energy-kcal"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={draft.energyKcal}
                  onChange={(event) => onField("energyKcal", event.target.value)}
                />
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="result-basis-amount">Nutrition basis amount</label>
                <input
                  id="result-basis-amount"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={draft.basisAmount}
                  onChange={(event) => onField("basisAmount", event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="result-basis-unit">Nutrition basis unit</label>
                <select
                  id="result-basis-unit"
                  value={draft.basisUnit}
                  onChange={(event) => onField("basisUnit", event.target.value as PhysicalUnit)}
                >
                  {UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>
        </form>
      </section>

      <section className="diary-add" aria-labelledby="result-diary-heading">
        <h3 id="result-diary-heading">Add to today's diary</h3>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="result-diary-amount">Amount to add</label>
            <input
              id="result-diary-amount"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={diaryAmount}
              onChange={(event) => onDiaryAmount(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="result-diary-unit">Amount unit</label>
            <select
              id="result-diary-unit"
              value={diaryUnit}
              onChange={(event) => onDiaryUnit(event.target.value as PhysicalUnit)}
            >
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" className="button button-primary" onClick={onAddToDiary}>
          Add to today's diary
        </button>
        {diaryNotice && (
          <p role="status" aria-live="polite" className="success">
            {diaryNotice}
          </p>
        )}
        {diaryError && (
          <p role="alert" className="alert">
            {diaryError}
          </p>
        )}
      </section>

      <section className="retailers" aria-labelledby="result-retailers-heading">
        <h3 id="result-retailers-heading">Compare prices elsewhere</h3>
        <div className="action-row">
          {RETAILERS.map((retailer) => (
            <a
              key={retailer.name}
              className="button retailer-link"
              href={retailer.url(encodeURIComponent(draft.name.trim() || input.food.name))}
              target="_blank"
              rel="noreferrer"
            >
              Search {retailer.name} — prices there, not here
            </a>
          ))}
        </div>
      </section>

      <div className="action-row">
        <button type="button" className="button button-quiet" onClick={onStartAgain}>
          Start again
        </button>
      </div>
    </section>
  );
}
