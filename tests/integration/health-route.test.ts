import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { GET } from "../../src/app/api/health/route";

const ENV_KEYS = ["MODEL_ENABLED", "MUSE_API_KEY", "MODEL_MAX_REQUESTS", "MUSE_API_URL", "MUSE_MODEL", "ALLOWED_ORIGINS"] as const;

type HealthBody = {
  ok: true;
  data: {
    model: { enabled: boolean; reasons: string[]; keyPresent: boolean; enabledFlag: boolean; cap: number; model: string; endpointHost: string };
    origins: { configured: boolean };
  };
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("answers 200 with no-store and a complete report even when nothing is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as HealthBody;
    expect(body).toEqual({
      ok: true,
      data: {
        model: {
          enabled: false,
          // MUSE_API_URL is unset, so the valid default endpoint is in effect
          // and only the other three preconditions fail.
          reasons: [
            "MODEL_ENABLED is not true",
            "MUSE_API_KEY is missing",
            "MODEL_MAX_REQUESTS missing/invalid or 0",
          ],
          keyPresent: false,
          enabledFlag: false,
          cap: 0,
          model: "muse-spark-1.2",
          endpointHost: "api.meta.ai",
        },
        origins: { configured: false },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports enabled and never exposes the configured secret", async () => {
    process.env.MODEL_ENABLED = "true";
    process.env.MUSE_API_KEY = "sk-live-route-secret-123";
    process.env.MODEL_MAX_REQUESTS = "4";
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const raw = await response.text();
    expect(raw).not.toContain("sk-live-route-secret-123");
    expect(raw).not.toContain("route-secret");
    const body = JSON.parse(raw) as HealthBody;
    expect(body.data.model.enabled).toBe(true);
    expect(body.data.model.reasons).toEqual([]);
    expect(body.data.model.keyPresent).toBe(true);
    expect(body.data.model.cap).toBe(4);
  });

  it("reports additional origins as configured without disclosing them", async () => {
    process.env.ALLOWED_ORIGINS = "https://app.example,https://staging.example";
    const response = await GET();
    const body = (await response.json()) as HealthBody;
    expect(body.data.origins).toEqual({ configured: true });
    expect(JSON.stringify(body)).not.toContain("app.example");
  });
});
