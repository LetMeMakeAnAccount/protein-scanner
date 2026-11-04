"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, lookupBarcode, searchFoods, type FoodMatch } from "../client/api";
import {
  catalogMatch,
  catalogProteinPer100Kcal,
  catalogProteinPerDollar,
  catalogSavedPrice,
  filterCatalog,
  type CatalogFood,
} from "../client/catalog";
import { formatNumber } from "../client/format";
import {
  MARKET_LIMIT,
  loadMarket,
  marketKey,
  marketValues,
  patchMarketItem,
  removeMarketItem,
  saveMarket,
  upsertMarketItem,
  type MarketItem,
} from "../client/market";
import {
  fetchPrices,
  formatObservationPrice,
  observationLocation,
  pricePerLabel,
  retailerLinks,
  type PriceObservation,
} from "../client/prices";

const DASH = "—";
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];

type PriceState = "loading" | "empty" | "error";
type Busy = "search" | "barcode" | null;

function describeLookupError(error: unknown): string {
  if (error instanceof ApiError && error.code === "rate_limit") {
    return "Too many lookups. Try again shortly.";
  }
  return "Lookup failed.";
}

function positiveInput(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function Cell({
  label,
  column,
  value,
  highlighted = false,
}: {
  label: string;
  column: string;
  value: string;
  highlighted?: boolean;
}) {
  return (
    <div className="market-cell" data-column={column}>
      <span className="market-cell-label">{label}</span>
      <span className={`market-value${value === DASH ? " is-empty" : ""}${highlighted ? " is-ratio" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function MarketHead() {
  return (
    <div className="market-table-head" aria-hidden="true">
      <span>Food</span>
      <span>Price</span>
      <span>Protein</span>
      <span>Kcal</span>
      <span>Protein/$</span>
      <span>Protein/100 kcal</span>
      <span />
    </div>
  );
}

function CatalogHead() {
  return (
    <div className="market-table-head catalog-table-head" aria-hidden="true">
      <span>Food</span>
      <span>Protein</span>
      <span>Kcal</span>
      <span>Protein/100 kcal</span>
      <span>Protein/$</span>
      <span />
    </div>
  );
}

type CatalogRowProps = {
  food: CatalogFood;
  price: { value: number; currency: string } | null;
  onAdd: () => void;
};

function CatalogRow({ food, price, onAdd }: CatalogRowProps) {
  const perKcal = catalogProteinPer100Kcal(food);
  const perDollar = catalogProteinPerDollar(food, price);
  const meta = [food.packageLabel, food.country].filter(Boolean).join(" · ");

  return (
    <li className="market-item catalog-item" onClick={onAdd}>
      <div className="market-grid catalog-grid">
        <div className="market-ident">
          <h3 className="market-name">{food.name}</h3>
          <span className="market-barcode">
            {food.code}
            {meta ? ` · ${meta}` : ""}
          </span>
        </div>
        <Cell label="Protein" column="protein" value={`${formatNumber(food.proteinG)} g`} />
        <Cell label="Kcal" column="kcal" value={`${formatNumber(food.kcal)} kcal`} />
        <Cell
          label="Protein/100 kcal"
          column="per-kcal"
          value={perKcal === null ? DASH : `${formatNumber(perKcal)} g/100 kcal`}
        />
        <Cell
          label="Protein/$"
          column="per-dollar"
          value={perDollar === null ? DASH : `${formatNumber(perDollar)} g/${price?.currency ?? "USD"}`}
          highlighted
        />
        <div className="market-actions" aria-hidden="true">
          <span className="market-action market-action-primary">Add</span>
        </div>
      </div>
      <button
        type="button"
        className="catalog-hit"
        aria-label={`Add ${food.name} to list`}
        onClick={(event) => {
          event.stopPropagation();
          onAdd();
        }}
      />
    </li>
  );
}

type MarketRowProps = {
  item: MarketItem;
  mode: "saved" | "result";
  expanded?: boolean;
  priceState?: PriceState;
  onAdd?: () => void;
  onToggle?: () => void;
  onRemove?: () => void;
  onPatch?: (patch: Partial<Pick<MarketItem, "packageWeightG" | "paidPrice" | "paidCurrency">>) => void;
};

function MarketRow({
  item,
  mode,
  expanded = false,
  priceState,
  onAdd,
  onToggle,
  onRemove,
  onPatch,
}: MarketRowProps) {
  const rowId = useId();
  const [weightInput, setWeightInput] = useState(item.packageWeightG === null ? "" : String(item.packageWeightG));
  const [paidInput, setPaidInput] = useState(item.paidPrice === null ? "" : String(item.paidPrice));
  const values = marketValues(item);
  const name = item.food.name;
  const barcode = item.food.barcode?.trim() ?? "";
  const priceLabel = values.price ? `${formatNumber(values.price.value)} ${values.price.currency}` : DASH;
  const proteinLabel = values.proteinG === null ? DASH : `${formatNumber(values.proteinG)} g`;
  const kcalLabel = values.energyKcal === null ? DASH : `${formatNumber(values.energyKcal)} kcal`;
  const perDollarLabel = values.proteinPerCurrency
    ? `${formatNumber(values.proteinPerCurrency.value)} g/${values.proteinPerCurrency.currency}`
    : DASH;
  const perKcalLabel =
    values.proteinPer100Kcal === null ? DASH : `${formatNumber(values.proteinPer100Kcal)} g/100 kcal`;
  const currencyOptions = CURRENCIES.includes(item.paidCurrency)
    ? CURRENCIES
    : [item.paidCurrency, ...CURRENCIES];
  const detailId = `${rowId}-detail`;

  return (
    <li className={`market-item${expanded ? " is-open" : ""}`}>
      <div className="market-grid">
        <div className="market-ident">
          <h3 className="market-name">{name}</h3>
          {barcode && <span className="market-barcode">{barcode}</span>}
        </div>

        <Cell label="Price" column="price" value={priceLabel} />
        <Cell label="Protein" column="protein" value={proteinLabel} />
        <Cell label="Kcal" column="kcal" value={kcalLabel} />
        <Cell label="Protein/$" column="per-dollar" value={perDollarLabel} highlighted />
        <Cell label="Protein/100 kcal" column="per-kcal" value={perKcalLabel} />

        <div className="market-actions">
          {mode === "saved" ? (
            <>
              <button
                type="button"
                className="market-action"
                aria-expanded={expanded}
                aria-controls={expanded ? detailId : undefined}
                onClick={onToggle}
              >
                {expanded ? "Hide" : "Details"}
              </button>
              <button
                type="button"
                className="market-remove"
                aria-label={`Remove ${name}`}
                onClick={onRemove}
              >
                ×
              </button>
            </>
          ) : (
            <button
              type="button"
              className="market-action market-action-primary"
              aria-label={`Add ${name} to list`}
              onClick={onAdd}
            >
              Add
            </button>
          )}
        </div>
      </div>

      {mode === "saved" && expanded && (
        <div className="market-detail" id={detailId}>
          <div className="market-detail-block">
            <h4 className="market-detail-title">Prices</h4>
            {item.observations.length > 0 ? (
              <ul className="price-list" aria-label={`Prices for ${name}`}>
                {item.observations.map((observation, index) => {
                  const location = observationLocation(observation);
                  const per = pricePerLabel(observation.pricePer);
                  return (
                    <li
                      className="price-row"
                      key={`${observation.store ?? "store"}-${observation.date ?? "date"}-${observation.price}-${index}`}
                    >
                      <div className="price-row-main">
                        <p className="price-amount">{formatObservationPrice(observation)}</p>
                        <p className="price-meta">
                          <span>{observation.store?.trim() || DASH}</span>
                          {location && <span>{location}</span>}
                          <span>{observation.date ?? DASH}</span>
                          {per && <span>{per}</span>}
                        </p>
                      </div>
                      {observation.discounted && <span className="market-chip">Discounted</span>}
                    </li>
                  );
                })}
              </ul>
            ) : priceState === "loading" ? (
              <p className="market-note" role="status" aria-live="polite">
                Loading…
              </p>
            ) : priceState === "error" ? (
              <p className="market-price-error" role="alert">
                Prices unavailable.
              </p>
            ) : (
              <p className="market-dash">{DASH}</p>
            )}
          </div>

          <div className="market-detail-block">
            <h4 className="market-detail-title">Retailers</h4>
            <div className="action-row market-link-row">
              {retailerLinks(item.food).map((retailer) => (
                <a
                  key={retailer.name}
                  className="button button-quiet market-retailer"
                  href={retailer.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Search ${retailer.name}`}
                >
                  {retailer.name}
                </a>
              ))}
            </div>
          </div>

          <div className="market-entry">
            <div className="field">
              <label htmlFor={`${rowId}-weight`}>Package weight (g)</label>
              <input
                id={`${rowId}-weight`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={weightInput}
                onChange={(event) => {
                  setWeightInput(event.target.value);
                  onPatch?.({ packageWeightG: positiveInput(event.target.value) });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${rowId}-paid`}>Price paid</label>
              <input
                id={`${rowId}-paid`}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={paidInput}
                onChange={(event) => {
                  setPaidInput(event.target.value);
                  onPatch?.({ paidPrice: positiveInput(event.target.value) });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${rowId}-currency`}>Currency</label>
              <select
                id={`${rowId}-currency`}
                value={item.paidCurrency}
                onChange={(event) => onPatch?.({ paidCurrency: event.target.value })}
              >
                {currencyOptions.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export default function MarketplacePanel() {
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [results, setResults] = useState<FoodMatch[]>([]);
  const [saved, setSaved] = useState<MarketItem[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [priceStates, setPriceStates] = useState<Record<string, PriceState>>({});
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogLimit, setCatalogLimit] = useState(40);
  const lookupRequestRef = useRef(0);
  const savedRef = useRef<MarketItem[]>([]);

  useEffect(() => {
    const loaded = loadMarket();
    savedRef.current = loaded;
    setSaved(loaded);
  }, []);

  function commitSaved(next: MarketItem[]): void {
    const capped = next.slice(0, MARKET_LIMIT);
    savedRef.current = capped;
    setSaved(capped);
    try {
      saveMarket(capped);
    } catch {
      setError("Could not save the list.");
    }
  }

  async function loadPrices(key: string, barcodeForPrices: string): Promise<void> {
    setPriceStates((current) => ({ ...current, [key]: "loading" }));
    try {
      const data = await fetchPrices(barcodeForPrices);
      if (!savedRef.current.some((item) => item.key === key)) {
        setPriceStates((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }
      commitSaved(savedRef.current.map((item) => (item.key === key ? { ...item, observations: data.observations } : item)));
      setPriceStates((current) => ({ ...current, [key]: "empty" }));
    } catch {
      if (!savedRef.current.some((item) => item.key === key)) return;
      setPriceStates((current) => ({ ...current, [key]: "error" }));
    }
  }

  function beginLookup(kind: Exclude<Busy, null>): number {
    const id = ++lookupRequestRef.current;
    setBusy(kind);
    setError("");
    setStatus("");
    setResults([]);
    return id;
  }

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (!q) {
      setStatus("");
      setError("Enter a food name.");
      return;
    }
    const id = beginLookup("search");
    setStatus("Searching…");
    try {
      const found = await searchFoods(q);
      if (lookupRequestRef.current !== id) return;
      setResults(found);
      setStatus(found.length > 0 ? "" : "No match.");
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
      setStatus("");
      setError("Enter a barcode.");
      return;
    }
    if (!/^\d{4,24}$/.test(code)) {
      setStatus("");
      setError("Barcode must be 4–24 digits.");
      return;
    }
    const id = beginLookup("barcode");
    setStatus("Looking up…");
    try {
      const found = await lookupBarcode(code);
      if (lookupRequestRef.current !== id) return;
      if (found.length === 0) {
        setStatus("No match.");
        return;
      }
      const keys: string[] = [];
      const priceCodes: string[] = [];
      for (const match of found) {
        const { items, item } = upsertMarketItem(savedRef.current, match);
        commitSaved(items);
        keys.push(item.key);
        priceCodes.push(match.food.barcode?.trim() || code);
      }
      setStatus("");
      setExpandedKey(keys[0] ?? null);
      keys.forEach((key, index) => {
        const priceCode = priceCodes[index];
        if (priceCode) void loadPrices(key, priceCode);
      });
    } catch (lookupError) {
      if (lookupRequestRef.current !== id) return;
      setStatus("");
      setError(describeLookupError(lookupError));
    } finally {
      if (lookupRequestRef.current === id) setBusy(null);
    }
  }

  function handleAddResult(match: FoodMatch): void {
    const { items, item } = upsertMarketItem(savedRef.current, match);
    commitSaved(items);
    setResults((current) => current.filter((result) => marketKey(result.food) !== item.key));
    setExpandedKey(item.key);
    const priceCode = item.food.barcode?.trim() ?? "";
    if (priceCode && item.observations.length === 0 && priceStates[item.key] === undefined) {
      void loadPrices(item.key, priceCode);
    }
  }

  function handleAddCatalog(food: CatalogFood): void {
    const match = catalogMatch(food);
    const key = marketKey(match.food);
    const existing = savedRef.current.find((item) => item.key === key);
    const { items } = upsertMarketItem(savedRef.current, match);
    const packageWeightG =
      existing?.packageWeightG ??
      (food.packageGrams !== null && Number.isFinite(food.packageGrams) && food.packageGrams > 0
        ? food.packageGrams
        : null);
    commitSaved(packageWeightG === null ? items : patchMarketItem(items, key, { packageWeightG }));
    setResults((current) => current.filter((result) => marketKey(result.food) !== key));
    setExpandedKey(key);
    setError("");
    setStatus("");
  }

  function handleToggle(key: string): void {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    const item = savedRef.current.find((entry) => entry.key === key);
    setExpandedKey(key);
    const priceCode = item?.food.barcode?.trim() ?? "";
    if (item && priceCode && item.observations.length === 0 && priceStates[key] === undefined) {
      void loadPrices(key, priceCode);
    }
  }

  function handleRemove(key: string): void {
    commitSaved(removeMarketItem(savedRef.current, key));
    if (expandedKey === key) setExpandedKey(null);
    setPriceStates((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function handlePatch(
    key: string,
    patch: Partial<Pick<MarketItem, "packageWeightG" | "paidPrice" | "paidCurrency">>,
  ): void {
    commitSaved(patchMarketItem(savedRef.current, key, patch));
  }

  const savedByKey = new Map(saved.map((item) => [item.key, item]));
  const filteredCatalog = useMemo(() => filterCatalog(catalogQuery), [catalogQuery]);
  const visibleCatalog = filteredCatalog.slice(0, catalogLimit);

  return (
    <section className="card marketplace" aria-labelledby="marketplace-heading">
      <div className="market-head">
        <h2 id="marketplace-heading">Marketplace</h2>
        <p className="market-principle muted small">Community prices, not live shelf prices.</p>
      </div>

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
            Search
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
            Look up
          </button>
        </form>
      </div>

      <p className="market-status muted small" role="status" aria-live="polite">
        {status}
      </p>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}

      <section className="market-section market-catalog" aria-labelledby="market-catalog-heading">
        <div className="market-section-head">
          <h3 id="market-catalog-heading">Browse foods</h3>
          <span className="market-count" aria-label={`${filteredCatalog.length} foods`}>
            {filteredCatalog.length}
          </span>
        </div>
        <div className="field catalog-filter">
          <label htmlFor="market-catalog-filter">Filter foods</label>
          <input
            id="market-catalog-filter"
            type="search"
            value={catalogQuery}
            autoComplete="off"
            placeholder="Filter by name or barcode"
            onChange={(event) => {
              setCatalogQuery(event.target.value);
              setCatalogLimit(40);
            }}
          />
        </div>

        {visibleCatalog.length > 0 ? (
          <>
            <CatalogHead />
            <ul className="market-list" aria-label="Catalog foods">
              {visibleCatalog.map((food) => {
                const key = marketKey({ name: food.name, barcode: food.code });
                return (
                  <CatalogRow
                    key={`${food.code}-${food.name}`}
                    food={food}
                    price={catalogSavedPrice(savedByKey.get(key))}
                    onAdd={() => handleAddCatalog(food)}
                  />
                );
              })}
            </ul>
            <p className="catalog-count muted small">
              Showing {visibleCatalog.length} of {filteredCatalog.length}
            </p>
            {filteredCatalog.length > catalogLimit && (
              <div className="action-row catalog-more">
                <button
                  type="button"
                  className="button"
                  onClick={() => setCatalogLimit((current) => current + 40)}
                >
                  Show more
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="muted small" role="status">
            No foods match that filter.
          </p>
        )}

        <p className="market-credit">Catalog: Open Food Facts (ODbL)</p>
      </section>

      {results.length > 0 && (
        <section className="market-section" aria-labelledby="market-results-heading">
          <div className="market-section-head">
            <h3 id="market-results-heading">Results</h3>
            <span className="market-count" aria-label={`${results.length} results`}>
              {results.length}
            </span>
          </div>
          <MarketHead />
          <ul className="market-list">
            {results.map((match) => {
              const key = marketKey(match.food);
              const savedItem = savedByKey.get(key);
              const preview: MarketItem = {
                key,
                food: match.food,
                nutrition: match.nutrition,
                observations: savedItem?.observations ?? [],
                packageWeightG: null,
                paidPrice: null,
                paidCurrency: savedItem?.paidCurrency ?? "USD",
              };
              return (
                <MarketRow
                  key={key}
                  item={preview}
                  mode="result"
                  onAdd={() => handleAddResult(match)}
                />
              );
            })}
          </ul>
        </section>
      )}

      {saved.length > 0 && (
        <section className="market-section" aria-labelledby="market-saved-heading">
          <div className="market-section-head">
            <h3 id="market-saved-heading">Saved</h3>
            <span className="market-count" aria-label={`${saved.length} saved`}>
              {saved.length}
            </span>
          </div>
          <MarketHead />
          <ul className="market-list">
            {saved.map((item) => (
              <MarketRow
                key={item.key}
                item={item}
                mode="saved"
                expanded={expandedKey === item.key}
                priceState={priceStates[item.key]}
                onToggle={() => handleToggle(item.key)}
                onRemove={() => handleRemove(item.key)}
                onPatch={(patch) => handlePatch(item.key, patch)}
              />
            ))}
          </ul>
        </section>
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
    </section>
  );
}
