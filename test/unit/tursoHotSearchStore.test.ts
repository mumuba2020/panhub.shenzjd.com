/**
 * TursoHotSearchStore 单元测试
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL，
 * 验证 recordSearch(delta 合并)/衰减/日历/词单/清理等行为与 sqlite/d1 实现语义一致。
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoHotSearchStore } from "../../server/core/services/tursoHotSearchStore";

/** 北京时间（UTC+8）日期键，与实现保持一致 */
function dateKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

describe("TursoHotSearchStore", () => {
  let store: TursoHotSearchStore;

  beforeEach(async () => {
    store = new TursoHotSearchStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  it("recordSearch 新词写入热搜与词库（delta=1）", async () => {
    const now = Date.now();
    await store.recordSearch("测试电影", now);

    const hot = await store.getHotSearches(10);
    expect(hot.length).toBe(1);
    expect(hot[0].term).toBe("测试电影");
    expect(hot[0].score).toBeCloseTo(1, 5);

    const terms = await store.getTopTerms(10);
    expect(terms.length).toBe(0); // count=1 < 2，不满足 getTopTerms 门槛
  });

  it("recordSearch 支持 delta 合并（一次写入 count+N）", async () => {
    const now = Date.now();
    await store.recordSearch("热词", now, 5);
    await store.recordSearch("热词", now, 3); // 同一时刻，无衰减

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "热词");
    expect(item?.score).toBeCloseTo(8, 4); // 5 + 3

    const terms = await store.getTopTerms(10);
    expect(terms).toEqual([{ term: "热词", count: 8 }]);
  });

  it("recordSearch 已有词分数递增（无衰减时 +1）", async () => {
    const t0 = Date.now();
    await store.recordSearch("热门词", t0);
    await store.recordSearch("热门词", t0 + 1000);
    await store.recordSearch("热门词", t0 + 2000);

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "热门词");
    expect(item?.score).toBeCloseTo(3, 4);
  });

  it("recordSearch 分数随时间指数衰减", async () => {
    // hot_searches 表已废弃（2026-08-18），getHotSearches 改从 search_terms 聚合：
    // score = count 直接累计，不再指数衰减
    const t0 = Date.now();
    await store.recordSearch("衰减词", t0);
    await store.recordSearch("衰减词", t0 + 86400000); // 1 天后再搜：count +1

    const hot = await store.getHotSearches(10);
    const item = hot.find((s) => s.term === "衰减词");
    expect(item?.score).toBe(2);
  });

  it("空串丢弃，其余全部记录（2026-08-22 用户拍板：不限制搜索内容）", async () => {
    const now = Date.now();
    // URL / 超长 / 敏感词均允许记录
    await store.recordSearch("https://example.com", now);
    await store.recordSearch("a".repeat(21), now);
    await store.recordSearch("赌博网站", now);
    // 空串仍丢弃
    await store.recordSearch("   ", now);

    const hot = await store.getHotSearches(10);
    const terms = hot.map((s) => s.term);
    expect(terms).toContain("https://example.com");
    expect(terms).toContain("a".repeat(21));
    expect(terms).toContain("赌博网站");
    expect(terms).not.toContain("");
  });

  it("全角转半角规范化", async () => {
    const now = Date.now();
    await store.recordSearch("ＡＢＣ电影", now);
    const hot = await store.getHotSearches(10);
    expect(hot[0].term).toBe("ABC电影");
  });

  it("getHotSearches 按热度排序并带 displayScore", async () => {
    const now = Date.now();
    await store.recordSearch("冷词", now);
    for (let i = 0; i < 5; i++) await store.recordSearch("热词", now);

    const hot = await store.getHotSearches(10);
    expect(hot[0].term).toBe("热词");
    expect(hot[0].displayScore).toBeGreaterThan(hot[1].displayScore);
    expect(hot[0].rank).toBe(1);
  });

  it("getRandomHotSearches 只返回北京时间今日的词", async () => {
    const now = Date.now();
    await store.recordSearch("今日词", now);
    await store.recordSearch("昨日词", now - 2 * 86400000);

    const samples = await store.getRandomHotSearches(25);
    const terms = samples.map((s) => s.term);
    expect(terms).toContain("今日词");
    expect(terms).not.toContain("昨日词");
  });

  it("getTopTerms 只返回 count>=2 且长度>=2 的词", async () => {
    const now = Date.now();
    await store.recordSearch("电影", now);
    await store.recordSearch("电影", now);
    await store.recordSearch("电", now); // 长度 1，排除
    await store.recordSearch("孤", now);
    await store.recordSearch("孤", now); // 长度 1，排除

    const terms = await store.getTopTerms(10);
    expect(terms).toEqual([{ term: "电影", count: 2 }]);
  });

  it("getCalendar 返回连续日期与每天 top3", async () => {
    const now = Date.now();
    await store.recordSearch("词甲", now);
    await store.recordSearch("词乙", now);
    await store.recordSearch("词乙", now);
    await store.recordSearch("词丙", now);
    await store.recordSearch("词丙", now);
    await store.recordSearch("词丙", now);

    const calendar = await store.getCalendar(3);
    expect(calendar.length).toBe(3);
    const today = calendar[calendar.length - 1];
    expect(today.date).toBe(dateKey(now));
    expect(today.count).toBe(3);
    // store 层不填次数（次数由 service 层用 getDailySearchesRange 合并）
    expect(today.searches).toBeNull();
    expect(today.top).toEqual(["词丙", "词乙", "词甲"]);
  });

  it("getDayItems 返回指定日期词单", async () => {
    const now = Date.now();
    await store.recordSearch("日词1", now);
    await store.recordSearch("日词2", now);
    await store.recordSearch("日词2", now);

    const today = dateKey(now);
    const items = await store.getDayItems(today);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ term: "日词2", rank: 1, count: 2 });
  });

  it("getTotalSearches 返回历史累计搜索总次数（全表 SUM(count)）", async () => {
    const now = Date.now();
    await store.recordSearch("词A", now, 3);
    await store.recordSearch("词B", now, 2);
    await store.recordSearch("词C", now, 5);
    await store.recordSearch("词A", now, 4); // 累计 count 合并：词A 3+4=7

    const total = await store.getTotalSearches();
    expect(total).toBe(7 + 2 + 5); // 14
  });

  it("getTotalSearches 空库返回 0", async () => {
    expect(await store.getTotalSearches()).toBe(0);
  });

  it("getTotalTerms 返回词库累计词数（全表 COUNT(*)）", async () => {
    const now = Date.now();
    await store.recordSearch("词A", now);
    await store.recordSearch("词B", now);
    await store.recordSearch("词C", now);
    await store.recordSearch("词A", now); // 同词不新增行

    expect(await store.getTotalTerms()).toBe(3);
  });

  it("getTotalTerms 空库返回 0", async () => {
    expect(await store.getTotalTerms()).toBe(0);
  });

  it("recordDailySearches 精确累加指定日期搜索次数（部署起计数）", async () => {
    await store.recordDailySearches("2026-08-22", 5);
    await store.recordDailySearches("2026-08-22", 3);
    await store.recordDailySearches("2026-08-21", 2);

    expect(await store.getDailySearches("2026-08-22")).toBe(8);
    expect(await store.getDailySearches("2026-08-21")).toBe(2);
    expect(await store.getDailySearches("2026-08-20")).toBe(0);
  });

  it("getDailySearchesDayCount 统计有记录的天数", async () => {
    expect(await store.getDailySearchesDayCount()).toBe(0);
    await store.recordDailySearches("2026-08-20", 1);
    await store.recordDailySearches("2026-08-21", 1);
    await store.recordDailySearches("2026-08-22", 1);
    expect(await store.getDailySearchesDayCount()).toBe(3);
  });

  it("recordSearchBatch 返回本批新增词数（新词计入、旧词不计）", async () => {
    const now = Date.now();
    expect(await store.recordSearchBatch([{ term: "新词一", lastAt: now, delta: 2 }])).toBe(1);
    // 同词再次落盘：非新词
    expect(await store.recordSearchBatch([{ term: "新词一", lastAt: now, delta: 1 }])).toBe(0);
    // 一批混合：1 个新词 + 1 个旧词
    expect(
      await store.recordSearchBatch([
        { term: "新词二", lastAt: now, delta: 1 },
        { term: "新词一", lastAt: now, delta: 3 },
      ])
    ).toBe(1);
    // 新词 count 正确（0 占位 + delta），旧词累加正确
    const hot = await store.getHotSearches(10);
    expect(hot.find((s) => s.term === "新词一")?.score).toBe(2 + 1 + 3);
    expect(hot.find((s) => s.term === "新词二")?.score).toBe(1);
  });

  it("flush 维护计数器：getCalendarMeta 日常只读计数器（不再全表扫描）", async () => {
    const now = Date.now();
    // 第一批：2 个新词、3 次搜索 → 计数器建立
    await store.recordSearchBatch([
      { term: "批词A", lastAt: now, delta: 2 },
      { term: "批词B", lastAt: now, delta: 1 },
    ]);
    await store.recordDailySearchesBatch([{ date: "2026-09-03", delta: 3 }]);

    let meta = await store.getCalendarMeta();
    expect(meta.totalTerms).toBe(2);
    expect(meta.totalSearches).toBe(3);

    // 第二批：1 个新词、2 次搜索 → 计数器增量维护（flush 会拿
    // recordSearchBatch 的返回值调 incrementTotalTerms，这里模拟之）
    const newTerms = await store.recordSearchBatch([{ term: "批词C", lastAt: now, delta: 2 }]);
    expect(newTerms).toBe(1);
    await store.incrementTotalTerms(newTerms);
    await store.recordDailySearchesBatch([{ date: "2026-09-03", delta: 2 }]);

    meta = await store.getCalendarMeta();
    expect(meta.totalTerms).toBe(3);
    expect(meta.totalSearches).toBe(5);
  });

  it("getCalendarMeta 计数器缺失时一次性回填真实表（recordSearch 直写场景）", async () => {
    const now = Date.now();
    // 直写 recordSearch 不走 flush（不维护计数器）→ getCalendarMeta 回填
    await store.recordSearch("直写词A", now, 4);
    await store.recordSearch("直写词B", now, 1);

    const meta = await store.getCalendarMeta();
    expect(meta.totalTerms).toBe(2);
    expect(meta.totalSearches).toBe(5);

    // 回填后再 flush 增量：计数器继续累加，不重复计直写部分
    // （同上：flush 会用 batch 返回值维护 total_terms，这里模拟之）
    const newTerms = await store.recordSearchBatch([{ term: "直写词C", lastAt: now, delta: 2 }]);
    expect(newTerms).toBe(1);
    await store.incrementTotalTerms(newTerms);
    await store.recordDailySearchesBatch([{ date: "2026-09-03", delta: 2 }]);
    const meta2 = await store.getCalendarMeta();
    expect(meta2.totalTerms).toBe(3);
    expect(meta2.totalSearches).toBe(7);
  });

  it("clearHotSearches 同时清空计数器（stats_meta）", async () => {
    const now = Date.now();
    await store.recordSearchBatch([{ term: "清空词", lastAt: now, delta: 5 }]);
    await store.recordDailySearchesBatch([{ date: "2026-09-03", delta: 5 }]);
    expect((await store.getCalendarMeta()).totalSearches).toBe(5);

    await store.clearHotSearches();
    const meta = await store.getCalendarMeta();
    expect(meta.totalTerms).toBe(0);
    expect(meta.totalSearches).toBe(0);
  });

  it("deleteHotSearch 同步递减 total_terms 计数器", async () => {
    const now = Date.now();
    await store.recordSearchBatch([
      { term: "待删词2", lastAt: now, delta: 1 },
      { term: "保留词2", lastAt: now, delta: 1 },
    ]);
    expect((await store.getCalendarMeta()).totalTerms).toBe(2);

    await store.deleteHotSearch("待删词2");
    expect((await store.getCalendarMeta()).totalTerms).toBe(1);
  });

  it("getCalendarMeta 一次 batch 返回总词数/总次数/有记录天数", async () => {
    const now = Date.now();
    await store.recordSearch("甲", now, 3);
    await store.recordSearch("乙", now, 2);
    await store.recordDailySearches("2026-08-22", 5);

    const meta = await store.getCalendarMeta();
    expect(meta.totalTerms).toBe(2);
    expect(meta.totalSearches).toBe(5);
    expect(meta.dailyDayCount).toBe(1);
  });

  it("clearHotSearches 同时清空 daily_searches", async () => {
    const now = Date.now();
    await store.recordSearch("清空词", now);
    await store.recordDailySearches("2026-08-22", 10);

    await store.clearHotSearches();
    expect((await store.getHotSearches(10)).length).toBe(0);
    expect(await store.getDailySearches("2026-08-22")).toBe(0);
    expect(await store.getDailySearchesDayCount()).toBe(0);
  });

  it("deleteHotSearch 删除与容错", async () => {
    const now = Date.now();
    await store.recordSearch("待删词", now);

    const ok = await store.deleteHotSearch("待删词");
    expect(ok.success).toBe(true);
    expect((await store.getHotSearches(10)).length).toBe(0);

    const miss = await store.deleteHotSearch("不存在");
    expect(miss.success).toBe(false);
  });

  it("clearHotSearches 清空词库表（search_terms）", async () => {
    const now = Date.now();
    await store.recordSearch("清空词", now);

    const res = await store.clearHotSearches();
    expect(res.success).toBe(true);
    expect((await store.getHotSearches(10)).length).toBe(0);
    // 词库表也被清空（hot_searches 已废弃，唯一数据表）
    expect((await store.getTopTerms(10)).length).toBe(0);
  });

  it("cleanupOldEntries 为 no-op（search_terms 全量词库不清理）", async () => {
    const now = Date.now();
    for (let i = 0; i < 35; i++) {
      await store.recordSearch(`词${i}`, now);
    }
    const hot = await store.getHotSearches(100);
    expect(hot.length).toBe(30); // getHotSearches 内部 cap 到 MAX_ENTRIES

    // 旧词不会被 cleanup 删除（search_terms 是全量词库）
    const oldStore = new TursoHotSearchStore("file::memory:");
    await (oldStore as any).waitForInit();
    await oldStore.recordSearch("旧词", now - 3 * 86400000);
    await oldStore.recordSearch("新词", now);
    await oldStore.cleanupOldEntries(30);
    const list = await oldStore.getHotSearches(100);
    expect(list.map((s) => s.term).sort()).toEqual(["新词", "旧词"]);
    oldStore.close();
  });
});
