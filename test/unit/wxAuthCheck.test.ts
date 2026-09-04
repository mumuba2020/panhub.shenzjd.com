/**
 * wxAuthCheck（微信关注公众号登录态校验）单元测试
 *
 * 验证：
 * - cookie 提取（token 优先，openid 兜底，无 cookie 返回空）
 * - 实时校验：check 返回 authenticated=true → 放行；false → 拒绝
 * - 无 cookie → false（拒绝）
 * - wx-auth 服务故障/非 2xx → fail-closed 拒绝（2026-08-26 起不再降级放行）
 * - 请求内去重：同一次请求只调一次远程
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { H3Event } from "h3";

// mock h3
vi.mock("h3", () => ({
  getCookie: vi.fn(),
  createError: vi.fn((opts: any) => ({ ...opts, __isH3Error: true })),
  getHeader: vi.fn(),
  getRequestHeader: vi.fn(),
}));

import * as h3 from "h3";
import {
  getWxAuthCredential,
  getBearerToken,
  verifyWxAuthCredential,
  verifyWxAuthOnce,
  verifyWxAuthOnceCached,
  getWxAuthUserFromBearer,
  resetWxAuthCache,
  isAdminUser,
} from "../../server/utils/wxAuthCheck";

const mockedGetCookie = vi.mocked(h3.getCookie);
const mockedGetRequestHeader = vi.mocked(h3.getRequestHeader);

function makeEvent(cookies: Record<string, string> = {}): H3Event {
  const event = { context: {}, headers: { get: () => undefined } } as any;
  mockedGetCookie.mockImplementation((e: any, name: string) => cookies[name]);
  return event;
}

/** 带 Authorization 头的 event（小程序 Bearer 凭证） */
function makeBearerEvent(token: string): H3Event {
  const event = makeEvent({});
  mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
    name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined
  );
  return event;
}

describe("getBearerToken", () => {
  beforeEach(() => {
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("从 Authorization 头提取 Bearer token", () => {
    const event = makeBearerEvent("tok123");
    expect(getBearerToken(event)).toBe("tok123");
  });

  it("非 Bearer scheme / 空头 → null", () => {
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Basic abc" : undefined
    );
    expect(getBearerToken(makeEvent({}))).toBe(null);

    mockedGetRequestHeader.mockReturnValue(undefined);
    expect(getBearerToken(makeEvent({}))).toBe(null);
  });

  it("Bearer 后只有空串 → null", () => {
    mockedGetRequestHeader.mockImplementation((e: any, name: string) =>
      name.toLowerCase() === "authorization" ? "Bearer   " : undefined
    );
    expect(getBearerToken(makeEvent({}))).toBe(null);
  });
});

describe("getWxAuthCredential", () => {
  beforeEach(() => mockedGetCookie.mockReset());

  it("token 优先", () => {
    const event = makeEvent({ "wxauth-token": "tok123", "wxauth-openid": "oid456" });
    expect(getWxAuthCredential(event)).toEqual({ token: "tok123" });
  });

  it("无 token 时 openid 兜底", () => {
    const event = makeEvent({ "wxauth-openid": "oid456" });
    expect(getWxAuthCredential(event)).toEqual({ openid: "oid456" });
  });

  it("无 cookie 返回空对象", () => {
    const event = makeEvent({});
    expect(getWxAuthCredential(event)).toEqual({});
  });
});

describe("verifyWxAuthCredential", () => {
  const OLD_BASE = process.env.WX_AUTH_API_BASE;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  afterEach(() => {
    if (OLD_BASE === undefined) delete process.env.WX_AUTH_API_BASE;
    else process.env.WX_AUTH_API_BASE = OLD_BASE;
  });

  it("check 返回 authenticated:true → 放行", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    const event = makeEvent({ "wxauth-token": "valid-token" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/check?token=valid-token"),
      expect.anything()
    );
  });

  it("check 返回 authenticated:false → 拒绝", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    const event = makeEvent({ "wxauth-token": "invalid-token" });
    expect(await verifyWxAuthCredential(event)).toBe(false);
  });

  it("无 cookie → 拒绝且不调远程", async () => {
    const event = makeEvent({});
    expect(await verifyWxAuthCredential(event)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("check 非 2xx → fail-closed 拒绝", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthCredential(event)).toBe(false);
  });

  it("网络错误/超时 → fail-closed 拒绝", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthCredential(event)).toBe(false);
  });

  it("openid 兜底路径", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    const event = makeEvent({ "wxauth-openid": "oid" });
    expect(await verifyWxAuthCredential(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/check?openid=oid"),
      expect.anything()
    );
  });

  it("Bearer 凭证：走 Authorization 头调 check（不带 query），通过后把 openid 存进 context", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { openid: "mp:oABC", type: "mp", mpOpenid: "oABC" },
      }),
    });
    const event = makeBearerEvent("mp-token-1");
    expect(await verifyWxAuthCredential(event)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    // Bearer 走 Authorization 头，URL 不带 token query
    expect(url).toContain("/api/auth/check");
    expect(url).not.toContain("token=");
    expect(init.headers.authorization).toBe("Bearer mp-token-1");
    expect((event.context as any).__wxAuthOpenid).toBe("mp:oABC");
  });

  it("Bearer 凭证未认证 → 拒绝", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    expect(await verifyWxAuthCredential(makeBearerEvent("bad"))).toBe(false);
  });

  it("Bearer 凭证：wx-auth 故障 → fail-closed 拒绝", async () => {
    fetchMock.mockRejectedValue(new Error("wx-auth down"));
    expect(await verifyWxAuthCredential(makeBearerEvent("tok"))).toBe(false);
  });
});

