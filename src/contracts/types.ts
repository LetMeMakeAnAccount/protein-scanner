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

export type ConfirmedInput = { food: Food; nutrition: Nutrition | null; price: Price | null };
export type Metric = { value: number; unit: string } | { unavailable: string };
export type Calculation = { proteinPerCurrency: Metric; proteinPer100Kcal: Metric };
export type Candidate = {
  item: string | null;
  barcode: string | null;
  price: Price | null;
  labelNutrition: Nutrition | null;
  uncertainties: string[];
};
export type ImageInput = { bytes: Uint8Array; mediaType: string };
export type ImageConsents = { meta: true };
export type AnalysisResult = { candidate: Candidate };
export type DiaryEntry = { id: string; food: Food; nutrition: Nutrition | null; amount: Basis; date: string };
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
