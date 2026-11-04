import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createImageHandlers } from "../../src/server/http/image";
import { ModelRequestError } from "../../src/server/muse/client";
import { MemoryQuota } from "../../src/server/quota/memory";
import type { ImageInput } from "../../src/contracts/types";
import type { QuotaActionContext } from "../../src/server/quota/types";
import * as composition from "../../src/server/composition";
import { POST as scanRoute } from "../../src/app/api/scan/analyze/route";
vi.mock("server-only", () => ({}));
const origin = "https://scanner.example", candidate = { item: "Food", barcode: null, price: null, labelNutrition: null, uncertainties: [] };
let analyze: ReturnType<typeof vi.fn>, sanitize: ReturnType<typeof vi.fn>, handlers: ReturnType<typeof createImageHandlers>;
function request(bytes = "frame", headers: Record<string, string> = {}, signal?: AbortSignal, extra?: Record<string, string>): Request {
  const form = new FormData();
  for (const [k,v] of Object.entries(extra ?? {})) form.set(k,v);
  form.set("image", new Blob([bytes], { type: "image/jpeg" }), "frame.jpg");
  return new Request(`${origin}/api/scan/analyze`, { method: "POST", headers: { origin, ...headers }, body: form, signal });
}
function postTo(url: string, headers: Record<string, string>): Request {
  const form = new FormData();
  form.set("image", new Blob(["frame"], { type: "image/jpeg" }), "frame.jpg");
  return new Request(url, { method: "POST", headers, body: form });
}
const publicUrl = "https://protein-scanner.netlify.app/api/scan/analyze";
function sameOriginHandlers() {
  return createImageHandlers({ allowedOrigins: [], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
}
beforeEach(() => {
  analyze = vi.fn(async (_image: ImageInput, context: QuotaActionContext) => { context.assertActive(); return candidate; });
  sanitize = vi.fn(async (image: ImageInput) => image);
  handlers = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
});
describe("transient image analysis", () => {
  it("routes POST requests through the composed transient handler", async () => {
    const spy = vi.spyOn(composition, "createProductionServices").mockReturnValue({ image: () => handlers } as unknown as ReturnType<typeof composition.createProductionServices>);
    try { expect((await (await scanRoute(request())).json()).data).toEqual({ candidate }); }
    finally { spy.mockRestore(); }
  });
  it("accepts an image-only request and returns the candidate without proof", async () => {
    const response = await handlers.analyze(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, data: { candidate } });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(analyze).toHaveBeenCalledTimes(1);
  });
  it("rejects missing images, extra fields and duplicate images before processing", async () => {
    const send = (body: FormData) => new Request(`${origin}/api/scan/analyze`, { method: "POST", headers: { origin }, body });
    const duplicate = new FormData();
    duplicate.append("image", new Blob(["frame"], { type: "image/jpeg" }), "first.jpg");
    duplicate.append("image", new Blob(["frame"], { type: "image/jpeg" }), "second.jpg");
    expect((await handlers.analyze(send(new FormData()))).status).toBe(400);
    expect((await handlers.analyze(request("frame", {}, undefined, { unexpected: "value" }))).status).toBe(400);
    expect((await handlers.analyze(send(duplicate))).status).toBe(400);
    expect(analyze).not.toHaveBeenCalled(); expect(sanitize).not.toHaveBeenCalled();
  });
  it("accepts same-origin scans without an ALLOWED_ORIGINS entry", async () => {
    const response = await sameOriginHandlers().analyze(postTo(publicUrl, { origin: "https://protein-scanner.netlify.app" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { candidate } });
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it("accepts the public origin forwarded by a proxy", async () => {
    const deployed = sameOriginHandlers();
    const forwarded = await deployed.analyze(postTo("http://localhost:3000/api/scan/analyze", { origin: "https://protein-scanner.netlify.app", "x-forwarded-host": "protein-scanner.netlify.app", "x-forwarded-proto": "https" }));
    expect(forwarded.status).toBe(200);
    const hostHeader = await deployed.analyze(postTo("http://localhost:3000/api/scan/analyze", { origin: "https://protein-scanner.netlify.app", host: "Protein-Scanner.Netlify.App" }));
    expect(hostHeader.status).toBe(200);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
  it("still rejects attacker, missing and opaque origins", async () => {
    const deployed = sameOriginHandlers();
    expect((await deployed.analyze(postTo(publicUrl, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await deployed.analyze(postTo(publicUrl, {}))).status).toBe(403);
    expect((await deployed.analyze(postTo(publicUrl, { origin: "null", host: "evil.example" }))).status).toBe(403);
    expect(analyze).not.toHaveBeenCalled();
  });
  it("keeps an explicit ALLOWED_ORIGINS entry authoritative", async () => {
    const configured = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
    const response = await configured.analyze(postTo("https://internal.example/api/scan/analyze", { origin }));
    expect(response.status).toBe(200);
    expect((await configured.analyze(postTo("https://internal.example/api/scan/analyze", { origin: "https://evil.example" }))).status).toBe(403);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it("ignores malformed forwarded host and scheme candidates", async () => {
    const deployed = sameOriginHandlers();
    const url = "http://localhost:3000/api/scan/analyze";
    const cases: Record<string, string>[] = [
      { origin: "https://evil.example", "x-forwarded-host": "protein-scanner.netlify.app, evil.example", "x-forwarded-proto": "https" },
      { origin: "https://evil.example", "x-forwarded-host": "evil.example evil.example", "x-forwarded-proto": "https" },
      { origin: "https://evil.example", "x-forwarded-host": "https://evil.example", "x-forwarded-proto": "https" },
      { origin: "https://evil.example", host: "evil.example", "x-forwarded-proto": "https, http" },
      { origin: "https://protein-scanner.netlify.app", host: "protein-scanner.netlify.app", "x-forwarded-proto": "http" },
    ];
    for (const headers of cases) expect((await deployed.analyze(postTo(url, headers))).status).toBe(403);
    expect(analyze).not.toHaveBeenCalled();
  });
  it("rejects disallowed origin and oversized streamed body before decoding", async () => {
    expect((await handlers.analyze(request("frame", { origin: "https://evil.example" }))).status).toBe(403);
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5 * 1024 * 1024 + 128 * 1024)); c.close(); } });
    const oversized = new Request(`${origin}/api/scan/analyze`, { method: "POST", headers: { origin, "content-type": "multipart/form-data; boundary=test", "content-length": "1" }, body: stream, duplex: "half" } as RequestInit);
    expect((await handlers.analyze(oversized)).status).toBe(413); expect(sanitize).not.toHaveBeenCalled();
  });
  it("enforces quota before invoking the provider", async () => {
    const deny = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: false, globalCap: 5 }), muse: { analyze }, sanitize });
    expect((await deny.analyze(request())).status).toBe(503); expect(analyze).not.toHaveBeenCalled(); expect(sanitize).not.toHaveBeenCalled();
  });
  it("returns 429 with a distinct code when the concurrency cap is reached", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    analyze.mockImplementationOnce(async () => { started(); await gate; return candidate; });
    const limited = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5, maxConcurrency: 1, timeoutMs: 5000 }), muse: { analyze }, sanitize });
    const first = limited.analyze(request());
    await entered;
    const denied = await limited.analyze(request());
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ ok: false, error: { code: "concurrency_limit", message: "Too many scans are in progress; retry shortly" } });
    release();
    expect((await first).status).toBe(200);
  });
  it("does not trust arbitrary forwarded identity", async () => {
    const noIdentity = createImageHandlers({ allowedOrigins: [origin], quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
    expect((await noIdentity.analyze(request("frame", { "x-forwarded-for": "forged" }))).status).toBe(503);
    expect(analyze).not.toHaveBeenCalled();
  });
  it("maps provider failures to distinct safe codes with no-store", async () => {
    const cases = [
      ["auth", "ai_auth_failed", "The AI provider rejected the API key"],
      ["billing", "ai_billing", "The AI provider reports no billing or credits"],
      ["forbidden", "ai_forbidden", "The AI provider refused the request (region or key restriction)"],
      ["model_missing", "ai_model_missing", "The configured AI model was not found"],
      ["rate_limited", "ai_rate_limited", "The AI provider is rate-limiting this key"],
      ["timeout", "ai_timeout", "The AI provider took too long"],
      ["bad_request", "ai_bad_request", "The AI provider rejected the request parameters"],
      ["provider_error", "ai_provider_error", "The AI provider failed to answer"],
      ["truncated", "ai_truncated", "The AI reply was cut off before it finished"],
    ] as const;
    for (const [kind, code, message] of cases) {
      const fresh = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
      analyze.mockRejectedValueOnce(new ModelRequestError(kind));
      const response = await fresh.analyze(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: false, error: { code, message } });
    }
  });
  it("returns specific safe codes for parameter, provider and truncation failures", async () => {
    const cases = [
      ["bad_request", "ai_bad_request", "The AI provider rejected the request parameters"],
      ["provider_error", "ai_provider_error", "The AI provider failed to answer"],
      ["truncated", "ai_truncated", "The AI reply was cut off before it finished"],
    ] as const;
    for (const [kind, code, message] of cases) {
      const fresh = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze }, sanitize });
      analyze.mockRejectedValueOnce(new ModelRequestError(kind));
      const response = await fresh.analyze(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = JSON.stringify(await response.json());
      expect(JSON.parse(body)).toEqual({ ok: false, error: { code, message } });
      expect(body).not.toContain("Bearer");
      expect(body).not.toContain("sk-");
      expect(body).not.toContain("provider detail");
    }
  });
  it("hides provider text from generic failures", async () => {
    analyze.mockRejectedValueOnce(new Error("401 invalid key sk-live-topsecret"));
    const response = await handlers.analyze(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"code":"unavailable"');
    expect(body).not.toContain("sk-live-topsecret");
    expect(body).not.toContain("invalid key");
  });
  it("propagates cancellation and never leaks provider errors", async () => {
    const controller = new AbortController();
    analyze.mockImplementation(async (_image, ctx: QuotaActionContext) => { controller.abort(); expect(ctx.signal.aborted).toBe(true); ctx.assertActive(); });
    const response = await handlers.analyze(request("frame", {}, controller.signal));
    expect(response.status).not.toBe(200); expect(JSON.stringify(await response.json())).not.toContain("frame");
  });
  it("sends sanitized metadata-free JPEG for JPEG, PNG and WebP", async () => {
    const actual = createImageHandlers({ allowedOrigins: [origin], resolveClientIdentity: () => "peer", quota: new MemoryQuota({ enabled: true, globalCap: 5 }), muse: { analyze } });
    for (const [format, type] of [["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
      const input = await sharp({ create: { width: 3, height: 3, channels: 3, background: "red" } }).withMetadata({ exif: { IFD0: { Artist: "private" } } }).toFormat(format).toBuffer();
      const form = new FormData(); form.set("image", new Blob([Uint8Array.from(input).buffer], { type }), "image");
      const res = await actual.analyze(new Request(`${origin}/api/scan/analyze`, { method: "POST", headers: { origin }, body: form }));
      expect(res.status).toBe(200);
      const image = analyze.mock.calls.at(-1)![0] as ImageInput;
      expect(image.mediaType).toBe("image/jpeg"); expect((await sharp(image.bytes).metadata()).exif).toBeUndefined();
    }
  });
});
