export type QuotaKind = "model";
export type QuotaInput = { kind: QuotaKind; clientKey: string; requestId: string };
export type QuotaDecision = { allowed: boolean; reason?: string; leaseId?: string; modelTimeoutMs?: number };

export type QuotaActionContext = { signal: AbortSignal; assertActive(): void };

export interface QuotaStore {
  admit(input: QuotaInput): Promise<QuotaDecision>;
  release(leaseId: string): Promise<void>;
}
