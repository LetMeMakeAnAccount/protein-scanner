export type Basis = {
  amount: number;
  unit: "g" | "kg" | "ml" | "l" | "serving" | "package";
  count?: number;
};

export type Source = {
  kind: "off" | "label" | "user" | "fixture";
  label: string;
  url?: string;
  productId?: string;
  visibleText?: string;
};

export type Food = {
  id?: string;
  name: string;
  barcode?: string;
  source: Source;
  packageBasis: Basis | null;
  servingSize: Basis | null;
  servingsPerPackage: number | null;
};

export type Nutrition = {
  proteinG: number | null;
  energyKcal: number | null;
  basis: Basis;
  source: Source;
};

export type Price = {
  amount: number;
  currency: string;
  basis: Basis;
  source: "user" | "label";
  observedAt?: string;
};

/** Net quantity printed on a package, exactly as read (no unit conversion). */
export type PackageSize = {
  amount: number;
  unit: "g" | "kg" | "oz" | "lb" | "ml" | "fl_oz";
  /** Units per pack, e.g. 6 for "6 x 500 mL". */
  count?: number;
};

export type ConfirmedInput = { food: Food; nutrition: Nutrition | null; price: Price | null };
export type Metric = { value: number; unit: string } | { unavailable: string };
export type Calculation = { proteinPerCurrency: Metric; proteinPer100Kcal: Metric };
export type Candidate = {
  item: string | null;
  barcode: string | null;
  price: Price | null;
  labelNutrition: Nutrition | null;
  /** Model output always carries this key, but older candidates omit it. */
  packageSize?: PackageSize | null;
  /** Deterministically derived mass; null for volume units or implausible values. */
  packageSizeGrams?: number | null;
  /** Deterministically derived volume in millilitres; null for mass units. */
  packageSizeMl?: number | null;
  uncertainties: string[];
};
export type ImageInput = { bytes: Uint8Array; mediaType: string };
export type AnalysisResult = { candidate: Candidate };
export type DiaryEntry = { id: string; food: Food; nutrition: Nutrition | null; amount: Basis; date: string };
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
