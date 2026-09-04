import { MemoryCache } from "./memoryCache";

/**
 * 管理端读缓存（2026-09-01 新增：管理页聚合查询零缓存 → 短 TTL）
 *
 * 背景：/api/admin/stats 每次请求 5 条 Turso 聚合查询（search_log 3 条 +
 * rejected_ips 2 条），/api/blacklist、/api/search-log 各 2 条，此前完全
 * 无缓存。管理页打开频率低但打开后前端会连续请求/刷新多个面板，短 TTL
 * 缓存把同一面板的连续请求合并为最多一次查库；且聚合读随 search_log 表
 * 增长变贵，TTL 内重复打开不再放大。
 *
 * 失效策略：管理页数据允许 30~60s 滞后（TTL 自然过期）；唯一需要"立即
 * 生效"的是写操作本身——blacklist post/delete 在变更后调用
 * invalidateAdminCache() 清空本缓存，保证拉黑/移除后列表与概览立刻反映。
 */

/** 概览统计 TTL（面板打开/刷新共用一份数据） */
export const ADMIN_STATS_TTL_MS = 60_000;
/** 列表类（黑名单/搜索明细）TTL：短一些，接近实时排查体验 */
export const ADMIN_LIST_TTL_MS = 30_000;

const cache = new MemoryCache({
  maxSize: 100,
  maxMemoryBytes: 8 * 1024 * 1024,
  cleanupInterval: 5 * 60_000,
});

/** 管理端 GET 读缓存包装：TTL 内同 key 直接返回，不触发任何查库 */
export async function withAdminCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key);
  if (hit.hit) return hit.value as T;
  const value = await fetcher();
  cache.set(key, value, ttlMs);
  return value;
}

/** 管理端写操作后失效读缓存（当前管理缓存整体规模小，直接全清最稳妥） */
export function invalidateAdminCache(): void {
  cache.clear();
}
