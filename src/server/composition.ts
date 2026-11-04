import "server-only";
import { foodSchema, nutritionSchema } from "../contracts/schemas";
import type { Food, Nutrition } from "../contracts/types";
import { createImageHandlers } from "./http/image";
import { MuseClient } from "./muse/client";
import { createOffClient } from "./nutrition/off";
import { MemoryQuota } from "./quota/memory";

type OffClient = {
  lookupBarcode(code: string): Promise<Food[]>;
  searchFood(query: string): Promise<Food[]>;
  nutritionForFood(id: string): Promise<Nutrition | null>;
};

function safeResponse(data: unknown, status = 200) {
  return Response.json(
    { ok: true, data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function lookupError(status: 400 | 503): Response {
  const code = status === 400 ? "invalid_input" : "unavailable";
  const message = status === 400 ? "Invalid input" : "Food lookup unavailable";
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function createLookupHandlers(off: OffClient) {
  async function candidates(foods: Food[]) {
    if (!Array.isArray(foods) || foods.length > 20) {
      throw new Error("Invalid lookup result");
    }
    return Promise.all(
      foods.map(async (food) => {
        const validated = foodSchema.parse(food);
        if (
          validated.source.kind !== "off" ||
          !validated.barcode ||
          !/^\d{4,24}$/.test(validated.barcode)
        ) {
          throw new Error("Invalid attribution");
        }
        const result = await off.nutritionForFood(validated.barcode);
        const nutrition = result === null ? null : nutritionSchema.parse(result);
        if (
          nutrition &&
          (nutrition.source.kind !== "off" ||
            nutrition.source.productId !== validated.source.productId)
        ) {
          throw new Error("Invalid attribution");
        }
        return { food: validated, nutrition };
      }),
    );
  }
  return {
    async lookup(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams;
      const codes = params.getAll("barcode");
      if (codes.length !== 1) return lookupError(400);
      const [code] = codes;
      if (
        !/^\d{4,24}$/.test(code) ||
        [...params.keys()].some((key) => key !== "barcode")
      ) {
        return lookupError(400);
      }
      try {
        const foods = await off.lookupBarcode(code);
        return safeResponse(await candidates(foods));
      } catch {
        return lookupError(503);
      }
    },
    async search(request: Request): Promise<Response> {
      const params = new URL(request.url).searchParams;
      const queries = params.getAll("q");
      if (queries.length !== 1) return lookupError(400);
      const [query] = queries;
      const trimmed = query.trim();
      if (
        !trimmed ||
        query.length > 200 ||
        [...params.keys()].some((key) => key !== "q")
      ) {
        return lookupError(400);
      }
      try {
        const foods = await off.searchFood(trimmed);
        return safeResponse(await candidates(foods));
      } catch {
        return lookupError(503);
      }
    },
  };
}
function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function allowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const values = value.split(",").map((part) => part.trim());
  if (values.some((origin) => !isAllowedOrigin(origin))) return [];
  return values;
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
const defaultEndpoint = "https://api.meta.ai/v1/chat/completions";
const defaultModel = "muse-spark-1.2";
const defaultRequestCap = 1000;
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
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > maxRequestCap) return 0;
  return cap;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}
const SHARED_CLIENT_IDENTITY = "shared";
const MAX_CLIENT_IDENTITY_LENGTH = 64;
// One trimmed identity value, or null when it is empty, over-long, or contains
// whitespace/commas (which would make the bucket ambiguous).
function identityValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CLIENT_IDENTITY_LENGTH) return null;
  if (/[\s,]/.test(trimmed)) return null;
  return trimmed;
}
// Only proxy-set headers are trusted: Netlify's connection header, else the
// first X-Forwarded-For entry. Anything else, including a malformed value,
// joins one conservative shared bucket. The raw value is used only as an
// in-memory quota key; it is never logged or persisted.
export function resolveClientIdentity(request: Request): string {
  const direct = identityValue(request.headers.get("x-nf-client-connection-ip"));
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = identityValue(forwarded.split(",", 1)[0]);
    if (first) return first;
  }
  return SHARED_CLIENT_IDENTITY;
}
// Single source of truth for the model settings used by both production
// services and health reporting, so the two cannot drift.
function modelSettings(env: NodeJS.ProcessEnv) {
  const key = apiKey(env.MUSE_API_KEY);
  const endpoint = env.MUSE_API_URL || defaultEndpoint;
  const model = env.MUSE_MODEL || defaultModel;
  const cap = requestCap(env.MODEL_MAX_REQUESTS);
  const flag = enabledFlag(env.MODEL_ENABLED);
  const endpointValid = validEndpoint(endpoint);

  const reasons: string[] = [];
  if (flag.reason) reasons.push(flag.reason);
  if (!key) reasons.push("MUSE_API_KEY is missing");
  if (cap <= 0) reasons.push("MODEL_MAX_REQUESTS must be a positive integer");
  if (!endpointValid) reasons.push("MUSE_API_URL is invalid");

  const enabled = reasons.length === 0;
  return {
    key,
    endpoint,
    model,
    cap,
    enabled,
    enabledFlag: flag.enabled,
    reasons,
    endpointHost: hostOf(endpoint),
  };
}
// One singleton per process/module instance. Restarts and multiple instances
// reset/separate accounting. A cap change requires restart, never a silent reset.
let activeQuota: MemoryQuota | undefined;
let configuredCap: number | undefined;
function quotaFor(enabled: boolean, cap: number): MemoryQuota {
  const capChanged = configuredCap !== undefined && configuredCap !== cap;
  if (!enabled || cap === 0 || capChanged) {
    return new MemoryQuota({ enabled: false, globalCap: 0 });
  }
  if (!activeQuota) {
    configuredCap = cap;
    activeQuota = new MemoryQuota({ enabled: true, globalCap: cap });
  }
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
      resolveClientIdentity,
      quota: quotaFor(enabled, cap),
      muse: new MuseClient({ enabled, apiKey: key, endpoint, model }),
    }),
  };
}
