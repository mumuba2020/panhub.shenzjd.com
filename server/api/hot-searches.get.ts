import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 首页词云数据源（2026-09-03 改为昨日口径）
 *
 * 2026-09-03 改造（用户拍板：压减 Turso 读配额到每天一次）：词云展示
 * **昨天**被搜过的词（昨日最终态，随机取若干），与统计带 /api/hot-stats
 * 共享 service 层 `getHomeYesterdayData` 的日期键缓存（25h）——两个首页端点
 * 一天合计只读一次库。
 *
 * 数据源从"今天 last_at>=今日零点"改为"昨日全量词单随机子集"，
 * 随机保证词云新鲜感，用户不感知展示的是昨日还是今日词。
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();
  const query = getQuery(event);
  const limit = parseInt((query.limit as string) || "30", 10);

  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw createError({ statusCode: 400, message: "limit 参数无效，范围 1-100" });
  }

  if (!(await service.isReady())) {
    // 未配置 Turso：返回空词云（页面表现为无热搜），不报错；configured:false 供部署者排查
    return {
      code: 0,
      message: "success",
      data: { hotSearches: [], configured: false },
    };
  }

  // 词云候选从昨日词池随机子集取；词池内词已随机排序（见 service 实现）
  const home = await service.getHomeYesterdayData(limit);
  // heatPercent 分母取整个候选池的最大 score（随机后首位未必最大，避免 >100%）
  const poolMax = home.wordPool.reduce((m, w) => Math.max(m, w.count), 0);
  const maxScore = poolMax > 0 ? poolMax : 1;

  return {
    code: 0,
    message: "success",
    data: {
      hotSearches: home.wordPool.map((w, i) => ({
        term: w.term,
        score: w.count,
        lastSearched: 0,
        createdAt: 0,
        rank: i + 1,
        displayScore: w.count,
        heatPercent: Math.round((w.count / maxScore) * 100),
      })),
      configured: true,
    },
  };
});
