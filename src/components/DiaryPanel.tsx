import React from "react";
import type { DiaryEntry } from "../contracts/types";
import { diaryEntryValues } from "../client/diary";

export function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

type Props = {
  entries: DiaryEntry[];
  onDelete: (id: string) => void;
  onClearAll: () => void;
};

export default function DiaryPanel({ entries, onDelete, onClearAll }: Props) {
  const values = entries.map(diaryEntryValues);
  const anyUnknown = values.some((v) => v.proteinG === null || v.energyKcal === null);
  const proteinTotal = values.reduce((sum, v) => sum + (v.proteinG ?? 0), 0);
  const kcalTotal = values.reduce((sum, v) => sum + (v.energyKcal ?? 0), 0);
  const anyProtein = values.some((v) => v.proteinG !== null);
  const anyKcal = values.some((v) => v.energyKcal !== null);

  return (
    <section className="diary" aria-labelledby="diary-heading">
      <div className="diary-head">
        <h2 id="diary-heading">Today's diary</h2>
        {entries.length > 0 && (
          <button type="button" className="button button-quiet" onClick={onClearAll}>
            Clear all
          </button>
        )}
      </div>
      <p className="muted">
        Entries stay in this browser — clearing browser data or changing devices will lose them.
      </p>
      {entries.length === 0 ? (
        <p className="muted">Nothing saved yet. Confirm a food, then add it here.</p>
      ) : (
        <>
          <ul className="diary-list">
            {entries.map((entry, index) => {
              const v = values[index];
              return (
                <li key={entry.id} className="diary-entry">
                  <div className="diary-entry-main">
                    <strong>{entry.food.name}</strong>
                    <span className="muted">
                      {entry.date} · {formatNumber(entry.amount.amount)} {entry.amount.unit}
                    </span>
                    <span className="diary-values">
                      {v.proteinG !== null && <span>{formatNumber(v.proteinG)} g protein</span>}
                      {v.energyKcal !== null && <span>{formatNumber(v.energyKcal)} kcal</span>}
                      {v.proteinG === null && v.energyKcal === null && <span>Protein and energy not known</span>}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-quiet"
                    aria-label={`Delete ${entry.food.name}`}
                    onClick={() => onDelete(entry.id)}
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="diary-totals">
            Totals{anyUnknown ? " (partial)" : ""}: {anyProtein ? `${formatNumber(proteinTotal)} g protein` : "protein not known"}
            {" · "}
            {anyKcal ? `${formatNumber(kcalTotal)} kcal` : "energy not known"}
            {anyUnknown ? " — some entries are missing values, so these totals are incomplete." : ""}
          </p>
        </>
      )}
    </section>
  );
}
