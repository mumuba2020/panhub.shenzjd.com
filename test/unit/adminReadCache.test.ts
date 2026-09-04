/**
 * 管理端读缓存单元测试（2026-09-01）
 * 覆盖：TTL 内命中不重复取数、不同 key 独立缓存、失效全清、TTL 过期后重新取数。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("adminReadCache", () => {
  let withAdminCache: typeof import("../../server/core/cache/adminReadCache").withAdminCache;
  let invalidateAdminCache: typeof import("../../server/core/cache/adminReadCache").invalidateAdminCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../server/core/cache/adminReadCache");
    withAdminCache = mod.withAdminCache;
    invalidateAdminCache = mod.invalidateAdminCache;
    invalidateAdminCache();
  });

  it("TTL 内同 key 命中缓存，fetcher 只执行一次", async () => {
    const fetcher = vi.fn().mockResolvedValue({ total: 42 });
    const a = await withAdminCache("admin:stats", 60_000, fetcher);
    const b = await withAdminCache("admin:stats", 60_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b).toEqual({ total: 42 });
  });

  it("不同 key 各自缓存，互不影响", async () => {
    const fetcherA = vi.fn().mockResolvedValue({ items: [1] });
    const fetcherB = vi.fn().mockResolvedValue({ items: [2] });
    await withAdminCache("admin:blacklist:100", 30_000, fetcherA);
    await withAdminCache("admin:blacklist:200", 30_000, fetcherB);
    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("invalidateAdminCache 后重新取数", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ total: 1 })
      .mockResolvedValueOnce({ total: 2 });
    await withAdminCache("admin:stats", 60_000, fetcher);
    invalidateAdminCache();
    const second = await withAdminCache("admin:stats", 60_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second).toEqual({ total: 2 });
  });

  it("TTL 过期后重新取数", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    await withAdminCache("k", 10, fetcher);
    await new Promise((r) => setTimeout(r, 30));
    const second = await withAdminCache("k", 10, fetcher);
    expect(second).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
