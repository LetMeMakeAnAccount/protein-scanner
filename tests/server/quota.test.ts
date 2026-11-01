import { describe, expect, it } from "vitest";
import { MemoryQuota, withQuotaLease } from "../../src/server/quota/memory";

const input = (clientKey = "client") => ({ kind: "model" as const, clientKey, requestId: crypto.randomUUID() });
describe("single-process quota", () => {
  it("fails closed when disabled or capped at zero", async () => {
    for (const quota of [new MemoryQuota({ enabled: false, globalCap: 1 }), new MemoryQuota({ enabled: true, globalCap: 0 })]) expect((await quota.admit(input())).allowed).toBe(false);
  });
  it("atomically admits only one of concurrent requests for the last slot and never refunds it", async () => {
    const quota = new MemoryQuota({ enabled: true, globalCap: 1 });
    const results = await Promise.all([quota.admit(input("a")), quota.admit(input("b"))]);
    expect(results.filter((x) => x.allowed)).toHaveLength(1);
    await quota.release(results.find((x) => x.allowed)!.leaseId!);
    expect((await quota.admit(input())).allowed).toBe(false);
  });
  it("enforces an independent per-client window without silent global resets", async () => {
    let now = 100_000;
    const quota = new MemoryQuota({ enabled: true, globalCap: 3, clientLimit: 1, windowMs: 1000, now: () => now });
    const first = await quota.admit(input("a")); await quota.release(first.leaseId!);
    expect((await quota.admit(input("a"))).allowed).toBe(false);
    const other = await quota.admit(input("b")); expect(other.allowed).toBe(true); await quota.release(other.leaseId!);
    now += 1001; const third = await quota.admit(input("a")); expect(third.allowed).toBe(true); await quota.release(third.leaseId!);
    expect((await quota.admit(input("a"))).allowed).toBe(false);
  });
  it("aborts timed-out work and releases concurrency but never refunds admissions", async () => {
    const quota = new MemoryQuota({ enabled: true, globalCap: 1, timeoutMs: 20 });
    await expect(withQuotaLease(quota, input(), async (ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })))).rejects.toThrow();
    expect((await quota.admit(input())).allowed).toBe(false);
  });
  it("retains a concurrency slot while an action ignores cancellation", async () => {
    const quota = new MemoryQuota({ enabled: true, globalCap: 2, timeoutMs: 10, maxConcurrency: 1 });
    let finish!: () => void;
    const task = withQuotaLease(quota, input(), async () => new Promise<void>((resolve) => { finish = resolve; })).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await quota.admit(input("other"))).allowed).toBe(false);
    finish(); await task;
    expect((await quota.admit(input("other"))).allowed).toBe(true);
  });
});
