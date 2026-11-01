import type { AnalysisResult, ApiResponse, Food, Nutrition } from "../contracts/types";

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  let body: ApiResponse<T> | null = null;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    body = null;
  }
  if (body && body.ok) return body.data;
  if (body && !body.ok) throw new ApiError(body.error.code, body.error.message);
  throw new ApiError("unavailable", "That service did not respond properly. Try again, or enter the values yourself.");
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new ApiError("unavailable", "Could not reach the service. Check your connection, or enter the values yourself.");
  }
  return unwrap<T>(response);
}

/** Sends one image for analysis. Only call after the user has given Meta consent. */
export async function analyzeImage(image: Blob): Promise<AnalysisResult> {
  const form = new FormData();
  form.append("image", image, "photo.jpg");
  form.append("metaConsent", "true");
  return request<AnalysisResult>("/api/scan/analyze", { method: "POST", body: form });
}

export type FoodMatch = { food: Food; nutrition: Nutrition | null };

export async function lookupBarcode(barcode: string): Promise<FoodMatch[]> {
  return request<FoodMatch[]>(`/api/foods/lookup?barcode=${encodeURIComponent(barcode)}`);
}

export async function searchFoods(query: string): Promise<FoodMatch[]> {
  return request<FoodMatch[]>(`/api/foods/search?q=${encodeURIComponent(query)}`);
}
