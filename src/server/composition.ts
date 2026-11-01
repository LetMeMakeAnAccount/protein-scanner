import "server-only";
import { foodSchema, nutritionSchema } from "../contracts/schemas";
import type { Food, Nutrition } from "../contracts/types";
import { createImageHandlers } from "./http/image";
import { MuseClient } from "./muse/client";
import { createOffClient } from "./nutrition/off";
import { MemoryQuota } from "./quota/memory";

type OffClient = { lookupBarcode(code: string): Promise<Food[]>; searchFood(query: string): Promise<Food[]>; nutritionForFood(id: string): Promise<Nutrition | null> };
function safeResponse(data: unknown, status = 200) { return Response.json({ ok: true, data }, { status, headers: { "Cache-Control": "no-store" } }); }
function lookupError(status: 400 | 503): Response {
  return Response.json({ ok: false, error: { code: status === 400 ? "invalid_input" : "unavailable", message: status === 400 ? "Invalid input" : "Food lookup unavailable" } }, { status, headers: { "Cache-Control": "no-store" } });
}
export function createLookupHandlers(off: OffClient) {
  async function candidates(foods: Food[]) {
    if (!Array.isArray(foods) || foods.length > 20) throw new Error("Invalid lookup result");
    return Promise.all(foods.map(async (food) => {
      const validated = foodSchema.parse(food);
      if (validated.source.kind !== "off" || !validated.barcode || !/^\d{4,24}$/.test(validated.barcode)) throw new Error("Invalid attribution");
      const result = await off.nutritionForFood(validated.barcode);
      const nutrition = result === null ? null : nutritionSchema.parse(result);
      if (nutrition && (nutrition.source.kind !== "off" || nutrition.source.productId !== validated.source.productId)) throw new Error("Invalid attribution");
      return { food: validated, nutrition };
    }));
  }
  return {
    async lookup(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams, codes = params.getAll("barcode");
      if (codes.length !== 1 || !/^\d{4,24}$/.test(codes[0]) || [...params.keys()].some((k) => k !== "barcode")) return lookupError(400);
      try { return safeResponse(await candidates(await off.lookupBarcode(codes[0]))); } catch { return lookupError(503); }
    },
    async search(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams, queries = params.getAll("q");
      if (queries.length !== 1 || !queries[0].trim() || queries[0].length > 200 || [...params.keys()].some((k) => k !== "q")) return lookupError(400);
      try { return safeResponse(await candidates(await off.searchFood(queries[0].trim()))); } catch { return lookupError(503); }
    },
  };
}
function allowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const values = value.split(",").map((part) => part.trim());
  if (values.some((origin) => {
    try { const url = new URL(origin); return url.origin !== origin || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))); }
    catch { return true; }
  })) return [];
  return values;
}
function validEndpoint(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
function requestCap(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const cap = Number(value);
  return Number.isSafeInteger(cap) && cap <= 1_000_000 ? cap : 0;
}
// One singleton per process/module instance. Restarts and multiple instances
// reset/separate accounting. A cap change requires restart, never a silent reset.
let activeQuota: MemoryQuota | undefined;
let configuredCap: number | undefined;
function quotaFor(enabled: boolean, cap: number): MemoryQuota {
  if (!enabled || cap === 0 || (configuredCap !== undefined && configuredCap !== cap)) return new MemoryQuota({ enabled: false, globalCap: 0 });
  if (!activeQuota) { configuredCap = cap; activeQuota = new MemoryQuota({ enabled: true, globalCap: cap }); }
  return activeQuota;
}
export function createProductionServices(env: NodeJS.ProcessEnv) {
  const key = env.MUSE_API_KEY ?? "", endpoint = env.MUSE_API_URL || "https://api.meta.ai/v1/chat/completions", model = env.MUSE_MODEL || "muse-spark-1.2";
  const cap = requestCap(env.MODEL_MAX_REQUESTS);
  const enabled = env.MODEL_ENABLED === "true" && !!key && !!model && validEndpoint(endpoint) && cap > 0;
  const origins = allowedOrigins(env.ALLOWED_ORIGINS);
  const off = createOffClient();
  return {
    lookup: () => createLookupHandlers(off),
    image: () => createImageHandlers({
      allowedOrigins: origins,
      // Next's Request exposes no authenticated peer. Use one conservative
      // process-wide client bucket; never trust client-supplied forwarding headers.
      resolveClientIdentity: () => "all-clients",
      quota: quotaFor(enabled, cap),
      muse: new MuseClient({ enabled, apiKey: key, endpoint, model }),
    }),
  };
}
