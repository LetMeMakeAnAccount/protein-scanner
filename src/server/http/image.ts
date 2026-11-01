import "server-only";
import { randomUUID } from "node:crypto";
import { parseCandidate } from "../../contracts/schemas";
import type { Candidate, ImageInput } from "../../contracts/types";
import { MAX_IMAGE_BYTES, sanitizeImage } from "../image";
import { withQuotaLease } from "../quota/memory";
import type { QuotaActionContext, QuotaStore } from "../quota/types";

const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
export type ImageHandlerDependencies = {
  allowedOrigins: readonly string[];
  resolveClientIdentity?: (request: Request) => string | null | Promise<string | null>;
  quota: QuotaStore;
  muse: { analyze(image: ImageInput, context: QuotaActionContext): Promise<Candidate> };
  sanitize?: (image: ImageInput) => Promise<ImageInput>;
};
class RouteError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const invalid = () => new RouteError(400, "invalid_input", "Invalid input");
const unavailable = () => new RouteError(503, "unavailable", "Image analysis unavailable; retry or use manual entry");
const cancelled = () => new RouteError(400, "cancelled", "Request cancelled");
function errorResponse(error: unknown): Response {
  const failure = error instanceof RouteError ? error : unavailable();
  return Response.json({ ok: false, error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
}
export function imageUnavailableResponse(): Response { return errorResponse(unavailable()); }
function assertActive(request: Request) { if (request.signal.aborted) throw cancelled(); }
function originCheck(request: Request, allowed: readonly string[]) {
  const origin = request.headers.get("origin");
  if (!origin || !allowed.includes(origin)) throw new RouteError(403, "forbidden", "Origin not allowed");
  try { const url = new URL(origin); if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error(); }
  catch { throw new RouteError(403, "forbidden", "Origin not allowed"); }
}
async function readBounded(request: Request): Promise<Uint8Array> {
  assertActive(request);
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw invalid();
    if (Number(length) > MAX_BODY_BYTES) throw new RouteError(413, "body_too_large", "Request body too large");
  }
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    assertActive(request);
    while (true) {
      const { done, value } = await reader.read(); assertActive(request);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { void reader.cancel().catch(() => undefined); throw new RouteError(413, "body_too_large", "Request body too large"); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof RouteError) throw error; throw invalid(); }
  finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function parseImage(request: Request): Promise<ImageInput> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=(?:[A-Za-z0-9'()+_,.\/:=?-]{1,70}|"[A-Za-z0-9'()+_,.\/:=?-]{1,70}")\s*$/i.test(type)) throw new RouteError(415, "unsupported_media_type", "Expected multipart image");
  const bytes = await readBounded(request);
  let form: FormData;
  try { form = await new Response(new Blob([Uint8Array.from(bytes).buffer]), { headers: { "content-type": type } }).formData(); }
  catch { throw invalid(); }
  for (const [key] of form.entries()) if (!['image', 'metaConsent'].includes(key) || form.getAll(key).length !== 1) throw invalid();
  if (form.get("metaConsent") !== "true") throw invalid();
  const file = form.get("image");
  if (!(file instanceof Blob) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size || file.size > MAX_IMAGE_BYTES) throw invalid();
  assertActive(request);
  return { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type };
}
export function createImageHandlers(deps: ImageHandlerDependencies) {
  return {
    async analyze(request: Request): Promise<Response> {
      try {
        originCheck(request, deps.allowedOrigins);
        const input = await parseImage(request); assertActive(request);
        if (!deps.resolveClientIdentity) throw unavailable();
        let clientKey: string | null;
        try { clientKey = await deps.resolveClientIdentity(request); } catch { throw unavailable(); }
        if (typeof clientKey !== "string" || !clientKey.trim() || clientKey.length > 512) throw unavailable();
        assertActive(request);
        const outcome = await withQuotaLease(deps.quota, { kind: "model", clientKey, requestId: randomUUID() }, async (quotaContext) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          quotaContext.signal.addEventListener("abort", abort, { once: true }); request.signal.addEventListener("abort", abort, { once: true });
          if (quotaContext.signal.aborted || request.signal.aborted) abort();
          const context: QuotaActionContext = { signal: controller.signal, assertActive() { quotaContext.assertActive(); assertActive(request); controller.signal.throwIfAborted(); } };
          try {
            context.assertActive();
            let image: ImageInput;
            try {
              image = await (deps.sanitize ?? sanitizeImage)(input);
              if (image.mediaType !== "image/jpeg" || !(image.bytes instanceof Uint8Array) || !image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES) throw new Error();
            } catch { throw invalid(); }
            context.assertActive();
            return parseCandidate(await deps.muse.analyze(image, context));
          }
          finally { quotaContext.signal.removeEventListener("abort", abort); request.signal.removeEventListener("abort", abort); }
        });
        if (!outcome.allowed) {
          if (outcome.reason === "rate_limit") throw new RouteError(429, "rate_limit", "Request rate limit reached");
          throw unavailable();
        }
        assertActive(request);
        const body = JSON.stringify({ ok: true, data: { candidate: outcome.value } });
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw unavailable();
        return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (error) { return errorResponse(error); }
    },
  };
}
