import { loggers } from "../core/utils/logger";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";

/**
 * 搜索入口级 IP 频控（2026-08-25）
 *
 * 背景：黑名单拦截是"事后"防御——同一 IP 需要 50 次/5min 才拉黑，期间请求
 * 已全量执行搜索（跨全部 TG 频道 + 插件，资源放大数十倍）并打 Turso。
 * 本工具在入口层面叠加一个**轻量滑动窗口**：60s 内同 IP 超过
 * SEARCH_RATE_LIMIT（默认 30）次搜索请求 → 直接拒绝，命中后异步累计
 * recordRejection(ip, "rate_limit")（进入分级封禁体系）。
 *
 * 与全局 rateLimiter 中间件的关系：
 * - 全局中间件按"路径前缀"计（/api/search 60 次/分），已覆盖各搜索端点
 * - 本工具是**搜索专用、更强的**一档（30 次/分、只在搜索入口内），
 *   独立于路径前缀（/api/search、/api/search.stream、/api/search POST
 *   共享同一 IP 计数），让攻击者无法靠换端点多发一倍
 *
 * 设计：
 * - 内存固定窗口（Map<正常化IP, 计数>），与 botDefense cache 风格一致
 * - 纯内存、无 I/O：热路径零延迟；错误静默放行（fail-open，不误伤真人）
 * - 命中时异步累计拒绝 → 与黑名单联动（死不悔改就进入分级封禁）
 *
 * 幂等/兼容：
 * - createEntryRateLimiter(limit, windowMs) 可构造独立实例供测试
 * - 环境变量 SEARCH_RATE_LIMIT / SEARCH_WINDOW_MS 可覆盖默认值
 */

export interface EntryRateLimiter {
  /** 当前请求是否放行（false = 已超限，应拒绝） */
  allow(ip: string, now?: number): boolean;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** 搜索入口默认阈值：60s 内 30 次搜索请求（真实用户 1 分钟内不可能搜 30 次） */
export const SEARCH_RATE_LIMIT = 30;
/** 默认窗口：60 秒 */
export const SEARCH_WINDOW_MS = 60_000;
/** store 上限：防内存 DoS（Docker 长跑内存安全） */
const MAX_STORE_ENTRIES = 50_000;
/** 每 5 分钟清理一次过期窗口 */
const CLEANUP_INTERVAL_MS = 5 * 60_000;
/** 全局单例 key（与 botDefense/缓存服务风格一致） */
const ENTRY_RATE_LIMITER_KEY = "__panhub_entry_rate_limiter_v1__";

export function createEntryRateLimiter(
  limit: number = SEARCH_RATE_LIMIT,
  windowMs: number = SEARCH_WINDOW_MS
): EntryRateLimiter {
  const store = new Map<string, WindowEntry>();
  let lastCleanup = Date.now();

  const cleanup = (now: number): void => {
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    for (const [k, v] of store) {
      if (now >= v.resetAt) store.delete(k);
    }
  };

  return {
    allow(ip: string, now: number = Date.now()): boolean {
      if (!ip || ip === "unknown") return true;
      cleanup(now);
      // 防内存 DoS：超上限先清过期项，仍满则降级放行（宁可漏限不可被打挂）
      if (store.size >= MAX_STORE_ENTRIES) {
        for (const [k, v] of store) {
          if (now >= v.resetAt) store.delete(k);
        }
        if (store.size >= MAX_STORE_ENTRIES) return true;
      }
      let e = store.get(ip);
      if (!e || now >= e.resetAt) {
        e = { count: 0, resetAt: now + windowMs };
        store.set(ip, e);
      }
      e.count++;
      return e.count <= limit;
    },
  };
}

/**
 * 搜索入口限流判定：超限返回 true（应拒绝），并异步累计黑名单。
 * fail-open：任何异常都放行（不误伤真人），拒绝动作不阻塞主流程。
 */
export async function isSearchRateLimited(ip: string): Promise<boolean> {
  const limiter = getEntryRateLimiter();
  if (limiter.allow(ip)) return false;
  // 命中：异步累计到黑名单（不阻塞热 path 的拒绝）
  void getOrCreateBotDefenseService().recordRejection(ip, "rate_limit");
  loggers.search.warn(`搜索入口频控命中（60s/${SEARCH_RATE_LIMIT} 次）`, { ip });
  return true;
}

function getEntryRateLimiter(): EntryRateLimiter {
  const existing = (globalThis as any)[ENTRY_RATE_LIMITER_KEY];
  if (existing) return existing;
  // 支持运行时通过环境变量覆盖（不改代码/不重启即可调参）
  let limit = SEARCH_RATE_LIMIT;
  let windowMs = SEARCH_WINDOW_MS;
  try {
    const l = Number(process.env.SEARCH_RATE_LIMIT || "");
    if (Number.isFinite(l) && l > 0) limit = l;
    const w = Number(process.env.SEARCH_WINDOW_MS || "");
    if (Number.isFinite(w) && w > 0) windowMs = w;
  } catch {}
  const limiter = createEntryRateLimiter(limit, windowMs);
  (globalThis as any)[ENTRY_RATE_LIMITER_KEY] = limiter;
  return limiter;
}

/** 测试用：重置全局单例（清空计数） */
export function resetEntryRateLimiter(): void {
  delete (globalThis as any)[ENTRY_RATE_LIMITER_KEY];
}