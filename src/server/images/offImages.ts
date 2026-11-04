type Fetch = typeof globalThis.fetch;
type RecordValue = Record<string, unknown>;
type ImageValue = string | null;
type Options = {
  fetch?: Fetch;
  timeoutMs?: number;
  budgetMs?: number;
  concurrency?: number;
  ttlMs?: number;
  maxEntries?: number;
};
type CacheEntry = { value: ImageValue; expiresAt: number };
type Outcome = { value: ImageValue; cache: boolean };

const origin = "https://world.openfoodfacts.org";
const userAgent = "ProteinScanner/0.1 (product image lookup)";
const defaultTimeoutMs = 3_500;
const defaultBudgetMs = 8_000;
const defaultConcurrency = 4;
const defaultTtlMs = 24 * 60 * 60 * 1000;
const defaultMaxEntries = 500;
const maxResponseBytes = 262_144;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Product photos are hotlinked into the browser, so only a secure URL on an
 * Open Food Facts host is returned. Anything else is treated as "no photo".
 */
export function productImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "openfoodfacts.org" && !host.endsWith(".openfoodfacts.org")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imageFromProduct(value: unknown): ImageValue {
  const product = record(value);
  if (!product) return null;
  return (
    productImageUrl(product.image_front_small_url) ??
    productImageUrl(product.image_front_url)
  );
}

export function createOffImageClient(options: Options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = bounded(options.timeoutMs, defaultTimeoutMs);
  const budgetMs = bounded(options.budgetMs, defaultBudgetMs);
  const concurrency = bounded(options.concurrency, defaultConcurrency);
  const ttlMs = bounded(options.ttlMs, defaultTtlMs);
  const maxEntries = bounded(options.maxEntries, defaultMaxEntries);

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ImageValue>>();
  const waiting: Array<() => void> = [];
  let active = 0;

  function readCache(code: string): { hit: boolean; value: ImageValue } {
    const entry = cache.get(code);
    if (!entry) return { hit: false, value: null };
    if (entry.expiresAt <= Date.now()) {
      cache.delete(code);
      return { hit: false, value: null };
    }
    return { hit: true, value: entry.value };
  }

  function writeCache(code: string, value: ImageValue): void {
    cache.delete(code);
    cache.set(code, { value, expiresAt: Date.now() + ttlMs });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      // Hand the slot directly to the waiter so a new caller cannot overtake it.
      active += 1;
      next();
    }
  }

  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  async function withinBudget<T>(
    task: Promise<T>,
    deadline: number,
    fallback: T,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), remaining);
    });
    try {
      return await Promise.race([task, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function fetchOne(code: string, timeout: number): Promise<ImageValue> {
    if (timeout <= 0) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<ImageValue>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeout);
    });

    const request = (async (): Promise<ImageValue> => {
      const url = `${origin}/api/v2/product/${encodeURIComponent(code)}?fields=code,image_front_small_url,image_front_url`;
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": userAgent,
        },
      });
      if (!response.ok) return null;
      const body = await response.text();
      if (body.length > maxResponseBytes) return null;
      const data = record(JSON.parse(body));
      return data ? imageFromProduct(data.product) : null;
    })().catch(() => null);

    try {
      return await Promise.race([request, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function resolveOne(code: string, deadline: number): Promise<ImageValue> {
    const cached = readCache(code);
    if (cached.hit) return cached.value;

    const shared = inflight.get(code);
    if (shared) return withinBudget(shared, deadline, null);

    const task = (async (): Promise<ImageValue> => {
      const outcome = await withinBudget<Outcome>(
        withSlot(async (): Promise<Outcome> => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { value: null, cache: false };
          return { value: await fetchOne(code, Math.min(timeoutMs, remaining)), cache: true };
        }),
        deadline,
        { value: null, cache: false },
      );
      if (outcome.cache) writeCache(code, outcome.value);
      return outcome.value;
    })().finally(() => {
      inflight.delete(code);
    });

    inflight.set(code, task);
    return withinBudget(task, deadline, null);
  }

  return {
    /**
     * Resolves one photo per barcode. A barcode with no usable photo, a failed
     * upstream response, or one that runs out of the endpoint budget is null;
     * one bad product never fails the whole batch.
     */
    async imagesFor(codes: string[]): Promise<Record<string, ImageValue>> {
      if (!Array.isArray(codes) || codes.length < 1 || codes.length > 12) {
        throw new Error("Invalid barcodes");
      }
      const unique = [...new Set(codes)];
      if (
        unique.length !== codes.length ||
        unique.some((code) => typeof code !== "string" || !/^\d{4,24}$/.test(code))
      ) {
        throw new Error("Invalid barcodes");
      }

      const deadline = Date.now() + budgetMs;
      const values = await Promise.all(unique.map((code) => resolveOne(code, deadline)));
      const result: Record<string, ImageValue> = {};
      unique.forEach((code, index) => {
        result[code] = values[index];
      });
      return result;
    },
  };
}
