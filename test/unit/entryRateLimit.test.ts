/**
 * entryRateLimit（搜索入口 IP 频控）单元测试
 *
 * 验证：
 * - 阈值内放行、超限拒绝
 * - 不同 IP 独立计数
 * - 窗口过期后恢复
 * - unknown / 空 IP 跳过（不误伤无 IP 场景）
 * - isSearchRateLimited 超限时触发 recordRejection（黑名单联动）
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createEntryRateLimiter,
  isSearchRateLimited,
  resetEntryRateLimiter,
} from "../../server/utils/entryRateLimit";

const { recordRejectionMock } = vi.hoisted(() => ({
  recordRejectionMock: vi.fn(async () => {}),
}));

// mock botDefense：只验证 recordRejection 被调用，不碰真实存储。
// 注意必须共享同一个 mock 实例，否则每次调用 getOrCreateBotDefenseService
// 都会拿到新的（记录不到调用）。
vi.mock("../../server/core/services/botDefense", () => ({
  getOrCreateBotDefenseService: () => ({ recordRejection: recordRejectionMock }),
}));

afterEach(() => {
  vi.clearAllMocks();
  resetEntryRateLimiter();
  vi.unstubAllEnvs();
});

describe("createEntryRateLimiter", () => {
  it("窗口内未超限放行，超限拒绝", () => {
    const limiter = createEntryRateLimiter(3, 60_000);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(true);
    expect(limiter.allow("1.2.3.4")).toBe(false);
    expect(limiter.allow("1.2.3.4")).toBe(false);
  });

  it("不同 IP 独立计数", () => {
    const limiter = createEntryRateLimiter(2, 60_000);
    limiter.allow("1.1.1.1");
    limiter.allow("1.1.1.1");
    expect(limiter.allow("1.1.1.1")).toBe(false);
    // 另一 IP 不受影响
    expect(limiter.allow("2.2.2.2")).toBe(true);
  });

  it("窗口过期后恢复放行", () => {
    vi.useFakeTimers();
    try {
      const limiter = createEntryRateLimiter(2, 60_000);
      limiter.allow("1.2.3.4");
      limiter.allow("1.2.3.4");
      expect(limiter.allow("1.2.3.4")).toBe(false);
      vi.advanceTimersByTime(61_000);
      expect(limiter.allow("1.2.3.4")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unknown / 空 IP 始终放行（不误伤无 IP 场景）", () => {
    const limiter = createEntryRateLimiter(1, 60_000);
    expect(limiter.allow("unknown")).toBe(true);
    expect(limiter.allow("unknown")).toBe(true);
    expect(limiter.allow("")).toBe(true);
    expect(limiter.allow("unknown")).toBe(true);
  });
});

describe("isSearchRateLimited（集成黑名单联动）", () => {
  it("未超限返回 false，不触发 recordRejection", async () => {
    const limited = await isSearchRateLimited("9.9.9.9");
    expect(limited).toBe(false);
    expect(recordRejectionMock).not.toHaveBeenCalled();
  });

  it("超限返回 true，并触发 recordRejection(rate_limit)", async () => {
    // 默认阈值 30：同一 IP 连续调用 31 次
    for (let i = 0; i < 30; i++) {
      expect(await isSearchRateLimited("9.9.9.9")).toBe(false);
    }
    const limited = await isSearchRateLimited("9.9.9.9");
    expect(limited).toBe(true);
    expect(recordRejectionMock).toHaveBeenCalledWith("9.9.9.9", "rate_limit");
  });

  it("unknown 不触发计数也不触发黑名单", async () => {
    for (let i = 0; i < 60; i++) {
      expect(await isSearchRateLimited("unknown")).toBe(false);
    }
    expect(recordRejectionMock).not.toHaveBeenCalled();
  });

  it("环境变量可覆盖阈值", async () => {
    vi.stubEnv("SEARCH_RATE_LIMIT", "2");
    expect(await isSearchRateLimited("7.7.7.7")).toBe(false);
    expect(await isSearchRateLimited("7.7.7.7")).toBe(false);
    expect(await isSearchRateLimited("7.7.7.7")).toBe(true);
  });
});