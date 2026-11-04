"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Basis, Candidate, ConfirmedInput, DiaryEntry, Food, Nutrition, Source } from "../contracts/types";
import { calculate } from "../domain/calculation";
import { EXAMPLE, EXAMPLE_BADGE } from "../client/example";
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
import { describeAnalysisError } from "./analysisError";

type View = "home" | "scanner" | "review" | "results";
type PhysicalUnit = "g" | "kg" | "ml" | "l";

const USER_SOURCE: Source = { kind: "user", label: "Your entry" };
const FIXTURE_SOURCE: Source = { kind: "fixture", label: "Sample data (fixture)" };
const UNITS: PhysicalUnit[] = ["g", "kg", "ml", "l"];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];

type Draft = {
  name: string;
  barcode: string;
  priceAmount: string;
  currency: string;
  priceSource: "user" | "label";
  packageAmount: string;
  packageUnit: PhysicalUnit;
  proteinG: string;
  energyKcal: string;
  basisAmount: string;
  basisUnit: PhysicalUnit;
  provenanceLabel: string;
  provenanceUrl: string;
  foodSource: Source;
  nutritionSource: Source;
  nutritionNote: string;
  uncertainties: string[];
  previewUrl: string | null;
  isExample: boolean;
};

function emptyDraft(): Draft {
  return {
    name: "",
    barcode: "",
    priceAmount: "",
    currency: "USD",
    priceSource: "user",
    packageAmount: "",
    packageUnit: "g",
    proteinG: "",
    energyKcal: "",
    basisAmount: "100",
    basisUnit: "g",
    provenanceLabel: "Your entry",
    provenanceUrl: "",
    foodSource: USER_SOURCE,
    nutritionSource: USER_SOURCE,
    nutritionNote: "",
    uncertainties: [],
    previewUrl: null,
    isExample: false,
  };
}

function isPhysical(unit: Basis["unit"]): unit is PhysicalUnit {
  return (UNITS as string[]).includes(unit);
}

function candidateToDraft(candidate: Candidate, previewUrl: string | null): Draft {
  const draft = emptyDraft();
  draft.name = candidate.item ?? "";
  draft.barcode = candidate.barcode ?? "";
  draft.previewUrl = previewUrl;
  draft.uncertainties = candidate.uncertainties;
  if (candidate.price) {
    draft.priceAmount = String(candidate.price.amount);
    draft.currency = candidate.price.currency;
    draft.priceSource = candidate.price.source;
  }
  if (candidate.labelNutrition) {
    const nutrition = candidate.labelNutrition;
    draft.proteinG = nutrition.proteinG === null ? "" : String(nutrition.proteinG);
    draft.energyKcal = nutrition.energyKcal === null ? "" : String(nutrition.energyKcal);
    if (isPhysical(nutrition.basis.unit)) {
      draft.basisAmount = String(nutrition.basis.amount);
      draft.basisUnit = nutrition.basis.unit;
    }
    draft.nutritionSource = nutrition.source;
    draft.provenanceLabel = "Meta label";
    draft.nutritionNote = "Nutrition below is from label — check it against the package before confirming.";
  } else if (candidate.item || candidate.price) {
    draft.provenanceLabel = "Meta scan — check it";
  }
  return draft;
}

function exampleDraft(): Draft {
  const draft = emptyDraft();
  draft.name = EXAMPLE.name;
  draft.priceAmount = EXAMPLE.priceAmount;
  draft.currency = EXAMPLE.currency;
  draft.packageAmount = EXAMPLE.packageAmount;
  draft.packageUnit = EXAMPLE.packageUnit;
  draft.proteinG = EXAMPLE.proteinG;
  draft.energyKcal = EXAMPLE.energyKcal;
  draft.basisAmount = EXAMPLE.basisAmount;
  draft.basisUnit = EXAMPLE.basisUnit;
  draft.provenanceLabel = "Sample data (fixture)";
  draft.foodSource = FIXTURE_SOURCE;
  draft.nutritionSource = FIXTURE_SOURCE;
  draft.isExample = true;
  return draft;
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function newEntryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `entry-${Date.now()}`;
}

