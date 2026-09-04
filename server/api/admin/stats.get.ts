import { defineEventHandler, createError } from "h3";
import { getSearchLogStore } from "../../core/services/tursoSearchLogStore";
import { getOrCreateBotDefenseService } from "../../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../../utils/wxAuthCheck";
import { withAdminCache, ADMIN_STATS_TTL_MS } from "../../core/cache/adminReadCache";

/**
 * 流量概览统计 API（2026-08-26 管理后台"流量概览"面板数据源）
 *
 * 一次返回两块聚合（只读，仅管理员可见）：
 * - search：基于 search_log 的真实搜索统计（不含被拦截流量）
 *   todayCount（今日搜索次数）/ todayTerms（今日去重词数）/
 *   trend（近 N 天每日搜索次数，连续序列）/ topTerms（近 N 天 TOP 搜索词）
 * - defense：基于 rejected_ips 的拦截/黑名单统计
 *   total（黑名单总条目）/ blocked（封禁中）/ todayActive（今日活跃被拒 IP）/
 *   topIps（近 N 天最活跃被拒 IP，按累计 hit_count 降序）
 *
 * 读缓存（2026-09-01）：原实现每次请求 5 条 Turso 聚合查询且零缓存，
 * 现整体结果缓存 60s——管理页低频打开场景下口径滞后 1 分钟无感知，
 * TTL 内重复刷新/多面板共用零查库。黑名单写操作会主动失效本缓存。
 *
 * 鉴权：与 admin/channels 一致 —— wx-auth isAdminUser。
 *   无 wxauth-token cookie → 401；登录态但非管理员 → 403。
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const data = await withAdminCache("admin:stats", ADMIN_STATS_TTL_MS, async () => {
    const logStore = getSearchLogStore();
    const botDefense = getOrCreateBotDefenseService();

    const [search, defense] = await Promise.all([
      logStore
        ? logStore.getOverviewStats(7, 10)
        : Promise.resolve({ todayCount: 0, todayTerms: 0, trend: [], topTerms: [] }),
      botDefense
        .getOverviewStats(7, 10)
        .catch(() => ({ total: 0, blocked: 0, todayActive: 0, topIps: [] })),
    ]);
    return { search, defense };
  });

  return {
    code: 0,
    message: "success",
    data,
  };
});