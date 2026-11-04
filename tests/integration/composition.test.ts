import { describe, expect, it, vi } from "vitest";
import { createHealthHandlers, createProductionServices } from "../../src/server/composition";
import { calculate } from "../../src/domain/calculation";
import { MuseClient } from "../../src/server/muse/client";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
describe("transient production composition", () => {
  it("remains usable without provider configuration and never selects a fake", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const services = createProductionServices({ NODE_ENV: "test" });
    expect(services.lookup()).toBeTruthy(); expect(services.image()).toBeTruthy();
    expect(calculate({ food: { name: "Oats", source: { kind: "user", label: "Manual" }, packageBasis: { amount: 200, unit: "g" }, servingSize: null, servingsPerPackage: null }, nutrition: { proteinG: 10, energyKcal: 100, basis: { amount: 100, unit: "g" }, source: { kind: "user", label: "Manual" } }, price: { amount: 4, currency: "USD", basis: { amount: 200, unit: "g" }, source: "user" } }).proteinPerCurrency).toEqual({ value: 5, unit: "g/USD" });
    expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
  });
  it("never serializes private credentials", () => {
    const services = createProductionServices({ NODE_ENV: "test", MUSE_API_KEY: "private-test-key", MODEL_ENABLED: "true", MODEL_MAX_REQUESTS: "2" });
    expect(JSON.stringify(services)).not.toContain("private-test-key");
  });
  it("never calls the model when disabled, unkeyed, or lacking a valid cap", async () => {
    const spy = vi.spyOn(MuseClient.prototype, "analyze");
    const request = () => { const form = new FormData(); form.set("image", new Blob(["unused"], { type: "image/jpeg" }), "x.jpg"); return new Request("https://app.example/api/scan/analyze", { method: "POST", headers: { origin: "https://app.example" }, body: form }); };
    const common = { NODE_ENV: "test" as const, ALLOWED_ORIGINS: "https://app.example" };
    try {
      for (const env of [{ ...common, MODEL_ENABLED: "true", MODEL_MAX_REQUESTS: "3" }, { ...common, MODEL_ENABLED: "TRUE", MODEL_MAX_REQUESTS: "3", MUSE_API_KEY: "test" }, { ...common, MODEL_ENABLED: "true", MODEL_MAX_REQUESTS: "invalid", MUSE_API_KEY: "test" }]) {
        expect((await createProductionServices(env).image().analyze(request())).status).toBe(503);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("treats ALLOWED_ORIGINS as optional for same-origin deployments", async () => {
    const services = createProductionServices({ NODE_ENV: "test" });
    const request = (headers: Record<string, string>) => { const form = new FormData(); form.set("image", new Blob(["unused"], { type: "image/jpeg" }), "x.jpg"); return new Request("https://preview-123.netlify.app/api/scan/analyze", { method: "POST", headers, body: form }); };
    expect((await services.image().analyze(request({}))).status).toBe(403);
    expect((await services.image().analyze(request({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await services.image().analyze(request({ origin: "https://preview-123.netlify.app" }))).status).toBe(503);
  });
  it("reports the same effective configuration through health without leaking the key", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MODEL_ENABLED: "true", MUSE_API_KEY: "sk-live-composition-secret", MODEL_MAX_REQUESTS: "7", MUSE_API_URL: "https://models.example/v1/chat" };
    const response = createHealthHandlers(env).health();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain("sk-live-composition-secret");
    expect(JSON.parse(raw)).toEqual({
      ok: true,
      data: {
        model: { enabled: true, reasons: [], keyPresent: true, enabledFlag: true, cap: 7, model: "muse-spark-1.2", endpointHost: "models.example" },
        origins: { configured: false },
      },
    });
  });
  it("enables the model from the API key alone with a safe default cap", async () => {
    const body = await createHealthHandlers({ NODE_ENV: "test", MUSE_API_KEY: "key" }).health().json() as { data: { model: { enabled: boolean; reasons: string[]; keyPresent: boolean; enabledFlag: boolean; cap: number; model: string; endpointHost: string } } };
    expect(body.data.model).toEqual({ enabled: true, reasons: [], keyPresent: true, enabledFlag: true, cap: 200, model: "muse-spark-1.2", endpointHost: "api.meta.ai" });
  });
  it("treats an empty MODEL_ENABLED as on when a key exists and honors an explicit cap", async () => {
    const body = await createHealthHandlers({ NODE_ENV: "test", MUSE_API_KEY: "key", MODEL_ENABLED: "", MODEL_MAX_REQUESTS: "5" }).health().json() as { data: { model: { enabled: boolean; reasons: string[]; keyPresent: boolean; enabledFlag: boolean; cap: number; model: string; endpointHost: string } } };
    expect(body.data.model).toEqual({ enabled: true, reasons: [], keyPresent: true, enabledFlag: true, cap: 5, model: "muse-spark-1.2", endpointHost: "api.meta.ai" });
  });
  it("requires the key even when the flag and cap are valid", async () => {
    const body = await createHealthHandlers({ NODE_ENV: "test", MODEL_ENABLED: "true", MODEL_MAX_REQUESTS: "3" }).health().json() as { data: { model: { enabled: boolean; reasons: string[]; keyPresent: boolean; cap: number } } };
    expect(body.data.model).toMatchObject({ enabled: false, reasons: ["MUSE_API_KEY is missing"], keyPresent: false, cap: 3 });
  });
  it.each([
    [{ MODEL_ENABLED: "false" }, "MODEL_ENABLED is false"],
    [{ MODEL_ENABLED: "FALSE" }, "MODEL_ENABLED is false"],
    [{ MODEL_ENABLED: "TRUE" }, "MODEL_ENABLED must be true, false, or unset"],
    [{ MODEL_ENABLED: "garbage" }, "MODEL_ENABLED must be true, false, or unset"],
    [{ MUSE_API_KEY: "" }, "MUSE_API_KEY is missing"],
    [{ MUSE_API_KEY: "   " }, "MUSE_API_KEY is missing"],
    [{ MUSE_API_KEY: undefined }, "MUSE_API_KEY is missing"],
    [{ MODEL_MAX_REQUESTS: "0" }, "MODEL_MAX_REQUESTS must be a positive integer"],
    [{ MODEL_MAX_REQUESTS: "not-a-number" }, "MODEL_MAX_REQUESTS must be a positive integer"],
    [{ MODEL_MAX_REQUESTS: "-1" }, "MODEL_MAX_REQUESTS must be a positive integer"],
    [{ MODEL_MAX_REQUESTS: "1000001" }, "MODEL_MAX_REQUESTS must be a positive integer"],
    [{ MUSE_API_URL: "http://api.meta.ai/v1/chat/completions" }, "MUSE_API_URL is invalid"],
    [{ MUSE_API_URL: "not a url" }, "MUSE_API_URL is invalid"],
    [{ MUSE_API_URL: "https://user:pass@api.meta.ai/v1" }, "MUSE_API_URL is invalid"],
    [{ MUSE_API_URL: "https://api.meta.ai/v1#fragment" }, "MUSE_API_URL is invalid"],
  ] as const)("explains each failing precondition: %j", async (override, reason) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MODEL_ENABLED: "true", MUSE_API_KEY: "key", MODEL_MAX_REQUESTS: "3", ...override };
    const body = await createHealthHandlers(env).health().json() as { data: { model: { enabled: boolean; reasons: string[] } } };
    expect(body.data.model.enabled).toBe(false);
    expect(body.data.model.reasons).toEqual([reason]);
  });
  it("accepts the maximum allowed cap and rejects a larger one", async () => {
    const atLimit = await createHealthHandlers({ NODE_ENV: "test", MUSE_API_KEY: "key", MODEL_MAX_REQUESTS: "1000000" }).health().json() as { data: { model: { enabled: boolean; cap: number } } };
    expect(atLimit.data.model).toMatchObject({ enabled: true, cap: 1_000_000 });
    const aboveLimit = await createHealthHandlers({ NODE_ENV: "test", MUSE_API_KEY: "key", MODEL_MAX_REQUESTS: "1000001" }).health().json() as { data: { model: { enabled: boolean; cap: number; reasons: string[] } } };
    expect(aboveLimit.data.model).toMatchObject({ enabled: false, cap: 0, reasons: ["MODEL_MAX_REQUESTS must be a positive integer"] });
  });
  it("defaults an unset endpoint and model exactly as createProductionServices does", async () => {
    const body = await createHealthHandlers({ NODE_ENV: "test", MODEL_ENABLED: "true", MUSE_API_KEY: "key", MODEL_MAX_REQUESTS: "1", MUSE_API_URL: "" }).health().json() as { data: { model: { enabled: boolean; model: string; endpointHost: string } } };
    expect(body.data.model).toMatchObject({ enabled: true, model: "muse-spark-1.2", endpointHost: "api.meta.ai" });
  });
  it("does not fall back from a malformed MUSE_API_URL, matching createProductionServices", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MODEL_ENABLED: "true", MUSE_API_KEY: "key", MODEL_MAX_REQUESTS: "1", MUSE_API_URL: "not a url" };
    const body = await createHealthHandlers(env).health().json() as { data: { model: { enabled: boolean; reasons: string[]; endpointHost: string } } };
    expect(body.data.model.enabled).toBe(false);
    expect(body.data.model.reasons).toEqual(["MUSE_API_URL is invalid"]);
    expect(body.data.model.endpointHost).toBe("");
    expect(createProductionServices(env).image()).toBeTruthy();
  });
  it("shares the process cap across independently constructed services and fails closed on config changes", async () => {
    const env = { NODE_ENV: "test" as const, MUSE_API_KEY: "test-key", MODEL_ENABLED: "true", MODEL_MAX_REQUESTS: "2", ALLOWED_ORIGINS: "https://app.example" };
    const spy = vi.spyOn(MuseClient.prototype, "analyze").mockResolvedValue({ item: null, barcode: null, price: null, labelNutrition: null, uncertainties: [] });
    const jpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).jpeg().toBuffer();
    const request = () => { const form = new FormData(); form.set("image", new Blob([Uint8Array.from(jpeg).buffer], { type: "image/jpeg" }), "x.jpg"); return new Request("https://app.example/api/scan/analyze", { method: "POST", headers: { origin: "https://app.example", "x-forwarded-for": crypto.randomUUID() }, body: form }); };
    try {
      expect((await createProductionServices(env).image().analyze(request())).status).toBe(200);
      expect((await createProductionServices(env).image().analyze(request())).status).toBe(200);
      expect((await createProductionServices(env).image().analyze(request())).status).toBe(503);
      expect((await createProductionServices({ ...env, MODEL_ENABLED: "false" }).image().analyze(request())).status).toBe(503);
      expect((await createProductionServices({ ...env, MODEL_MAX_REQUESTS: "3" }).image().analyze(request())).status).toBe(503);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
});