const RETAILERS = [
  { name: "Walmart", url: (q: string) => `https://www.walmart.com/search?q=${q}` },
  { name: "Instacart", url: (q: string) => `https://www.instacart.com/store/s?k=${q}` },
  { name: "Target", url: (q: string) => `https://www.target.com/s?searchTerm=${q}` },
];

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
  const [confirmed, setConfirmed] = useState<ConfirmedInput | null>(null);
  const [confirmedExample, setConfirmedExample] = useState(false);
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

  const handleCandidate = useCallback(
    (candidate: Candidate, previewUrl: string | null) => {
      stopScannerStream();
      openReview(candidateToDraft(candidate, previewUrl));
    },
    [openReview, stopScannerStream],
  );

  const handleUnreadable = useCallback(() => {
    stopScannerStream();
    openReview(emptyDraft(), "Couldn't read the label. Type the item name and what you can see.");
  }, [openReview, stopScannerStream]);

  const handleExitScanner = useCallback(() => {
    stopScannerStream();
    setView("home");
  }, [stopScannerStream]);

  const handleManualFromScanner = useCallback(() => {
    stopScannerStream();
    openReview(emptyDraft());
  }, [openReview, stopScannerStream]);

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
      openReview(candidateToDraft(candidate, previewUrl));
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

  function handleFindNutritionFromResults() {
    setView("review");
    void handleFindNutrition();
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
        foodSource: USER_SOURCE,
        nutritionSource: USER_SOURCE,
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
    const packageAmount = parseNumber(draft.packageAmount);
    const proteinG = parseNumber(draft.proteinG);
    const energyKcal = parseNumber(draft.energyKcal);
    const priceAmount = parseNumber(draft.priceAmount);
    const basisAmount = parseNumber(draft.basisAmount);

    const food: Food = {
      name: draft.name.trim(),
      ...(draft.barcode.trim() ? { barcode: draft.barcode.trim() } : {}),
      source: draft.foodSource,
      packageBasis: packageAmount !== null && packageAmount > 0 ? { amount: packageAmount, unit: draft.packageUnit } : null,
      servingSize: null,
      servingsPerPackage: null,
    };
    const nutrition: Nutrition | null =
      proteinG === null && energyKcal === null
        ? null
        : {
            proteinG,
            energyKcal,
            basis: { amount: basisAmount !== null && basisAmount > 0 ? basisAmount : 100, unit: draft.basisUnit },
            source: draft.nutritionSource,
          };
    const next: ConfirmedInput = {
      food,
      nutrition,
      price:
        priceAmount !== null && priceAmount > 0
          ? { amount: priceAmount, currency: draft.currency, basis: { amount: 1, unit: "package" }, source: draft.priceSource }
          : null,
    };
    setConfirmed(next);
    setConfirmedExample(draft.isExample);
    setDiaryAmount(packageAmount !== null && packageAmount > 0 ? String(packageAmount) : "");
    setDiaryUnit(draft.packageUnit);
    setDiaryNotice("");
    setDiaryError("");
    setView("results");
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
    if (!confirmed) return;
    const amount = parseNumber(diaryAmount);
    if (amount === null || amount <= 0) {
      setDiaryError("Enter how much you are adding, for example the whole package.");
      setDiaryNotice("");
      return;
    }
    if (addToToday({ food: confirmed.food, nutrition: confirmed.nutrition, amount: { amount, unit: diaryUnit } })) {
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

  const calculation = confirmed ? calculate(confirmed) : null;

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Protein Scanner</p>
        <h1>Is this food worth its protein?</h1>
        <p className="lede">
          Scan a packaged food and its shelf price, check the numbers, and compare protein per dollar and per 100
          kcal. Nothing is calculated until you confirm the values.
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
            <button
              type="button"
              className="button action"
              onClick={() => openReview(emptyDraft())}
            >
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
                  onChange={(event) => set("packageAmount", event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="package-unit">Package unit</label>
                <select
                  id="package-unit"
                  value={draft.packageUnit}
                  onChange={(event) => set("packageUnit", event.target.value as PhysicalUnit)}
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
              <p className="muted small">Basis means “per this much”, for example per 100 g. Leave a value blank if it is not on the label.</p>
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

      {view === "results" && confirmed && calculation && (
        <section aria-labelledby="results-heading" className="card" aria-live="polite">
          <h2 id="results-heading">Results</h2>
          {confirmedExample && <p className="badge">{EXAMPLE_BADGE}</p>}
          <div className="metric metric-primary">
            <p className="metric-label">Protein per {confirmed.price?.currency ?? "unit of price"}</p>
            {"value" in calculation.proteinPerCurrency ? (
              <p className="metric-value">{`${formatNumber(calculation.proteinPerCurrency.value)} ${calculation.proteinPerCurrency.unit}`}</p>
            ) : (
              <p className="metric-unavailable">Unavailable: {calculation.proteinPerCurrency.unavailable}</p>
            )}
          </div>
          <div className="metric">
            <p className="metric-label">Protein per 100 kcal</p>
            {"value" in calculation.proteinPer100Kcal ? (
              <p className="metric-value metric-value-small">{`${formatNumber(calculation.proteinPer100Kcal.value)} ${calculation.proteinPer100Kcal.unit}`}</p>
            ) : (
              <p className="metric-unavailable">Unavailable: {calculation.proteinPer100Kcal.unavailable}</p>
            )}
          </div>

          {!confirmed.nutrition && (
            <>
              <p className="muted small">
                No nutrition values are available for this item. Search by name, then check any match before using it.
              </p>
              <div className="action-row">
                <button type="button" className="button" onClick={handleFindNutritionFromResults}>
                  Find nutrition by name
                </button>
              </div>
            </>
          )}

          <h3>What this is based on</h3>
          <ul className="summary">
            <li>Item: {confirmed.food.name}</li>
            <li>
              Price: {confirmed.price ? `${formatNumber(confirmed.price.amount)} ${confirmed.price.currency} for the package` : "not given"}
            </li>
            <li>
              Package: {confirmed.food.packageBasis ? `${formatNumber(confirmed.food.packageBasis.amount)} ${confirmed.food.packageBasis.unit}` : "not given"}
            </li>
            <li>
              Nutrition:{" "}
              {confirmed.nutrition
                ? `${confirmed.nutrition.proteinG === null ? "protein not given" : `${formatNumber(confirmed.nutrition.proteinG)} g protein`}, ${
                    confirmed.nutrition.energyKcal === null ? "energy not given" : `${formatNumber(confirmed.nutrition.energyKcal)} kcal`
                  } per ${confirmed.nutrition.basis.amount} ${confirmed.nutrition.basis.unit} · Source: ${confirmed.nutrition.source.label}`
                : "not given"}
            </li>
          </ul>
          <div className="action-row">
            <button type="button" className="button" onClick={() => setView("review")}>
              Edit
            </button>
            <button type="button" className="button button-quiet" onClick={() => setView("home")}>
              Start again
            </button>
          </div>

          <div className="diary-add">
            <h3>Add to today's diary</h3>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="diary-amount">Amount to add</label>
                <input
                  id="diary-amount"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={diaryAmount}
                  onChange={(event) => setDiaryAmount(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="diary-unit">Amount unit</label>
                <select id="diary-unit" value={diaryUnit} onChange={(event) => setDiaryUnit(event.target.value as PhysicalUnit)}>
                  {UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button type="button" className="button button-primary" onClick={handleAddToDiary}>
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
          </div>

          <div className="retailers">
            <h3>Compare prices elsewhere</h3>
            <p className="muted small">These open a search on the retailer's site. Prices are there, not here — we do not store them.</p>
            <div className="action-row">
              {RETAILERS.map((retailer) => (
                <a
                  key={retailer.name}
                  className="button retailer-link"
                  href={retailer.url(encodeURIComponent(confirmed.food.name))}
                  target="_blank"
                  rel="noreferrer"
                >
                  Search {retailer.name} — prices there, not here
                </a>
              ))}
            </div>
          </div>
        </section>
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
