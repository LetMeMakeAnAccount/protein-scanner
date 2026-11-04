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
const defaultEndpoint = "https://api.meta.ai/v1/chat/completions";
const defaultModel = "muse-spark-1.2";
const defaultRequestCap = 200;
const maxRequestCap = 1_000_000;
// An unset/empty MUSE_API_KEY is missing. Keys are trimmed so a stray space
// cannot masquerade as a configured credential.
function apiKey(value: string | undefined): string {
  return (value ?? "").trim();
}
// MUSE_API_KEY is the primary switch: MODEL_ENABLED unset or empty defaults to
// on whenever a key exists. "false" is the documented hard off; any other
// non-empty value (including "TRUE") is invalid rather than guessed at.
function enabledFlag(value: string | undefined): { enabled: boolean; reason?: string } {
  const flag = (value ?? "").trim();
  if (!flag || flag === "true") return { enabled: true };
  if (flag.toLowerCase() === "false") return { enabled: false, reason: "MODEL_ENABLED is false" };
  return { enabled: false, reason: "MODEL_ENABLED must be true, false, or unset" };
}
function requestCap(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (!raw) return defaultRequestCap;
  if (!/^\d+$/.test(raw)) return 0;
  const cap = Number(raw);
  return Number.isSafeInteger(cap) && cap > 0 && cap <= maxRequestCap ? cap : 0;
}
function hostOf(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return ""; }
}
// Single source of truth for the model settings used by both production
// services and health reporting, so the two cannot drift.
function modelSettings(env: NodeJS.ProcessEnv) {
  const key = apiKey(env.MUSE_API_KEY), endpoint = env.MUSE_API_URL || defaultEndpoint, model = env.MUSE_MODEL || defaultModel;
  const cap = requestCap(env.MODEL_MAX_REQUESTS);
  const flag = enabledFlag(env.MODEL_ENABLED);
  const endpointValid = validEndpoint(endpoint);
  const reasons: string[] = [];
  if (flag.reason) reasons.push(flag.reason);
  if (!key) reasons.push("MUSE_API_KEY is missing");
  if (cap <= 0) reasons.push("MODEL_MAX_REQUESTS must be a positive integer");
  if (!endpointValid) reasons.push("MUSE_API_URL is invalid");
  return { key, endpoint, model, cap, enabled: reasons.length === 0, enabledFlag: flag.enabled, reasons, endpointHost: hostOf(endpoint) };
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
export function createHealthHandlers(env: NodeJS.ProcessEnv) {
  return {
    // Reports only non-sensitive configuration state: never the key, its
    // length, a prefix, or a hash; endpointHost is a hostname at most.
    health(): Response {
      const { enabled, reasons, enabledFlag, cap, model, endpointHost, key } = modelSettings(env);
      return safeResponse({
        model: { enabled, reasons, keyPresent: key !== "", enabledFlag, cap, model, endpointHost },
        origins: { configured: allowedOrigins(env.ALLOWED_ORIGINS).length > 0 },
      });
    },
  };
}
export function createProductionServices(env: NodeJS.ProcessEnv) {
  const { key, endpoint, model, cap, enabled } = modelSettings(env);
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
