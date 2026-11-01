import { describe, expect, it, vi } from "vitest";
import { createProductionServices } from "../../src/server/composition";
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
