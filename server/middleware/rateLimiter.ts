import { defineEventHandler, getHeader, createError, setHeader } from "h3";
import { isIP } from "node:net";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";

/**
 * 全局限流中间件（IP 级，固定窗口）
 *
 * 第一性原理：限流必须建立在"攻击者不可伪造的客户端标识"之上。
 * 因此客户端 IP 的获取遵循以下优先级：
 *   1. event.context.clientAddress —— 平台注入（CF Workers 等），完全可信
 *   2. CF-Connecting-IP / X-Forwarded-For —— 仅当显式设置 TRUST_PROXY=1
 *      （前置了 CF/可信反代，它们会覆盖用户伪造的头，此时可信）
 *   3. socket remoteAddress —— 默认路径（Docker 直连），攻击者无法伪造
 *
 * 默认不信任任何代理头：若直接信任 X-Forwarded-For，攻击者每请求换一个
 * 伪 IP 头即可完全绕过限流，等于没有限流。
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export interface RateLimitConfig {
  limits?: Record<string, { limit: number; windowMs: number }>;
  defaultLimit?: { limit: number; windowMs: number };
  maxStoreEntries?: number;
}

// 路径 → { limit, windowMs }
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  // 一次完整搜索 = 每个插件 1 请求 + TG 按批请求（可达 17~32 个），
  // 原 10 次/分会误伤正常用户的单次搜索，故放宽到 60（每分钟约 2 次完整搜索）
  "/api/search": { limit: 60, windowMs: 60_000 },
  // 探活每次最多 50 个链接 → 对上游请求放大 50x，需单独收紧防打爆网盘接口
  "/api/check": { limit: 15, windowMs: 60_000 },
  "/api/hot-searches": { limit: 30, windowMs: 60_000 },
  // 频道配置下发（服务端/部署方拉取频道配置；限流防循环抓取）
  "/api/channels": { limit: 120, windowMs: 60_000 },
};

const DEFAULT_LIMIT = { limit: 60, windowMs: 60_000 };
const CLEANUP_INTERVAL = 5 * 60_000; // 5 分钟清理一次
const DEFAULT_MAX_STORE_ENTRIES = 100_000; // store 上限，防内存 DoS

/** 是否显式声明前置了可信代理（CF / nginx 等）。默认 false → 不信任任何代理头 */
function trustProxy(): boolean {
  return process.env.TRUST_PROXY === "1";
}

/** IPv4-mapped IPv6 规范化：::ffff:1.2.3.4 -> 1.2.3.4 */
export function normalizeIp(ip: string): string {
  const v = ip.trim();
  if (v.startsWith("::ffff:")) return v.slice(7);
  return v;
}

/** 严格校验 IP 格式，防止代理头塞任意字符串撑爆 store */
export function isValidIp(ip: string): boolean {
  return isIP(normalizeIp(ip)) > 0;
}

/** 客户端 IP 获取（详见文件头注释） */
export function getClientIp(event: any): string {
  const ctx = event.context?.clientAddress;
  if (typeof ctx === "string" && ctx) return normalizeIp(ctx);

  if (trustProxy()) {
    const cf = getHeader(event, "cf-connecting-ip");
    if (typeof cf === "string" && isValidIp(cf)) return normalizeIp(cf);
    const xff = getHeader(event, "x-forwarded-for");
    if (typeof xff === "string" && xff) {
      const first = xff.split(",")[0]?.trim() || "";
      if (isValidIp(first)) return normalizeIp(first);
    }
  }

  const sock = event.node?.req?.socket?.remoteAddress;
  if (typeof sock === "string" && sock) return normalizeIp(sock);
  return "unknown";
}

export function getRateLimit(pathname: string, limits: Record<string, { limit: number; windowMs: number }>, defaultLimit: { limit: number; windowMs: number }) {
  // 精确匹配
  if (limits[pathname]) return limits[pathname];
  // 前缀匹配（如 /api/hot-searches 各子路径共享限制）
  for (const [prefix, config] of Object.entries(limits)) {
    if (pathname.startsWith(prefix)) return config;
  }
  return defaultLimit;
}

function cleanup(store: Map<string, RateLimitEntry>, lastCleanupRef: { value: number }, now: number) {
  if (now - lastCleanupRef.value < CLEANUP_INTERVAL) return;
  lastCleanupRef.value = now;
  for (const [key, entry] of store) {
    if (now > entry.resetTime) store.delete(key);
  }
}

/** 创建限流中间件（工厂：测试可用小限额/小上限构造独立实例） */
export function createRateLimitMiddleware(config: RateLimitConfig = {}) {
  const limits = config.limits ?? RATE_LIMITS;
  const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
  const maxStoreEntries = config.maxStoreEntries ?? DEFAULT_MAX_STORE_ENTRIES;
  const store = new Map<string, RateLimitEntry>();
  const lastCleanupRef = { value: Date.now() };

  return defineEventHandler((event: any) => {
    // 只限制 API 路由（健康检查和认证排除限流）
    const path = event.path || "";
    if (!path.startsWith("/api/")) return;
    if (path === "/api/health") return;

    cleanup(store, lastCleanupRef, Date.now());

    const ip = getClientIp(event);
    const { limit, windowMs } = getRateLimit(path, limits, defaultLimit);
    const key = `${ip}:${path}`;
    const now = Date.now();

    // store 超限：先清一次过期项；仍超则降级放行（宁可漏限，不可被内存打挂）
    if (store.size >= maxStoreEntries) {
      for (const [k, entry] of store) {
        if (now > entry.resetTime) store.delete(k);
      }
      if (store.size >= maxStoreEntries) {
        return;
      }
    }

    let entry = store.get(key);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      setHeader(event, "Retry-After", String(retryAfter));
      // 累积到 IP 黑名单（异步、不阻塞 429 抛出）：单 IP 短时间内反复触发限流，
      // 大概率是脚本/爬虫在试探阈值；与 UA 拦截共同构成两层证据
      void getOrCreateBotDefenseService().recordRejection(ip, "rate_limit");
      throw createError({
        statusCode: 429,
        message: `请求过于频繁，请${retryAfter}秒后重试`,
        data: { retryAfter },
      });
    }
  });
}

// 全局单例中间件（Nitro 约定）
export default createRateLimitMiddleware();
