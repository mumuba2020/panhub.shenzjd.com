import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { createApp, toNodeListener } from "h3";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * search.stream 页面端配额分支回归测试（2026-09-04 接入 floating-unlock）
 *
 * 页面端已登录用户免费搜 FREE_SEARCH_LIMIT 次（按 openid 内存计数），
 * 超限后 SSE 建流返回 402（前端弹广告解锁）；看完广告带一次性票据
 * X-Unlock-Ticket / X-Unlock-Grant 重试，服务端验票核销后清零放行。
 *
 * 豁免链路也在这里回归：
 * - Bearer 请求（小程序端）不计数不拦截（页面端限制不适用于微信端）
 * - 管理员（isAdminUser）不拦截
 *
 * 装配方式与 stream-blocked-honeypot.test.ts 相同：真实 handler + mock 依赖。
 * 放行场景 handler 会继续走到 useRuntimeConfig（无 Nitro 环境 ReferenceError
 * → 500），断言"非 402"即表示配额段已放行，语义足够。
 */

// mock 频控与黑名单：不拦截
vi.mock("../../server/core/services/botDefense", () => ({
  getOrCreateBotDefenseService: () => ({
    isBlocked: vi.fn(async () => false),
  }),
}));
vi.mock("../../server/utils/entryRateLimit", () => ({
  isSearchRateLimited: vi.fn(async () => false),
}));

// mock 鉴权：requireWxAuth 直接放行（配额段在其后执行）
vi.mock("../../server/utils/requireAuth", () => ({
  requireHumanOrCredential: () => {},
  requireWxAuth: async () => "ok",
}));

// mock 凭证提取与管理员判断：getBearerToken 默认 null（页面端 cookie 场景）
const getBearerTokenMock = vi.fn(() => null);
const isAdminUserMock = vi.fn(async () => false);
vi.mock("../../server/utils/wxAuthCheck", () => ({
  getBearerToken: () => getBearerTokenMock(),
  isAdminUser: (e: unknown) => isAdminUserMock(e),
}));

// mock 广告票据验票（默认通过）
const verifyUnlockGrantMock = vi.fn(async () => true);
vi.mock("../../server/utils/unlockVerify", () => ({
  verifyUnlockGrant: (p: unknown) => verifyUnlockGrantMock(p),
  getUnlockTicketFromHeaders: (
    ticket?: string,
    grant?: string
  ): { ticket: string; grant: string } | null => {
    const t = ticket?.trim();
    const g = grant?.trim();
    if (!t || !g) return null;
    return { ticket: t, grant: g };
  },
}));

import searchStreamHandler from "../../server/api/search.stream.get";
import {
  consumeQuota,
  resetAllQuotas,
  FREE_SEARCH_LIMIT,
} from "../../server/core/services/searchQuotaService";

let server: ReturnType<typeof createServer>;
let baseUrl = "";
const TEST_OPENID = "oTEST-quota-openid";

beforeAll(async () => {
  const app = createApp();
  app.use("/api/search.stream", searchStreamHandler);
  server = createServer(toNodeListener(app));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

// handler 从 event.context.__wxAuthOpenid 取计数身份（requireWxAuth 写入）。
// mock 的 requireWxAuth 不写 context，这里用 h3 不便注入——计数身份退化为
// 空字符串共用同一桶，因此每个用例前 resetAllQuotas 保证隔离。
beforeEach(() => {
  resetAllQuotas();
  getBearerTokenMock.mockReturnValue(null);
  isAdminUserMock.mockResolvedValue(false);
  verifyUnlockGrantMock.mockResolvedValue(true);
});

async function requestStream(headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/search.stream?kw=test`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/151",
      accept: "text/event-stream",
      ...headers,
    },
  });
}

describe("search.stream 页面端配额（floating-unlock 接入）", () => {
  it("免费额度内（1..3 次）不返回 402", async () => {
    for (let i = 0; i < FREE_SEARCH_LIMIT; i++) {
      const resp = await requestStream();
      expect(resp.status).not.toBe(402);
      await resp.text().catch(() => "");
    }
    // handler 内 consumeQuota 与本进程共享模块状态：共 3 次
  }, 15000);

  it("第 4 次建流返回 402 QUOTA_EXCEEDED（前端弹广告的信号）", async () => {
    for (let i = 0; i < FREE_SEARCH_LIMIT; i++) {
      await requestStream().then((r) => r.text().catch(() => ""));
    }
    const resp = await requestStream();
    expect(resp.status).toBe(402);
    const body = (await resp.json()) as {
      data?: { code?: string; used?: number; freeLimit?: number };
    };
    expect(body.data?.code).toBe("QUOTA_EXCEEDED");
    expect(body.data?.used).toBe(FREE_SEARCH_LIMIT + 1);
    expect(body.data?.freeLimit).toBe(FREE_SEARCH_LIMIT);
  }, 15000);

  it("带有效票据重试：验票通过 → 清零放行（非 402）", async () => {
    for (let i = 0; i < FREE_SEARCH_LIMIT + 1; i++) {
      await requestStream().then((r) => r.text().catch(() => ""));
    }
    const resp = await requestStream({
      "x-unlock-ticket": "tk-123",
      "x-unlock-grant": "gr-abc",
    });
    expect(resp.status).not.toBe(402);
    expect(verifyUnlockGrantMock).toHaveBeenCalledWith({
      ticket: "tk-123",
      grant: "gr-abc",
    });
    // 验票通过后配额已清零：下次搜索从第 1 次重新计数
    expect(consumeQuota(TEST_OPENID)).toBe(1);
  }, 15000);

  it("票据验票失败（fail-closed）：仍 402 且不清零配额", async () => {
    verifyUnlockGrantMock.mockResolvedValue(false);
    const resp = await requestStream({
      "x-unlock-ticket": "tk-bad",
      "x-unlock-grant": "gr-bad",
    });
    expect(resp.status).toBe(402);
    // 失败不消耗：手动计数仍是 0（本用例此前无 consume）
    expect(consumeQuota(TEST_OPENID)).toBe(1);
  }, 15000);

  it("Bearer 请求（小程序端）豁免：超过免费额度也不 402", async () => {
    getBearerTokenMock.mockReturnValue("mp-token");
    for (let i = 0; i < FREE_SEARCH_LIMIT + 2; i++) {
      const resp = await requestStream({
        authorization: "Bearer mp-token",
      });
      expect(resp.status).not.toBe(402);
      await resp.text().catch(() => "");
    }
  }, 15000);

  it("管理员豁免：超过免费额度也不 402", async () => {
    isAdminUserMock.mockResolvedValue(true);
    for (let i = 0; i < FREE_SEARCH_LIMIT + 2; i++) {
      const resp = await requestStream();
      expect(resp.status).not.toBe(402);
      await resp.text().catch(() => "");
    }
    expect(isAdminUserMock).toHaveBeenCalled();
  }, 15000);
});
