import "server-only";
import { randomUUID } from "node:crypto";
import { parseCandidate } from "../../contracts/schemas";
import type { Candidate, ImageInput } from "../../contracts/types";
import { MAX_IMAGE_BYTES, sanitizeImage } from "../image";
import { ModelRequestError, type ModelFailureKind } from "../muse/client";
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
  enrich?: (candidate: Candidate) => Promise<Candidate>;
};
class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = () => new RouteError(400, "invalid_input", "Invalid input");
const unavailable = () =>
  new RouteError(
    503,
    "unavailable",
    "Image analysis unavailable; retry or use manual entry",
  );
const cancelled = () => new RouteError(400, "cancelled", "Request cancelled");
const providerFailures: Record<ModelFailureKind, { code: string; message: string }> = {
  auth: { code: "ai_auth_failed", message: "The AI provider rejected the API key" },
  billing: { code: "ai_billing", message: "The AI provider reports no billing or credits" },
  forbidden: { code: "ai_forbidden", message: "The AI provider refused the request (region or key restriction)" },
  model_missing: { code: "ai_model_missing", message: "The configured AI model was not found" },
  rate_limited: { code: "ai_rate_limited", message: "The AI provider is rate-limiting this key" },
  timeout: { code: "ai_timeout", message: "The AI provider took too long" },
  bad_request: { code: "ai_bad_request", message: "The AI provider rejected the request parameters" },
  provider_error: { code: "ai_provider_error", message: "The AI provider failed to answer" },
  truncated: { code: "ai_truncated", message: "The AI reply was cut off before it finished" },
};
// Provider failures are reduced to fixed, safe messages; provider text and keys never escape.
function classify(error: unknown): RouteError {
  if (error instanceof RouteError) return error;
  if (error instanceof ModelRequestError) {
    const failure = providerFailures[error.kind];
    if (failure) return new RouteError(503, failure.code, failure.message);
  }
  return unavailable();
}
function errorResponse(error: unknown): Response {
  const failure = classify(error);
  return Response.json(
    { ok: false, error: { code: failure.code, message: failure.message } },
    { status: failure.status, headers: { "Cache-Control": "no-store" } },
  );
}

export function imageUnavailableResponse(): Response {
  return errorResponse(unavailable());
}

function assertActive(request: Request) {
  if (request.signal.aborted) throw cancelled();
}
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
// One host[:port], never a comma list, whitespace, path, or userinfo.
const HOST_HEADER = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
function canonicalOrigin(value: string, exact = false): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (exact && url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function protocolFor(host: string, forwarded: string | null): string | null {
  if (forwarded !== null) {
    if (forwarded === "http" || forwarded === "https") return `${forwarded}:`;
    return null;
  }
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return LOOPBACK_HOSTNAMES.has(hostname) ? "http:" : "https:";
  } catch {
    return null;
  }
}

function requestUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Origins this request may legitimately have been sent from. Candidate sources are
// the URL Next reconstructed and the proxy host headers; each is validated and
// canonicalized independently, so a malformed header cannot widen the set.
function requestOrigins(request: Request): Set<string> {
  const origins = new Set<string>();

  const parsed = requestUrl(request.url);
  if (parsed) origins.add(parsed.origin);

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const hostHeaders = [
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  ];
  for (const host of hostHeaders) {
    if (!host || !HOST_HEADER.test(host)) continue;
    const protocol = protocolFor(host, forwardedProto);
    if (!protocol) continue;
    const candidate = canonicalOrigin(`${protocol}//${host}`);
    if (candidate) origins.add(candidate);
  }
  return origins;
}

