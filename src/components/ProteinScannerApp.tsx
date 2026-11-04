"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, DiaryEntry } from "../contracts/types";
import { calculate } from "../domain/calculation";
import { EXAMPLE_BADGE } from "../client/example";
import { analyzeImage, lookupBarcode, searchFoods, type FoodMatch } from "../client/api";
import { loadDiary, saveDiary } from "../client/diary";
import {
  loadFavorites,
  saveFavorites,
  toggleFavorite as toggleFavoriteRecord,
  type FoodServing,
  type SavedFood,
} from "../client/favorites";
import { formatNumber } from "../client/format";
import { NO_GOALS, loadGoals, saveGoals, type DailyGoals } from "../client/goals";
import { todayISO } from "../client/history";
import { prepareImageForUpload, UnsupportedPhotoError } from "../client/image";
import DiaryPanel from "./DiaryPanel";
import MarketplacePanel from "./MarketplacePanel";
import ProgressPanel from "./ProgressPanel";
import TabNav, { type AppTab } from "./TabNav";
import ScannerPanel from "./ScannerPanel";
import ResultsPanel from "./ResultsPanel";
import { describeAnalysisError } from "./analysisError";
import {
  CURRENCIES,
  UNITS,
  candidateToDraft,
  draftToInput,
  effectivePackage,
  emptyDraft,
  ensurePackageWeight,
  exampleDraft,
  isPhysical,
  parseNumber,
  type Draft,
  type PhysicalUnit,
} from "./draft";

type View = "home" | "scanner" | "review" | "results";

function newEntryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `entry-${Date.now()}`;
}

const CAMERA_CONSTRAINTS: MediaStreamConstraints = { video: { facingMode: { ideal: "environment" } } };

/** Keeps the camera errors the scanner has always shown, worded for the home screen. */
function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission was denied. You can upload a photo or enter values manually instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device. You can upload a photo or enter values manually instead.";
  }
  return "The camera could not be started. You can upload a photo or enter values manually instead.";
}

