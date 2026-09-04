import { defineEventHandler } from "h3";
import { getOrCreateHotSearchService } from "../core/services/hotSearchService";

/**
 * 首页统计带数据源（2026-09-01 替代 /hot 每日榜单日历的页头指标）
 *
 * 2026-09-03 改造（用户拍板：压减 Turso 读配额到每天一次）：
 * 统计带展示"昨天"的最终态数据——昨天已结束，值恒定不变，配合 service
 * 层日期键缓存（25h）做到每个数字每天只读一次库。返回字段语义改"昨日"：
 * - yesterdayTerms   ：昨日搜索词数（昨日词云词池大小）
 * - yesterdaySearches：昨日真实搜索次数（daily_searches 精确记录）
 * - totalSearches    ：累计搜索次数（stats_meta 计数器）
 * - totalTerms       ：累计词数（stats_meta 计数器）
 *
 * 前端文案须同步为"昨日搜索次数/昨日搜索词数"，避免误导用户把昨天数据
 * 当成"今天实时值"。
 */
export default defineEventHandler(async (event) => {
  const service = getOrCreateHotSearchService();

  if (!(await service.isReady())) {
    // 未配置 Turso：返回全 0（页面统计带隐藏或显示 0），不报错
    return {
      code: 0,
      message: "success",
      data: {
        yesterdayTerms: 0,
        yesterdaySearches: 0,
        totalSearches: 0,
        totalTerms: 0,
        configured: false,
      },
    };
  }

  const data = await service.getHomeYesterdayData();

  return {
    code: 0,
    message: "success",
    data: {
      yesterdayTerms: data.yesterdayTerms,
      yesterdaySearches: data.yesterdaySearches,
      totalSearches: data.totalSearches,
      totalTerms: data.totalTerms,
      configured: true,
    },
  };
});
