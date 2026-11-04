/**
 * Product photos are fetched at runtime, in small batches, instead of being
 * bundled with the catalog seed. A barcode resolves to one https photo URL or
 * to null; the UI shows a letter tile in both the pending and the null case.
 *
 * Results are cached in memory (including nulls) and identical requests share
 * one in-flight promise, so scrolling or re-rendering never fetches twice.
 */

export const IMAGE_BATCH_SIZE = 12;

/** The endpoint accepts only these barcodes; one bad value would fail its whole batch. */
const BARCODE = /^\d{4,24}$/;

type ImageBody = {
  ok?: boolean;
  data?: { images?: Record<string, unknown> } | null;
};

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** Only https photos are kept, so a response can never inject another scheme. */
function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** For tests: starts every load from a clean cache. */
export function clearImageCache(): void {
  cache.clear();
  inFlight.clear();
}

async function requestBatch(batch: string[]): Promise<Record<string, string | null>> {
  const values: Record<string, string | null> = Object.create(null);
  let images: Record<string, unknown> = {};

  try {
    const params = new URLSearchParams({ barcodes: batch.join(",") });
    const response = await fetch(`/api/images?${params.toString()}`);
    if (response.ok) {
      const body = (await response.json()) as ImageBody | null;
      if (body?.ok && body.data && body.data.images && typeof body.data.images === "object") {
        images = body.data.images;
      }
    }
  } catch {
    // A missing endpoint or a dropped connection is not worth an error state:
    // every photo simply falls back to its letter tile.
  }

  for (const code of batch) {
    const url = safeImageUrl(images[code]);
    cache.set(code, url);
    values[code] = url;
  }
  return values;
}

/**
 * Resolves a photo URL for each barcode, in requests of at most
 * IMAGE_BATCH_SIZE. Unknown, failed and missing entries resolve to null.
 */
export async function loadImages(codes: string[]): Promise<Record<string, string | null>> {
  const unique = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
  const result: Record<string, string | null> = Object.create(null);
  const waits: Promise<unknown>[] = [];
  const missing: string[] = [];

  for (const code of unique) {
    if (!BARCODE.test(code)) {
      cache.set(code, null);
      result[code] = null;
      continue;
    }
    if (cache.has(code)) {
      result[code] = cache.get(code) ?? null;
      continue;
    }
    const pending = inFlight.get(code);
    if (pending) {
      waits.push(
        pending.then((url) => {
          result[code] = url;
        }),
      );
      continue;
    }
    missing.push(code);
  }

  for (let index = 0; index < missing.length; index += IMAGE_BATCH_SIZE) {
    const batch = missing.slice(index, index + IMAGE_BATCH_SIZE);
    const request = requestBatch(batch);
    for (const code of batch) {
      const single = request.then((values) => values[code] ?? null);
      inFlight.set(code, single);
      void single
        .finally(() => {
          if (inFlight.get(code) === single) inFlight.delete(code);
        })
        .catch(() => undefined);
      waits.push(
        single.then((url) => {
          result[code] = url;
        }),
      );
    }
  }

  await Promise.all(waits);
  for (const code of unique) {
    if (!(code in result)) result[code] = cache.get(code) ?? null;
  }
  return result;
}
