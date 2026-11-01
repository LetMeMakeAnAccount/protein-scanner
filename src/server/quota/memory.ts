import { randomUUID } from "node:crypto";
import type { QuotaActionContext, QuotaDecision, QuotaInput, QuotaStore } from "./types";

type Options = { enabled: boolean; globalCap: number; clientLimit?: number; windowMs?: number; timeoutMs?: number; maxConcurrency?: number; now?: () => number };

// Limits are process-local: restarts reset them and separate instances each
// have their own cap. This is not a distributed limit or a billing hard cap.
export class MemoryQuota implements QuotaStore {
  private readonly counts = new Map<string, number[]>();
  private readonly leases = new Set<string>();
  private admitted = 0;
  private readonly options: Required<Options>;
  constructor(options: Options) {
    this.options = { enabled: options.enabled === true, globalCap: options.globalCap, clientLimit: options.clientLimit ?? 10, windowMs: options.windowMs ?? 60_000, timeoutMs: options.timeoutMs ?? 15_000, maxConcurrency: options.maxConcurrency ?? 1, now: options.now ?? performance.now.bind(performance) };
    const { globalCap, clientLimit, windowMs, timeoutMs, maxConcurrency } = this.options;
    if (![globalCap, clientLimit, windowMs, timeoutMs, maxConcurrency].every(Number.isSafeInteger) || globalCap < 0 || globalCap > 1_000_000 || clientLimit < 1 || clientLimit > 1000 || windowMs < 1 || windowMs > 86_400_000 || timeoutMs < 1 || timeoutMs > 3_600_000 || maxConcurrency < 1 || maxConcurrency > 100) throw new Error("Invalid quota configuration");
  }
  async admit(input: QuotaInput): Promise<QuotaDecision> {
    const { enabled, globalCap, clientLimit, windowMs, maxConcurrency, timeoutMs, now } = this.options;
    if (!input || input.kind !== "model" || typeof input.clientKey !== "string" || !input.clientKey.trim() || input.clientKey.length > 512 || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) return { allowed: false, reason: "invalid_request" };
    if (!enabled || this.admitted >= globalCap) return { allowed: false, reason: "disabled_or_cap" };
    if (this.leases.size >= maxConcurrency) return { allowed: false, reason: "concurrency" };
    const current = now();
    if (!Number.isFinite(current)) return { allowed: false, reason: "unavailable" };
    for (const [key, entries] of this.counts) {
      const recent = entries.filter((time) => time > current - windowMs && time <= current);
      if (recent.length) this.counts.set(key, recent); else this.counts.delete(key);
    }
    const entries = this.counts.get(input.clientKey) ?? [];
    if (entries.length >= clientLimit) return { allowed: false, reason: "rate_limit" };
    entries.push(current); this.counts.set(input.clientKey, entries);
    this.admitted++;
    const leaseId = randomUUID(); this.leases.add(leaseId);
    return { allowed: true, leaseId, modelTimeoutMs: timeoutMs };
  }
  async release(leaseId: string): Promise<void> { this.leases.delete(leaseId); }
}

export async function withQuotaLease<T>(store: QuotaStore, input: QuotaInput, action: (context: QuotaActionContext) => Promise<T>): Promise<{ allowed: false; reason?: string } | { allowed: true; value: T }> {
  let admission: QuotaDecision;
  try { admission = await store.admit(input); } catch { return { allowed: false, reason: "unavailable" }; }
  if (!admission.allowed) return { allowed: false, reason: admission.reason };
  const controller = new AbortController();
  const timeout = admission.modelTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!admission.leaseId || !Number.isSafeInteger(timeout) || timeout! < 1 || timeout! > 3_600_000) return { allowed: false, reason: "unavailable" };
    const deadline = performance.now() + timeout!;
    timer = setTimeout(() => controller.abort(), timeout);
    const assertActive = () => { if (performance.now() >= deadline && !controller.signal.aborted) controller.abort(); controller.signal.throwIfAborted(); };
    assertActive();
    const value = await action({ signal: controller.signal, assertActive });
    assertActive();
    return { allowed: true, value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (admission.leaseId) await store.release(admission.leaseId);
  }
}
