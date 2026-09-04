/**
 * requireAuth（requireHumanOrCredential / requireWxAuth）单元测试
 *
 * 验证（2026-08-28 更新：Bearer 统一走 wx-auth 远程校验，自建 mpToken 已删除；
 * 2026-08-28 蜜罐化：requireWxAuth 返回三态，未认证不再抛 401）：
 * - bot/第三方 API UA 无 Bearer → 403（入口拦截，不执行搜索）
 * - bot/第三方 API UA 带 Bearer → 放行（有效性由 requireWxAuth 校验）
 * - 正常浏览器 UA → 放行
 * - requireWxAuth 三态：
 *   - "ok"           → 有效凭证（Bearer 或 cookie），放行
 *   - "honeypot"     → 无凭证（爬虫/直调）→ 调用方返回蜜罐假数据
 *   - "unauthorized" → 有凭证但失效（无效 Bearer / 取消关注）→ 调用方返回 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isBotUA } from "../../utils/botUA";

// mock h3：requireAuth 只用到这几个函数
vi.mock("h3", () => ({
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
  getHeader: vi.fn(),
  getRequestHeader: vi.fn(),
}));

// mock wxAuthCheck：避免测试触发远程 HTTP（Bearer 与 cookie 统一走它）
vi.mock("../../server/utils/wxAuthCheck", () => ({
  verifyWxAuthOnceCached: vi.fn(async () => true),
  getWxAuthCredential: vi.fn(() => ({})),
  getBearerToken: vi.fn(() => null),
}));

// mock rateLimiter：避免加载 h3 defineEventHandler（getClientIp 供 requireAuth 日志用）
vi.mock("../../server/middleware/rateLimiter", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// mock botDefense（requireAuth 里 recordRejection 异步调用）
vi.mock("../../server/core/services/botDefense", () => ({
  getOrCreateBotDefenseService: () => ({
    recordRejection: vi.fn(async () => ({})),
    isBlocked: vi.fn(async () => false),
  }),
}));

import { requireHumanOrCredential, requireWxAuth } from "../../server/utils/requireAuth";
import * as h3 from "h3";
import * as wxAuthCheck from "../../server/utils/wxAuthCheck";

const mockedVerifyWxAuthOnce = vi.mocked(wxAuthCheck.verifyWxAuthOnceCached);
const mockedGetWxAuthCredential = vi.mocked(wxAuthCheck.getWxAuthCredential);
const mockedGetBearerToken = vi.mocked(wxAuthCheck.getBearerToken);

const mockedGetHeader = vi.mocked(h3.getHeader);
const mockedGetRequestHeader = vi.mocked(h3.getRequestHeader);

function makeEvent(headers: Record<string, string | undefined> = {}) {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] },
    context: {} as Record<string, any>,
  } as any;
}

function expectH3Error(fn: () => void, statusCode: number) {
  let err: any;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.__isH3Error).toBe(true);
  expect(err.statusCode).toBe(statusCode);
}

describe("requireHumanOrCredential", () => {
  beforeEach(() => {
    mockedGetHeader.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("正常浏览器 UA 放行", () => {
    mockedGetHeader.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    mockedGetRequestHeader.mockReturnValue(undefined);
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("无 UA 放行（小程序等真实渠道兜底）", () => {
    mockedGetHeader.mockReturnValue(undefined);
    mockedGetRequestHeader.mockReturnValue(undefined);
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("curl UA 无凭证 → 403", () => {
    mockedGetHeader.mockReturnValue("curl/8.7.1");
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("python-requests UA 无凭证 → 403", () => {
    mockedGetHeader.mockReturnValue("python-requests/2.31.0");
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("Googlebot UA 无凭证 → 403（sitemap 自举拦截）", () => {
    mockedGetHeader.mockReturnValue(
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
    );
    mockedGetRequestHeader.mockReturnValue(undefined);
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });

  it("bot UA 带 Bearer token → 放行（有效性留给 requireWxAuth 校验）", () => {
    mockedGetHeader.mockReturnValue("curl/8.7.1");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer abc123" : undefined
    );
    expect(() => requireHumanOrCredential(makeEvent())).not.toThrow();
  });

  it("bot UA 不再放行 x-panhub-client-secret（2026-08-28 删除）→ 403", () => {
    mockedGetHeader.mockReturnValue("okhttp/4.12.0");
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "mp-secret" : undefined
    );
    expectH3Error(() => requireHumanOrCredential(makeEvent()), 403);
  });
});

// 确保 isBotUA 兜底可用（引用不报错）
describe("isBotUA（依赖引用完整性）", () => {
  it("可正常判定", () => {
    expect(isBotUA("curl/8.7.1")).toBe(true);
    expect(isBotUA("Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36")).toBe(false);
  });
});

describe("requireWxAuth", () => {
  beforeEach(() => {
    mockedVerifyWxAuthOnce.mockReset();
    mockedGetWxAuthCredential.mockReset();
    mockedGetBearerToken.mockReset();
    mockedGetHeader.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("有效 Bearer token（wx-auth 校验通过）→ 返回 ok（小程序）", async () => {
    mockedGetBearerToken.mockReturnValue("abc");
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(true);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("ok");
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("无效 Bearer token → 返回 unauthorized（有凭证但失效，不降级）", async () => {
    mockedGetBearerToken.mockReturnValue("invalid");
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("unauthorized");
  });

  it("无 Bearer + 无凭证 cookie → honeypot（爬虫/直调，蜜罐由调用方返回）", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("honeypot");
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("无 Bearer + 有凭证但失效 → unauthorized（取消关注真人，401 引导重新关注）", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({ token: "expired-token" });
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("unauthorized");
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("无 Bearer：cookie 校验通过 → 返回 ok", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({ token: "tok" });
    mockedVerifyWxAuthOnce.mockResolvedValue(true);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("ok");
  });

  it("不再放行 x-panhub-client-secret（2026-08-28 删除）→ 无凭证按蜜罐处理", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "x-panhub-client-secret" ? "secret" : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBe("honeypot");
    expect(mockedVerifyWxAuthOnce).toHaveBeenCalled();
  });

  it("小程序 UA（MicroMessenger）无凭证 → unauthorized（2026-08-29：401 引导重新登录，不喂蜜罐）", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "user-agent"
        ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600"
        : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBe("unauthorized");
  });

  it("微信开发者工具 UA（wechatdevtools）无凭证 → unauthorized", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "user-agent"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.20 wechatdevtools"
        : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBe("unauthorized");
  });

  it("非微信 UA（curl）无凭证 → 仍返回 honeypot（蜜罐只让路给微信渠道）", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    mockedGetHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "user-agent" ? "curl/8.7.1" : undefined
    );
    await expect(requireWxAuth(makeEvent())).resolves.toBe("honeypot");
  });

  it("无 UA 无凭证 → 仍返回 honeypot（保持 2026-08-28 行为）", async () => {
    mockedGetBearerToken.mockReturnValue(null);
    mockedGetWxAuthCredential.mockReturnValue({});
    mockedVerifyWxAuthOnce.mockResolvedValue(false);
    await expect(requireWxAuth(makeEvent())).resolves.toBe("honeypot");
  });
});
