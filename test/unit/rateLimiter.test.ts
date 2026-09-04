import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRateLimitMiddleware,
  getClientIp,
  normalizeIp,
  isValidIp,
} from "../../server/middleware/rateLimiter";

/**
 * 构造最小 h3 event mock：
 * - node.req.headers 供 getHeader 读取
 * - node.res.setHeader 供 setHeader 写入（Retry-After）
 */
function makeEvent(
  opts: {
    path?: string;
    remoteAddress?: string;
    headers?: Record<string, string>;
    clientAddress?: string;
  } = {}
): any {
  const res = { setHeader: vi.fn() };
  return {
    path: opts.path ?? "/api/search",
    context: opts.clientAddress ? { clientAddress: opts.clientAddress } : {},
    node: {
      req: {
        socket: { remoteAddress: opts.remoteAddress ?? "1.2.3.4" },
        headers: opts.headers ?? {},
      },
      res,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeIp / isValidIp", () => {
  it("IPv4-mapped IPv6 规范化为 IPv4", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("  1.2.3.4  ")).toBe("1.2.3.4");
  });

  it("严格校验 IP 格式", () => {
    expect(isValidIp("1.2.3.4")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
    expect(isValidIp("not-an-ip")).toBe(false);
    expect(isValidIp("999.999.999.999")).toBe(false);
    expect(isValidIp("")).toBe(false);
    // 规范化后仍是合法 IPv4
    expect(isValidIp("::ffff:8.8.8.8")).toBe(true);
  });
});

describe("getClientIp（防伪造核心）", () => {
  it("默认不信任任何代理头：伪造 XFF/CF 头被忽略，用 socket remoteAddress", () => {
    const event = makeEvent({
      remoteAddress: "1.2.3.4",
      headers: {
        "x-forwarded-for": "9.9.9.9",
        "cf-connecting-ip": "8.8.8.8",
      },
    });
    expect(getClientIp(event)).toBe("1.2.3.4");
  });

  it("TRUST_PROXY=1 时优先信任 CF-Connecting-IP", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const event = makeEvent({
      remoteAddress: "1.2.3.4",
      headers: { "cf-connecting-ip": "8.8.8.8", "x-forwarded-for": "9.9.9.9" },
    });
    expect(getClientIp(event)).toBe("8.8.8.8");
  });

  it("TRUST_PROXY=1 且无 CF 头时信任 XFF 第一个值", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const event = makeEvent({
      remoteAddress: "1.2.3.4",
      headers: { "x-forwarded-for": "9.9.9.9, 7.7.7.7" },
    });
    expect(getClientIp(event)).toBe("9.9.9.9");
  });

  it("TRUST_PROXY=1 但代理头非法时回退 socket", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const event = makeEvent({
      remoteAddress: "1.2.3.4",
      headers: { "x-forwarded-for": "garbage; drop table", "cf-connecting-ip": "evil" },
    });
    expect(getClientIp(event)).toBe("1.2.3.4");
  });

  it("平台注入的 clientAddress 始终优先", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const event = makeEvent({
      clientAddress: "100.64.0.1",
      remoteAddress: "1.2.3.4",
      headers: { "cf-connecting-ip": "8.8.8.8" },
    });
    expect(getClientIp(event)).toBe("100.64.0.1");
  });

  it("IPv4-mapped 的 socket 地址被规范化", () => {
    const event = makeEvent({ remoteAddress: "::ffff:5.6.7.8" });
    expect(getClientIp(event)).toBe("5.6.7.8");
  });
});

describe("createRateLimitMiddleware", () => {
  it("未超限放行，超限抛 429", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 2, windowMs: 60_000 } },
    });
    expect(handler(makeEvent())).toBeUndefined();
    expect(handler(makeEvent())).toBeUndefined();
    expect(() => handler(makeEvent())).toThrowError(
      expect.objectContaining({ statusCode: 429 })
    );
  });

  it("429 响应带 Retry-After 头", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 1, windowMs: 60_000 } },
    });
    const event1 = makeEvent();
    handler(event1);
    const event2 = makeEvent();
    expect(() => handler(event2)).toThrowError(
      expect.objectContaining({ statusCode: 429 })
    );
    expect(event2.node.res.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.stringMatching(/^\d+$/)
    );
  });

  it("不同 IP 独立计数", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 2, windowMs: 60_000 } },
    });
    handler(makeEvent({ remoteAddress: "1.1.1.1" }));
    handler(makeEvent({ remoteAddress: "1.1.1.1" }));
    expect(() => handler(makeEvent({ remoteAddress: "1.1.1.1" }))).toThrow();
    // 另一 IP 不受影响
    expect(handler(makeEvent({ remoteAddress: "2.2.2.2" }))).toBeUndefined();
  });

  it("XFF 伪造不同伪 IP 仍按真实 socket 计数（防绕过）", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 2, windowMs: 60_000 } },
    });
    // 每次请求换一个伪 XFF，但 socket 相同 → 第 3 次必须 429
    handler(makeEvent({ headers: { "x-forwarded-for": "10.0.0.1" } }));
    handler(makeEvent({ headers: { "x-forwarded-for": "10.0.0.2" } }));
    expect(() =>
      handler(makeEvent({ headers: { "x-forwarded-for": "10.0.0.3" } }))
    ).toThrowError(expect.objectContaining({ statusCode: 429 }));
  });

  it("窗口过期后恢复计数", () => {
    vi.useFakeTimers();
    try {
      const handler = createRateLimitMiddleware({
        limits: { "/api/search": { limit: 2, windowMs: 60_000 } },
      });
      handler(makeEvent());
      handler(makeEvent());
      expect(() => handler(makeEvent())).toThrowError(
        expect.objectContaining({ statusCode: 429 })
      );
      vi.advanceTimersByTime(61_000);
      expect(handler(makeEvent())).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("/api/health 与非 API 路径豁免", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 1, windowMs: 60_000 } },
    });
    for (let i = 0; i < 5; i++) {
      expect(handler(makeEvent({ path: "/api/health" }))).toBeUndefined();
      expect(handler(makeEvent({ path: "/" }))).toBeUndefined();
    }
  });

  it("不同 API 路径按各自前缀独立限流（含 /api/check 单独收紧）", () => {
    const handler = createRateLimitMiddleware({
      limits: {
        "/api/search": { limit: 60, windowMs: 60_000 },
        "/api/check": { limit: 2, windowMs: 60_000 },
      },
    });
    for (let i = 0; i < 5; i++) {
      expect(handler(makeEvent({ path: "/api/search" }))).toBeUndefined();
    }
    handler(makeEvent({ path: "/api/check" }));
    handler(makeEvent({ path: "/api/check" }));
    expect(() =>
      handler(makeEvent({ path: "/api/check" }))
    ).toThrowError(expect.objectContaining({ statusCode: 429 }));
  });

  it("store 超过上限时降级放行（防内存 DoS），不抛错", () => {
    const handler = createRateLimitMiddleware({
      limits: { "/api/search": { limit: 100, windowMs: 60_000 } },
      maxStoreEntries: 1,
    });
    // 第一个 IP 占满 store
    expect(handler(makeEvent({ remoteAddress: "1.1.1.1" }))).toBeUndefined();
    // 第二个 IP 触发降级 → 放行（不 OOM、不 429）
    expect(handler(makeEvent({ remoteAddress: "2.2.2.2" }))).toBeUndefined();
  });
});