describe("getWxAuthUserFromBearer（小程序 Bearer 身份解析，2026-08-28）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
    resetWxAuthCache();
  });

  it("有效 Bearer → 返回用户身份（含 mpOpenid）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { openid: "mp:oABC", type: "mp", mpOpenid: "oABC" },
      }),
    });
    const user = await getWxAuthUserFromBearer(makeBearerEvent("tok-1"));
    expect(user).toEqual({ openid: "mp:oABC", type: "mp", mpOpenid: "oABC" });
  });

  it("公众号用户 Bearer → mpOpenid 为 null，openid 即身份", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { openid: "oOFFICIAL", type: "official", mpOpenid: null },
      }),
    });
    const user = await getWxAuthUserFromBearer(makeBearerEvent("tok-2"));
    expect(user).toEqual({ openid: "oOFFICIAL", type: "official", mpOpenid: null });
  });

  it("未认证 / 服务故障 → null（fail-closed）", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    expect(await getWxAuthUserFromBearer(makeBearerEvent("bad"))).toBe(null);

    fetchMock.mockRejectedValue(new Error("down"));
    expect(await getWxAuthUserFromBearer(makeBearerEvent("tok-3"))).toBe(null);
  });

  it("无 Bearer → null 且不调远程", async () => {
    expect(await getWxAuthUserFromBearer(makeEvent({}))).toBe(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同一 Bearer 跨请求复用缓存（不重复打远程）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { openid: "mp:oABC", type: "mp", mpOpenid: "oABC" },
      }),
    });
    await getWxAuthUserFromBearer(makeBearerEvent("cached-tok"));
    await getWxAuthUserFromBearer(makeBearerEvent("cached-tok"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verifyWxAuthOnce（请求内去重）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
  });

  it("同一次请求内多次调用只调一次远程", async () => {
    const event = makeEvent({ "wxauth-token": "tok" });
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(await verifyWxAuthOnce(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verifyWxAuthOnceCached（跨请求短 TTL 去重，2026-08-24）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: true }) });
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
    resetWxAuthCache();
  });

  it("Bearer 凭证同样命中跨请求缓存（小程序一次搜索 40+ 子请求只调一次远程）", async () => {
    for (let i = 0; i < 40; i++) {
      const event = makeBearerEvent("mp-shared-token");
      expect(await verifyWxAuthOnceCached(event)).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/check"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer mp-shared-token" }),
      })
    );
  });

  it("Bearer 校验通过后 openid 存进 context（供搜索日志关联）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { openid: "mp:oABC", type: "mp", mpOpenid: "oABC" },
      }),
    });
    const event = makeBearerEvent("mp-ctx-token");
    expect(await verifyWxAuthOnceCached(event)).toBe(true);
    expect((event.context as any).__wxAuthOpenid).toBe("mp:oABC");
    expect((event.context as any).__wxAuthUser).toEqual({
      openid: "mp:oABC",
      type: "mp",
      mpOpenid: "oABC",
    });
  });

  it("同一 token 跨多个请求（如一次搜索 35+ 子请求）只调一次远程", async () => {
    // 模拟一次搜索的 40 个并发子请求（各自独立 event，同 cookie）
    for (let i = 0; i < 40; i++) {
      const event = makeEvent({ "wxauth-token": "shared-token" });
      expect(await verifyWxAuthOnceCached(event)).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不同 token 各自独立校验", async () => {
    await verifyWxAuthOnceCached(makeEvent({ "wxauth-token": "t1" }));
    await verifyWxAuthOnceCached(makeEvent({ "wxauth-token": "t2" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("false 结果也缓存（10s 内同一 token 反复失败不重复打远程）", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) });
    for (let i = 0; i < 10; i++) {
      const event = makeEvent({ "wxauth-token": "bad-token" });
      expect(await verifyWxAuthOnceCached(event)).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("无 cookie 不缓存不调远程（直接拒绝）", async () => {
    expect(await verifyWxAuthOnceCached(makeEvent({}))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isAdminUser（管理权限校验，2026-08-25）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.WX_AUTH_API_BASE = "https://wx-auth.example.com";
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    mockedGetCookie.mockReset();
    mockedGetRequestHeader.mockReset();
    resetWxAuthCache();
  });

  it("userinfo 返回 isAdmin:true → 管理员放行，且 10min 内缓存不重复打远程", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true, user: { openid: "o", isAdmin: true } }),
    });
    const event = makeEvent({ "wxauth-token": "admin-token" });
    expect(await isAdminUser(event)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/userinfo?token=admin-token"),
      expect.anything()
    );
    // 缓存命中：第二次不再调远程
    expect(await isAdminUser(makeEvent({ "wxauth-token": "admin-token" }))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("userinfo 返回 isAdmin:false → 非管理员拒绝", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true, user: { openid: "o", isAdmin: false } }),
    });
    expect(await isAdminUser(makeEvent({ "wxauth-token": "normal-token" }))).toBe(false);
  });

  it("无 token cookie → 拒绝且不调远程", async () => {
    expect(await isAdminUser(makeEvent({}))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("userinfo 非 2xx / 网络异常 → fail-closed 拒绝（管理接口不裸奔）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await isAdminUser(makeEvent({ "wxauth-token": "tok" }))).toBe(false);

    fetchMock.mockRejectedValue(new Error("userinfo down"));
    expect(await isAdminUser(makeEvent({ "wxauth-token": "tok2" }))).toBe(false);
  });
});
