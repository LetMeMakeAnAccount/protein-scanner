"use client";

import React, { useRef, useState } from "react";
import { ApiError, lookupBarcode, searchFoods, type FoodMatch } from "../client/api";
import { formatNumber } from "../client/format";
import { nutritionPer100g } from "../client/history";
import {
  fetchPrices,
  formatObservationPrice,
  observationLocation,
  pricePerLabel,
  proteinPerDollar,
  retailerLinks,
  type PriceObservation,
} from "../client/prices";

const NO_PRICE = "No community price for this item yet.";
const PRICE_ERROR = "Prices are unavailable right now.";

type PriceState = "idle" | "loading" | "ready" | "empty" | "error";
type Busy = "search" | "barcode" | null;

function describeLookupError(error: unknown): string {
  if (error instanceof ApiError && error.code === "rate_limit") {
    return "Too many lookups were made just now. Wait a moment and try again.";
  }
  return "Open Food Facts did not respond. Try again in a moment.";
}

function proteinPerDollarLabel(currency: string): string {
  return currency === "USD" ? "Protein per dollar" : `Protein per ${currency}`;
}

export default function MarketplacePanel() {
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [results, setResults] = useState<FoodMatch[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [observations, setObservations] = useState<PriceObservation[]>([]);
  const [priceState, setPriceState] = useState<PriceState>("idle");
  const lookupRequestRef = useRef(0);
  const priceRequestRef = useRef(0);

  function clearSelection() {
    priceRequestRef.current += 1;
    setSelectedIndex(null);
    setObservations([]);
    setPriceState("idle");
  }

  function beginLookup(kind: Exclude<Busy, null>): number {
    const id = ++lookupRequestRef.current;
    priceRequestRef.current += 1;
    setBusy(kind);
    setError("");
    setResults([]);
    setSelectedIndex(null);
    setObservations([]);
    setPriceState("idle");
    return id;
  }

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (!q) {
      setError("Enter a food name to search.");
      setStatus("");
      return;
    }
    const id = beginLookup("search");
    setStatus("Searching Open Food Facts…");
    try {
      const found = await searchFoods(q);
      if (lookupRequestRef.current !== id) return;
      setResults(found);
      setStatus(
        found.length > 0
          ? `${found.length} ${found.length === 1 ? "food" : "foods"} found. Choose one to see community prices and retailer searches.`
          : "No Open Food Facts match for that name. Try a different search.",
      );
    } catch (lookupError) {
      if (lookupRequestRef.current !== id) return;
      setStatus("");
      setError(describeLookupError(lookupError));
    } finally {
      if (lookupRequestRef.current === id) setBusy(null);
    }
  }

  async function handleBarcode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = barcode.trim();
    if (!code) {
      setError("Enter a barcode to look up.");
      setStatus("");
      return;
    }
    if (!/^\d{4,24}$/.test(code)) {
      setError("Enter a barcode of 4 to 24 digits.");
      setStatus("");
      return;
    }
    const id = beginLookup("barcode");
    setStatus("Looking up this barcode in Open Food Facts…");
    try {
      const found = await lookupBarcode(code);
      if (lookupRequestRef.current !== id) return;
      setResults(found);
      setStatus(
        found.length > 0
          ? "Found a possible Open Food Facts match below. Check the name and values before using it."
          : "No Open Food Facts match for this barcode. Check the number, or search by name.",
      );
    } catch (lookupError) {
      if (lookupRequestRef.current !== id) return;
      setStatus("");
      setError(describeLookupError(lookupError));
    } finally {
      if (lookupRequestRef.current === id) setBusy(null);
    }
  }

  function handleSelect(match: FoodMatch, index: number) {
    if (selectedIndex === index) {
      clearSelection();
      return;
    }
    priceRequestRef.current += 1;
    setSelectedIndex(index);
    setObservations([]);
    setPriceState("idle");

    const code = match.food.barcode?.trim() ?? "";
    if (!code) return;

    const id = priceRequestRef.current;
    setPriceState("loading");
    void fetchPrices(code)
      .then((data) => {
        if (priceRequestRef.current !== id) return;
        setObservations(data.observations);
        setPriceState(data.observations.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (priceRequestRef.current !== id) return;
        setObservations([]);
        setPriceState("error");
      });
  }

  const selected = selectedIndex === null ? null : results[selectedIndex] ?? null;
  const newest = observations[0] ?? null;
  const perDollar = selected && newest ? proteinPerDollar(selected.food, selected.nutrition, newest) : null;
  const selectedHasBarcode = Boolean(selected?.food.barcode?.trim());

  return (
    <section className="card marketplace" aria-labelledby="marketplace-heading">
      <p className="eyebrow">Browse, don't buy</p>
      <h2 id="marketplace-heading">Marketplace</h2>
      <p className="lede market-lede">
        Find a packaged food, see what people have paid, and open a retailer's search. We sell nothing and hold no
        stock.
      </p>
      <p className="muted small market-principle">
        Community prices are past reports from shoppers, not live shelf prices. Each retailer link opens that
        retailer's own search.
      </p>

      <div className="market-forms">
        <form className="search-form" onSubmit={handleSearch}>
          <div className="field">
            <label htmlFor="market-search">Search Open Food Facts</label>
            <input
              id="market-search"
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
            <label htmlFor="market-barcode">Barcode</label>
            <input
              id="market-barcode"
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
      </div>

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

      {results.length === 0 && !status && !error && (
        <p className="market-start-hint">
          Start with a name or barcode. Choose a result to see community prices and open a retailer search.
        </p>
      )}

      {results.length > 0 && (
        <div className="market-results">
          <div className="market-results-head">
            <h3>Results</h3>
            <span className="market-count">
              {results.length} {results.length === 1 ? "item" : "items"}
            </span>
          </div>

          <ul className="market-list">
            {results.map((match, index) => {
              const values = nutritionPer100g(match.food, match.nutrition);
              const isSelected = selectedIndex === index;
              const detailId = `market-detail-${index}`;
              const itemPerDollar = isSelected && newest ? proteinPerDollar(match.food, match.nutrition, newest) : null;
              return (
                <li className={`market-card${isSelected ? " is-selected" : ""}`} key={`${match.food.id ?? match.food.name}-${index}`}>
                  <div className="market-card-head">
                    <div className="market-card-main">
                      <h3 className="market-name">{match.food.name}</h3>
                      <p className="market-source">
                        {match.food.source.label}
                        {match.food.barcode ? ` · ${match.food.barcode}` : " · No barcode"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="button button-quiet market-select"
                      aria-label={`View community prices for ${match.food.name}`}
                      aria-expanded={isSelected}
                      aria-controls={isSelected ? detailId : undefined}
                      onClick={() => handleSelect(match, index)}
                    >
                      {isSelected ? "Hide prices" : "View prices"}
                    </button>
                  </div>

                  <div className="market-facts">
                    <div className="market-fact">
                      <span className="market-fact-label">Protein</span>
                      <span className="market-fact-value">
                        {values.proteinG === null ? "Not listed" : `${formatNumber(values.proteinG)} g protein per 100 g`}
                      </span>
                    </div>
                    <div className="market-fact">
                      <span className="market-fact-label">Energy</span>
                      <span className="market-fact-value">
                        {values.energyKcal === null ? "Not listed" : `${formatNumber(values.energyKcal)} kcal per 100 g`}
                      </span>
                    </div>
                    {itemPerDollar && (
                      <div className="market-fact market-fact-price">
                        <span className="market-fact-label">{proteinPerDollarLabel(itemPerDollar.currency)}</span>
                        <span className="market-fact-value market-fact-highlight">
                          {formatNumber(itemPerDollar.value)} g/{itemPerDollar.currency}
                        </span>
                        <span className="market-fact-note">Newest observation only</span>
                      </div>
                    )}
                  </div>

                  {isSelected && (
                    <div className="market-detail" id={detailId}>
                      <div className="market-price-block">
                        <h4 className="market-detail-title">Community price observations (Open Prices)</h4>

                        {!selectedHasBarcode ? (
                          <p className="market-price-note">
                            This item has no barcode, so community prices can't be looked up. Use a retailer search by
                            name instead.
                          </p>
                        ) : priceState === "loading" ? (
                          <p role="status" aria-live="polite" className="market-price-note">
                            Loading community prices…
                          </p>
                        ) : priceState === "error" ? (
                          <p role="alert" className="market-price-error">
                            {PRICE_ERROR}
                          </p>
                        ) : priceState === "empty" ? (
                          <p role="status" aria-live="polite" className="market-price-note">
                            {NO_PRICE}
                          </p>
                        ) : priceState === "ready" ? (
                          <>
                            <ul className="price-list" aria-label={`Community prices for ${match.food.name}`}>
                              {observations.map((observation, observationIndex) => {
                                const location = observationLocation(observation);
                                const per = pricePerLabel(observation.pricePer);
                                return (
                                  <li className="price-row" key={`${observation.store ?? "store"}-${observation.date ?? "date"}-${observation.price}-${observationIndex}`}>
                                    <div className="price-row-main">
                                      <p className="price-amount">{formatObservationPrice(observation)}</p>
                                      <p className="price-meta">
                                        <span>{observation.store?.trim() || "Store unknown"}</span>
                                        {location && <span>{location}</span>}
                                        <span>{observation.date ? `Observed ${observation.date}` : "Date unknown"}</span>
                                        {per && <span>{per}</span>}
                                      </p>
                                    </div>
                                    {observation.discounted && <span className="market-chip">Discounted</span>}
                                  </li>
                                );
                              })}
                            </ul>
                            {!perDollar && (
                              <p className="market-price-note">
                                We can't work out protein per dollar without a known package weight and price basis, so
                                it is not shown.
                              </p>
                            )}
                            <p className="market-credit">
                              Community prices from{" "}
                              <a href="https://openprices.org" target="_blank" rel="noopener noreferrer">
                                Open Prices
                              </a>
                              , shared under the{" "}
                              <a
                                href="https://opendatacommons.org/licenses/odbl/1-0/"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Open Database License (ODbL)
                              </a>
                              .
                            </p>
                          </>
                        ) : null}
                      </div>

                      <div className="market-retailers">
                        <h4 className="market-detail-title">Search a retailer</h4>
                        <p className="muted small market-retailer-note">
                          Opens the retailer's search. Prices there are not ours.
                        </p>
                        <div className="action-row market-link-row">
                          {retailerLinks(match.food).map((retailer) => (
                            <a
                              key={retailer.name}
                              className="button button-quiet retailer-link"
                              href={retailer.href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Search {retailer.name}
                            </a>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
