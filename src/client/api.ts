import type { AnalysisResult, ApiResponse, Candidate, Food, Nutrition } from "../contracts/types";

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

/**
 * The server sends one candidate. If a response ever carries a list, the first
 * candidate wins silently — there is no chooser to stall the result.
 */
function firstCandidate(value: unknown): Candidate | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value[0] && typeof value[0] === "object" ? (value[0] as Candidate) : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { candidate?: unknown; candidates?: unknown };
  if (record.candidate !== undefined) {
    if (Array.isArray(record.candidate)) return firstCandidate(record.candidate);
    return record.candidate && typeof record.candidate === "object" ? (record.candidate as Candidate) : null;
  }
  if (Array.isArray(record.candidates)) return firstCandidate(record.candidates);
  return null;
}

/** Sends one image for analysis. */
export async function analyzeImage(image: Blob): Promise<AnalysisResult> {
  const form = new FormData();
  form.append("image", image, "photo.jpg");
  const data = await request<unknown>("/api/scan/analyze", { method: "POST", body: form });
  const candidate = firstCandidate(data);
  if (!candidate) {
    throw new ApiError(
      "unavailable",
      "That service did not return a food item. Try again, or enter the values yourself.",
    );
  }
  return { candidate };
}

export type FoodMatch = { food: Food; nutrition: Nutrition | null };

export async function lookupBarcode(barcode: string): Promise<FoodMatch[]> {
  return request<FoodMatch[]>(`/api/foods/lookup?barcode=${encodeURIComponent(barcode)}`);
}

export async function searchFoods(query: string): Promise<FoodMatch[]> {
  return request<FoodMatch[]>(`/api/foods/search?q=${encodeURIComponent(query)}`);
}