function originCheck(request: Request, allowed: readonly string[]) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null" || !canonicalOrigin(origin, true)) {
    throw new RouteError(403, "forbidden", "Origin not allowed");
  }
  // Explicit configuration wins; same-origin acceptance needs no configuration.
  if (allowed.includes(origin)) return;
  if (requestOrigins(request).has(origin)) return;
  throw new RouteError(403, "forbidden", "Origin not allowed");
}
async function readBounded(request: Request): Promise<Uint8Array> {
  assertActive(request);

  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw invalid();
    if (Number(length) > MAX_BODY_BYTES) {
      throw new RouteError(413, "body_too_large", "Request body too large");
    }
  }

  if (!request.body) throw invalid();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });

  try {
    assertActive(request);
    while (true) {
      const { done, value } = await reader.read();
      assertActive(request);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new RouteError(413, "body_too_large", "Request body too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw invalid();
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const MULTIPART_IMAGE_TYPE =
  /^multipart\/form-data\s*;\s*boundary=(?:[A-Za-z0-9'()+_,.\/:=?-]{1,70}|"[A-Za-z0-9'()+_,.\/:=?-]{1,70}")\s*$/i;

function imageContentType(request: Request): string {
  const type = request.headers.get("content-type") ?? "";
  if (!MULTIPART_IMAGE_TYPE.test(type)) {
    throw new RouteError(415, "unsupported_media_type", "Expected multipart image");
  }
  return type;
}

async function formFromBytes(
  bytes: Uint8Array,
  contentType: string,
): Promise<FormData> {
  try {
    const body = new Blob([Uint8Array.from(bytes).buffer]);
    return await new Response(body, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw invalid();
  }
}

function imageFileFrom(form: FormData): Blob {
  for (const [key] of form.entries()) {
    if (key !== "image" || form.getAll(key).length !== 1) throw invalid();
  }
  const file = form.get("image");
  if (!(file instanceof Blob)) throw invalid();
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw invalid();
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw invalid();
  return file;
}

async function parseImage(request: Request): Promise<ImageInput> {
  const contentType = imageContentType(request);
  const bytes = await readBounded(request);
  const form = await formFromBytes(bytes, contentType);
  const file = imageFileFrom(form);
  assertActive(request);
  const imageBytes = new Uint8Array(await file.arrayBuffer());
  return { bytes: imageBytes, mediaType: file.type };
}
async function sanitizeForModel(
  input: ImageInput,
  sanitize: ImageHandlerDependencies["sanitize"],
): Promise<ImageInput> {
  try {
    const image = await (sanitize ?? sanitizeImage)(input);
    if (image.mediaType !== "image/jpeg") throw invalid();
    if (!(image.bytes instanceof Uint8Array)) throw invalid();
    if (!image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES) throw invalid();
    return image;
  } catch {
    throw invalid();
  }
}

export function createImageHandlers(deps: ImageHandlerDependencies) {
  return {
    async analyze(request: Request): Promise<Response> {
      try {
        originCheck(request, deps.allowedOrigins);

        const input = await parseImage(request);
        assertActive(request);

        if (!deps.resolveClientIdentity) throw unavailable();
        let clientKey: string | null;
        try {
          clientKey = await deps.resolveClientIdentity(request);
        } catch {
          throw unavailable();
        }
        if (
          typeof clientKey !== "string" ||
          !clientKey.trim() ||
          clientKey.length > 512
        ) {
          throw unavailable();
        }
        assertActive(request);

        const outcome = await withQuotaLease(
          deps.quota,
          { kind: "model", clientKey, requestId: randomUUID() },
          async (quotaContext) => {
            const controller = new AbortController();
            const abort = () => controller.abort();
            const releaseAbortWiring = () => {
              quotaContext.signal.removeEventListener("abort", abort);
              request.signal.removeEventListener("abort", abort);
            };

            quotaContext.signal.addEventListener("abort", abort, { once: true });
            request.signal.addEventListener("abort", abort, { once: true });
            if (quotaContext.signal.aborted || request.signal.aborted) abort();

            const context: QuotaActionContext = {
              signal: controller.signal,
              assertActive() {
                quotaContext.assertActive();
                assertActive(request);
                controller.signal.throwIfAborted();
              },
            };

            try {
              context.assertActive();
              const image = await sanitizeForModel(input, deps.sanitize);
              context.assertActive();
              const candidate = parseCandidate(
                await deps.muse.analyze(image, context),
              );
              context.assertActive();

              let enriched = candidate;
              if (deps.enrich) {
                try {
                  enriched = await deps.enrich(candidate);
                } catch {
                  // Enrichment is best effort; a failed lookup must not fail the scan.
                  enriched = candidate;
                }
              }
              context.assertActive();
              return enriched;
            } finally {
              releaseAbortWiring();
            }
          },
        );

        if (!outcome.allowed) {
          if (outcome.reason === "rate_limit") {
            throw new RouteError(429, "rate_limit", "Request rate limit reached");
          }
          if (outcome.reason === "concurrency") {
            throw new RouteError(
              429,
              "concurrency_limit",
              "Too many scans are in progress; retry shortly",
            );
          }
          throw unavailable();
        }
        assertActive(request);

        const body = JSON.stringify({
          ok: true,
          data: { candidate: outcome.value },
        });
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw unavailable();
        return new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
