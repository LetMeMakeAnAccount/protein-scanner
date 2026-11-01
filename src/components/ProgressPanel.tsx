import React from "react";
import type { DiaryEntry } from "../contracts/types";
import { formatNumber } from "../client/format";
import { formatDayLabel, summarizeDays, todayISO, weeklyAverage } from "../client/history";

type Props = {
  entries: DiaryEntry[];
};

export default function ProgressPanel({ entries }: Props) {
  const today = todayISO();
  const days = summarizeDays(entries, 7);
  const average = weeklyAverage(days);

  return (
    <section className="card progress" aria-labelledby="progress-heading">
      <h2 id="progress-heading">Progress</h2>
      <p className="muted">
        The last 7 days with entries. Days with no entries and values that are unknown are left out — nothing is
        filled in with zero.
      </p>

      {days.length === 0 ? (
        <>
          <h3>7-day average</h3>
          <p className="muted">No days with entries yet. Add a food in the Diary tab to start.</p>
        </>
      ) : (
        <>
          <div className={`average-card${average.partial ? " is-partial" : ""}`}>
            <div className="diary-head">
              <h3>7-day average</h3>
              {average.partial && <span className="badge partial-badge">Partial</span>}
            </div>
            <p className="average-values">
              <span>
                {average.proteinG === null
                  ? "protein not known per day"
                  : `${formatNumber(average.proteinG)} g protein per day`}
              </span>
              <span>
                {average.energyKcal === null
                  ? "energy not known per day"
                  : `${formatNumber(average.energyKcal)} kcal per day`}
              </span>
            </p>
            <p className="muted small">
              Averaged over {average.dayCount} {average.dayCount === 1 ? "day" : "days"} with entries.
              {average.partial ? " Partial — some included days have unknown values." : ""}
            </p>
          </div>

          <h3>Day by day</h3>
          <ul className="day-list" aria-label="Days with entries">
            {days.map((day) => (
              <li className="day-row" key={day.date}>
                <div className="day-main">
                  <strong>{formatDayLabel(day.date, today)}</strong>
                  <span className="muted small">
                    {day.date} · {day.entryCount} {day.entryCount === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="day-values">
                  <span>
                    {day.proteinG === null ? "protein not known" : `${formatNumber(day.proteinG)} g protein`}
                  </span>
                  <span>{day.energyKcal === null ? "energy not known" : `${formatNumber(day.energyKcal)} kcal`}</span>
                  {day.partial && <span className="partial-tag">partial</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