export default function ProteinScannerApp() {
  const [tab, setTab] = useState<AppTab>("scan");
  const [view, setView] = useState<View>("home");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [confirmError, setConfirmError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [homeError, setHomeError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [startingCamera, setStartingCamera] = useState(false);
  const [scannerStream, setScannerStream] = useState<MediaStream | null>(null);
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [goals, setGoals] = useState<DailyGoals>({ ...NO_GOALS });
  const [favorites, setFavorites] = useState<SavedFood[]>([]);
  const [diaryAmount, setDiaryAmount] = useState("");
  const [diaryUnit, setDiaryUnit] = useState<PhysicalUnit>("g");
  const [diaryNotice, setDiaryNotice] = useState("");
  const [diaryError, setDiaryError] = useState("");
  const [offMatches, setOffMatches] = useState<FoodMatch[]>([]);
  const [offStatus, setOffStatus] = useState("");
  const [offBackup, setOffBackup] = useState<Draft | null>(null);
  const [offSelected, setOffSelected] = useState(false);
  const offRequestRef = useRef(0);
  const previewObjectUrlRef = useRef<string | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef(0);

  useEffect(() => {
    setEntries(loadDiary());
    setGoals(loadGoals());
    setFavorites(loadFavorites());
  }, []);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      cameraRequestRef.current += 1;
      scannerStreamRef.current?.getTracks().forEach((track) => track.stop());
      scannerStreamRef.current = null;
    };
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const setPackageAmount = (value: string) => {
    setDraft((current) => ({ ...current, packageAmount: value, packageEstimated: false }));
  };

  const setPackageUnit = (value: PhysicalUnit) => {
    setDraft((current) => ({ ...current, packageUnit: value, packageEstimated: false }));
  };

  const stopScannerStream = useCallback(() => {
    const stream = scannerStreamRef.current;
    scannerStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setScannerStream(null);
  }, []);

  /** Requests the camera inside the tap, so iOS keeps the user gesture that allows it. */
  const handleStartCamera = useCallback(async () => {
    setHomeError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setHomeError(
        window.isSecureContext === false
          ? "Camera needs a secure connection (HTTPS). Open this page over HTTPS, upload a photo, or enter values manually."
          : "No camera is available on this device. You can upload a photo or enter values manually.",
      );
      return;
    }
    const requestId = ++cameraRequestRef.current;
    setStartingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      if (cameraRequestRef.current !== requestId) {
        // The user moved on while the permission prompt was open.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (scannerStreamRef.current) {
        scannerStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      scannerStreamRef.current = stream;
      setScannerStream(stream);
      setView("scanner");
    } catch (error) {
      if (cameraRequestRef.current !== requestId) return;
      setHomeError(cameraErrorMessage(error));
    } finally {
      if (cameraRequestRef.current === requestId) setStartingCamera(false);
    }
  }, []);

  function handleTabChange(next: AppTab) {
    if (next !== "scan") {
      // Abandon a pending permission request and release the camera if the scanner is open.
      cameraRequestRef.current += 1;
      setStartingCamera(false);
      if (scannerStreamRef.current) stopScannerStream();
      if (view === "scanner") setView("home");
    }
    setTab(next);
  }

  const runBarcodeLookup = useCallback(async (barcode: string) => {
    const requestId = ++offRequestRef.current;
    setOffStatus("Looking up this barcode in Open Food Facts…");
    try {
      const matches = await lookupBarcode(barcode);
      if (offRequestRef.current !== requestId) return;
      setOffMatches(matches);
      setOffStatus(
        matches.length > 0
          ? "We found a possible Open Food Facts match below. Check it, then use it or reject it — nothing is applied automatically."
          : "No Open Food Facts match for this barcode. You can search by name or enter the label values yourself.",
      );
    } catch {
      if (offRequestRef.current !== requestId) return;
      setOffMatches([]);
      setOffStatus("Open Food Facts did not respond. You can enter the label values yourself.");
    }
  }, []);

  const openReview = useCallback(
    (next: Draft, notice = "") => {
      // Opening review leaves the home screen, so drop any camera request still in flight.
      cameraRequestRef.current += 1;
      setStartingCamera(false);
      stopScannerStream();
      setDraft(next);
      setReviewNotice(notice);
      setOffMatches([]);
      setOffSelected(false);
      setOffBackup(null);
      setOffStatus("");
      setConfirmError("");
      setView("review");
      const barcode = next.barcode.trim();
      if (/^\d{4,24}$/.test(barcode)) void runBarcodeLookup(barcode);
    },
    [runBarcodeLookup, stopScannerStream],
  );

  /** Shows the calculated answer immediately; there is no confirmation gate. */
  const openResults = useCallback(
    (next: Draft) => {
      cameraRequestRef.current += 1;
      setStartingCamera(false);
      stopScannerStream();
      const normalized = ensurePackageWeight(next);
      const packageInfo = effectivePackage(normalized);
      setDraft(normalized);
      setReviewNotice("");
      setOffMatches([]);
      setOffSelected(false);
      setOffBackup(null);
      setOffStatus("");
      setConfirmError("");
      setDiaryAmount(String(packageInfo.amount));
      setDiaryUnit(packageInfo.unit);
      setDiaryNotice("");
      setDiaryError("");
      setView("results");
    },
    [stopScannerStream],
  );

  const handleCandidate = useCallback(
    (candidate: Candidate, previewUrl: string | null) => {
      const next = candidateToDraft(candidate, previewUrl);
      if (candidate.item?.trim()) {
        openResults(next);
        return;
      }
      openReview(next, "Couldn't read an item name. Type the item name and what you can see.");
    },
    [openResults, openReview],
  );

  const handleUnreadable = useCallback(() => {
    openReview(emptyDraft(), "Couldn't read the label. Type the item name and what you can see.");
  }, [openReview]);

  const handleExitScanner = useCallback(() => {
    stopScannerStream();
    setView("home");
  }, [stopScannerStream]);

  const handleManualFromScanner = useCallback(() => {
    openReview(emptyDraft());
  }, [openReview]);

  async function handleUpload(file: File | null) {
    if (!file) return;
    setHomeError("");
    setAnalyzing(true);
    let previewUrl: string | null = null;
    try {
      previewUrl = URL.createObjectURL(file);
      if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = previewUrl;
      const image = await prepareImageForUpload(file);
      const { candidate } = await analyzeImage(image);
      const next = candidateToDraft(candidate, previewUrl);
      if (candidate.item?.trim()) {
        openResults(next);
      } else {
        openReview(next, "Couldn't read an item name. Type the item name and what you can see.");
      }
    } catch (error) {
      // Nothing was sent if the photo could not be decoded and re-encoded.
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        if (previewObjectUrlRef.current === previewUrl) previewObjectUrlRef.current = null;
      }
      setHomeError(
        error instanceof UnsupportedPhotoError
          ? error.message
          : `Photo analysis failed: ${describeAnalysisError(error)} You can enter the values manually below.`,
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleFindNutrition() {
    const query = draft.name.trim();
    if (!query) {
      setOffStatus("Enter an item name first, then search Open Food Facts.");
      return;
    }
    const requestId = ++offRequestRef.current;
    setOffStatus("Searching Open Food Facts…");
    try {
      const matches = await searchFoods(query);
      if (offRequestRef.current !== requestId) return;
      setOffMatches(matches);
      setOffStatus(
        matches.length > 0
          ? "Pick the match that is actually this product. If none fit, reject them and enter the label values yourself."
          : "No Open Food Facts match for that name. Enter the label values yourself.",
      );
    } catch {
      if (offRequestRef.current !== requestId) return;
      setOffMatches([]);
      setOffStatus("Open Food Facts did not respond. You can enter the label values yourself.");
    }
  }

  function applyOffMatch(match: FoodMatch) {
    setOffBackup(draft);
    setOffSelected(true);
    setDraft((current) => {
      const next = { ...current, name: match.food.name, barcode: match.food.barcode ?? current.barcode };
      next.foodSource = match.food.source;
      next.provenanceLabel = match.food.source.label;
      next.provenanceUrl = match.food.source.url ?? "";
      if (match.food.packageBasis && isPhysical(match.food.packageBasis.unit)) {
        next.packageAmount = String(match.food.packageBasis.amount);
        next.packageUnit = match.food.packageBasis.unit;
        next.packageEstimated = false;
      }
      if (match.nutrition) {
        next.proteinG = match.nutrition.proteinG === null ? "" : String(match.nutrition.proteinG);
        next.energyKcal = match.nutrition.energyKcal === null ? "" : String(match.nutrition.energyKcal);
        if (isPhysical(match.nutrition.basis.unit)) {
          next.basisAmount = String(match.nutrition.basis.amount);
          next.basisUnit = match.nutrition.basis.unit;
        }
        next.nutritionSource = match.nutrition.source;
        next.nutritionNote = "";
      } else {
        next.nutritionNote = "Open Food Facts has no nutrition values for this item — enter them from the label.";
      }
      return next;
    });
    setOffStatus("Match applied. Check every value before confirming.");
  }

  function rejectOffMatch() {
    if (offBackup) {
      setDraft(offBackup);
    } else {
      setDraft((current) => ({
        ...current,
        provenanceLabel: "Your entry",
        provenanceUrl: "",
        foodSource: { kind: "user", label: "Your entry" },
        nutritionSource: { kind: "user", label: "Your entry" },
        nutritionNote: "",
      }));
    }
    setOffBackup(null);
    setOffSelected(false);
    setOffMatches([]);
    setOffStatus("Match rejected. The values below are your entry — check them against the package.");
  }

  function handleConfirm() {
    if (!draft.name.trim()) {
      setConfirmError("Enter an item name before confirming.");
      return;
    }
    setConfirmError("");
    openResults(draft);
  }

  function persistEntries(next: DiaryEntry[], failure = "This browser would not save that change."): boolean {
    try {
      saveDiary(next);
      setEntries(next);
      setDiaryError("");
      return true;
    } catch {
      setDiaryError(failure);
      return false;
    }
  }

  function addToToday(item: FoodServing): boolean {
    const entry: DiaryEntry = {
      id: newEntryId(),
      food: item.food,
      nutrition: item.nutrition,
      amount: item.amount,
      date: todayISO(),
    };
    return persistEntries(
      [entry, ...entries],
      "This browser would not save the entry. Your diary may be unavailable or full.",
    );
  }

  function handleAddToDiary() {
    if (!draft.name.trim()) {
      setDiaryError("Enter an item name first.");
      setDiaryNotice("");
      return;
    }
    const amount = parseNumber(diaryAmount);
    if (amount === null || amount <= 0) {
      setDiaryError("Enter how much you are adding, for example the whole package.");
      setDiaryNotice("");
      return;
    }
    const input = draftToInput(draft);
    if (addToToday({ food: input.food, nutrition: input.nutrition, amount: { amount, unit: diaryUnit } })) {
      setDiaryNotice("Added to today's diary.");
    } else {
      setDiaryNotice("");
    }
  }

  function saveGoalSettings(next: DailyGoals): boolean {
    try {
      saveGoals(next);
      setGoals(next);
      return true;
    } catch {
      return false;
    }
  }

  function saveFavoriteToggle(item: FoodServing): boolean {
    const next = toggleFavoriteRecord(favorites, item);
    try {
      saveFavorites(next);
      setFavorites(next);
      return true;
    } catch {
      return false;
    }
  }

  const resultInput = draftToInput(draft);
  const calculation = calculate(resultInput);

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Protein Scanner</p>
        <h1>Is this food worth its protein?</h1>
        <p className="lede">
          Scan a packaged food and its shelf price to see protein per dollar and per 100 kcal right away. Edit any value
          and the numbers update.
        </p>
      </header>

      <TabNav active={tab} onChange={handleTabChange} />

      {tab === "scan" && (
        <div role="tabpanel" id="panel-scan" aria-labelledby="tab-scan" className="tab-panel">
          {view === "home" && (
            <section aria-labelledby="start-heading" className="card">
              <h2 id="start-heading">Start</h2>
              {homeError && (
                <p role="alert" className="alert">
                  {homeError}
                </p>
              )}
              {analyzing && (
                <p role="status" aria-live="polite" className="muted">
                  Sending photo for analysis…
                </p>
              )}
              {startingCamera && (
                <p role="status" aria-live="polite" className="muted">
                  Starting camera…
                </p>
              )}
              <div className="actions">
                <button
                  type="button"
                  className="button button-primary action"
                  onClick={() => void handleStartCamera()}
                  disabled={startingCamera}
                >
                  Scan with camera
                </button>
                <label className="button action" htmlFor="photo-upload">
                  Upload photo
                </label>
                <input
                  id="photo-upload"
                  className="visually-hidden"
                  type="file"
                  accept="image/*"
                  aria-label="Upload photo"
                  onChange={(event) => {
                    void handleUpload(event.target.files?.[0] ?? null);
                    event.target.value = "";
                  }}
                />
                <button type="button" className="button action" onClick={() => openReview(emptyDraft())}>
                  Enter manually
                </button>
                <button type="button" className="button action" onClick={() => openReview(exampleDraft())}>
                  Try example
                </button>
              </div>
              <p className="muted small">Photos are analyzed by Meta's AI and are not kept by this app.</p>
            </section>
          )}

          {view === "scanner" && scannerStream && (
            <ScannerPanel
              stream={scannerStream}
              onCandidate={handleCandidate}
              onExit={handleExitScanner}
              onManual={handleManualFromScanner}
              onUnreadable={handleUnreadable}
            />
          )}

          {view === "review" && (
            <section aria-labelledby="review-heading" className="card">
              <h2 id="review-heading">Check the details</h2>
              {draft.isExample && <p className="badge">{EXAMPLE_BADGE}</p>}
              {reviewNotice && (
                <p role="status" className="warning-text">
                  {reviewNotice}
                </p>
              )}
              {draft.name.trim() && <h3 className="review-item">{draft.name.trim()}</h3>}
              <p className="muted">
                Source:{" "}
                {draft.provenanceUrl ? (
                  <a href={draft.provenanceUrl} target="_blank" rel="noreferrer">
                    Open Food Facts
                  </a>
                ) : (
                  draft.provenanceLabel
                )}
                . Correct anything that is wrong — nothing is confirmed yet.
              </p>
              {draft.previewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="preview" src={draft.previewUrl} alt="Selected food photo" />
              )}
              {draft.uncertainties.length > 0 && (
                <div className="warning" role="note">
                  <strong>Check these:</strong>
                  <ul>
                    {draft.uncertainties.map((uncertainty) => (
                      <li key={uncertainty}>{uncertainty}</li>
                    ))}
                  </ul>
                </div>
              )}
              {draft.nutritionNote && <p className="warning-text">{draft.nutritionNote}</p>}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  handleConfirm();
                }}
              >
                <div className="field">
                  <label htmlFor="item-name">Item name</label>
                  <input
                    id="item-name"
                    type="text"
                    value={draft.name}
                    autoComplete="off"
                    onChange={(event) => set("name", event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="barcode">Barcode (optional)</label>
                  <input
                    id="barcode"
                    type="text"
                    inputMode="numeric"
                    value={draft.barcode}
                    autoComplete="off"
                    onChange={(event) => set("barcode", event.target.value)}
                  />
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="price-amount">Price amount</label>
                    <input
                      id="price-amount"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={draft.priceAmount}
                      onChange={(event) => set("priceAmount", event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="currency">Currency</label>
                    <select id="currency" value={draft.currency} onChange={(event) => set("currency", event.target.value)}>
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
                    <label htmlFor="package-amount">Package amount</label>
                    <input
                      id="package-amount"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={draft.packageAmount}
                      onChange={(event) => setPackageAmount(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="package-unit">Package unit</label>
                    <select
                      id="package-unit"
                      value={draft.packageUnit}
                      onChange={(event) => setPackageUnit(event.target.value as PhysicalUnit)}
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
                  <legend>Nutrition, as printed or from a match</legend>
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="protein-g">Protein (g)</label>
                      <input
                        id="protein-g"
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={draft.proteinG}
                        onChange={(event) => set("proteinG", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="energy-kcal">Energy (kcal)</label>
                      <input
                        id="energy-kcal"
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={draft.energyKcal}
                        onChange={(event) => set("energyKcal", event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="basis-amount">Nutrition basis amount</label>
                      <input
                        id="basis-amount"
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        value={draft.basisAmount}
                        onChange={(event) => set("basisAmount", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="basis-unit">Nutrition basis unit</label>
                      <select
                        id="basis-unit"
                        value={draft.basisUnit}
                        onChange={(event) => set("basisUnit", event.target.value as PhysicalUnit)}
                      >
                        {UNITS.map((unit) => (
                          <option key={unit} value={unit}>
                            {unit}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="muted small">
                    Basis means “per this much”, for example per 100 g. Leave a value blank if it is not on the label.
                  </p>
                  <div className="action-row">
                    <button type="button" className="button" onClick={() => void handleFindNutrition()}>
                      Find nutrition
                    </button>
                    {(offSelected || offMatches.length > 0) && (
                      <button type="button" className="button button-quiet" onClick={rejectOffMatch}>
                        Reject match
                      </button>
                    )}
                  </div>
                  {offStatus && (
                    <p role="status" aria-live="polite" className="muted">
                      {offStatus}
                    </p>
                  )}
                  {offMatches.length > 0 && (
                    <ul className="match-list">
                      {offMatches.map((match) => (
                        <li key={match.food.id ?? match.food.name} className="match">
                          <div>
                            <strong>{match.food.name}</strong>
                            <span className="muted">
                              {match.nutrition
                                ? ` ${match.nutrition.proteinG === null ? "protein not listed" : `${formatNumber(match.nutrition.proteinG)} g protein`}, ${
                                    match.nutrition.energyKcal === null ? "energy not listed" : `${formatNumber(match.nutrition.energyKcal)} kcal`
                                  } per ${match.nutrition.basis.amount} ${match.nutrition.basis.unit}`
                                : " No nutrition values listed"}
                            </span>
                          </div>
                          <button type="button" className="button" onClick={() => applyOffMatch(match)}>
                            Use this match
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>

                {confirmError && (
                  <p role="alert" className="alert">
                    {confirmError}
                  </p>
                )}
                <div className="action-row">
                  <button type="submit" className="button button-primary">
                    Confirm and see results
                  </button>
                  <button type="button" className="button button-quiet" onClick={() => setView("home")}>
                    Back to start
                  </button>
                </div>
              </form>
            </section>
          )}

          {view === "results" && (
            <ResultsPanel
              draft={draft}
              input={resultInput}
              calculation={calculation}
              diaryAmount={diaryAmount}
              diaryUnit={diaryUnit}
              diaryNotice={diaryNotice}
              diaryError={diaryError}
              onField={set}
              onPackageAmount={setPackageAmount}
              onPackageUnit={setPackageUnit}
              onDiaryAmount={setDiaryAmount}
              onDiaryUnit={setDiaryUnit}
              onAddToDiary={handleAddToDiary}
              onStartAgain={() => setView("home")}
            />
          )}
        </div>
      )}

      {tab === "diary" && (
        <div role="tabpanel" id="panel-diary" aria-labelledby="tab-diary" className="tab-panel">
          <DiaryPanel
            entries={entries}
            goals={goals}
            favorites={favorites}
            onDelete={(id) => persistEntries(entries.filter((entry) => entry.id !== id))}
            onClearAll={() => persistEntries([])}
            onSaveGoals={saveGoalSettings}
            onToggleFavorite={saveFavoriteToggle}
            onAddFood={addToToday}
          />
        </div>
      )}

      {tab === "progress" && (
        <div role="tabpanel" id="panel-progress" aria-labelledby="tab-progress" className="tab-panel">
          <ProgressPanel entries={entries} />
        </div>
      )}

      {tab === "marketplace" && (
        <div role="tabpanel" id="panel-marketplace" aria-labelledby="tab-marketplace" className="tab-panel">
          <MarketplacePanel />
        </div>
      )}

      <footer className="footer">
        <p>
          Nutrition comes from Open Food Facts, the printed label, or your entry — never guessed. Check the package.
          This is a comparison aid, not diet or medical advice.
        </p>
      </footer>
    </main>
  );
}
