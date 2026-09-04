/**
 * 热搜功能测试（service 层）
 * 使用本地 libSQL 内存库（TURSO_URL=file::memory:，无网络、无凭据），
 * 不污染线上 Turso 数据。
 *
 * 语义说明：写路径为「内存聚合 + 异步批量落盘」，读路径直接读 store（写读分离）。
 * 因此测试在「写」后显式 await service.flush() 再「读」，模拟增量落盘后的读取。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { HotSearchService } from "../../server/core/services/hotSearchService";
import { formatDateKey } from "../../server/core/services/hotSearchUtils";

describe("HotSearchService (Turso store, local file::memory:)", () => {
  let service: HotSearchService;
  let resetHotSearchService: () => void;

  beforeAll(async () => {
    process.env.TURSO_URL = "file::memory:";
    delete process.env.TURSO_AUTH_TOKEN;
    const mod = await import("../../server/core/services/hotSearchService");
    resetHotSearchService = mod.resetHotSearchService;
    service = mod.getOrCreateHotSearchService();
    await service.clearHotSearches();
  });

  afterAll(() => {
    resetHotSearchService();
    delete process.env.TURSO_URL;
  });

  it("应该能够记录搜索词（flush 后可见）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("测试电影");
    await service.flush();

    const searches = await service.getHotSearches(10);
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[0].term).toBe("测试电影");
    expect(searches[0].score).toBeCloseTo(1, 5);
  });

  it("同词多次搜索应合并为一次增量写入", async () => {
    await service.clearHotSearches();
    await service.recordSearch("聚合词");
    await service.recordSearch("聚合词");
    await service.recordSearch("聚合词");
    await service.flush();

    const searches = await service.getHotSearches(10);
    const item = searches.find((s) => s.term === "聚合词");
    expect(item?.score).toBeCloseTo(3, 5);
  });

  it("未 flush 时读不到缓冲中的增量（写读分离）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("未落盘词");
    // 不 flush，直接读：缓冲未落盘，榜单应读不到该词
    const searches = await service.getHotSearches(50);
    expect(searches.some((s) => s.term === "未落盘词")).toBe(false);
  });

  it("应该能够获取热搜列表", async () => {
    await service.clearHotSearches();
    await service.recordSearch("电影");
    await service.recordSearch("软件");
    await service.recordSearch("学习资料");
    await service.flush();

    const searches = await service.getHotSearches(5);
    expect(searches.length).toBeLessThanOrEqual(5);
    expect(searches.length).toBeGreaterThan(0);
  });

  it("应该能够获取统计信息", async () => {
    await service.recordSearch("统计词");
    await service.flush();

    const stats = await service.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.topTerms).toBeInstanceOf(Array);
    expect(stats.mode).toBe("turso");
  });

  it("不限制用户搜索内容（2026-08-22 用户拍板：敏感词过滤已移除）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("政治敏感词");
    await service.recordSearch("暴力内容");
    await service.recordSearch("正常搜索词");
    await service.flush();

    const searches = await service.getHotSearches(50);
    // 用户搜什么就记录什么，不再过滤
    expect(searches.some((s) => s.term === "政治敏感词")).toBe(true);
    expect(searches.some((s) => s.term === "暴力内容")).toBe(true);
    expect(searches.some((s) => s.term === "正常搜索词")).toBe(true);
  });

  it("应该限制最大条目数", async () => {
    await service.clearHotSearches();
    for (let i = 0; i < 60; i++) {
      await service.recordSearch(`测试词${i}`);
    }
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.length).toBeLessThanOrEqual(30);
  });

  it("应该按分数排序", async () => {
    await service.clearHotSearches();
    await service.recordSearch("高分词");
    await service.recordSearch("高分词");
    await service.recordSearch("高分词");
    await service.recordSearch("低分词");
    await service.flush();

    const searches = await service.getHotSearches(10);
    expect(searches[0].term).toBe("高分词");
    expect(searches[0].score).toBeCloseTo(3, 5);
    expect(searches[1].term).toBe("低分词");
    expect(searches[1].score).toBeCloseTo(1, 5);
  });

  it("应该处理空搜索词", async () => {
    await service.clearHotSearches();
    await service.recordSearch("");
    await service.recordSearch("   ");
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.length).toBe(0);
  });

  it("超长搜索词现在允许记录（2026-08-22 用户拍板：不限制搜索内容）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("a".repeat(101));
    await service.flush();

    const searches = await service.getHotSearches(100);
    expect(searches.some((s) => s.term === "a".repeat(101))).toBe(true);
  });

  it("应该返回今日随机热搜词（service 层转发冒烟）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("随机词A");
    await service.recordSearch("随机词B");
    await service.flush();

    const searches = await service.getRandomHotSearches(10);
    expect(searches.length).toBeLessThanOrEqual(10);
    for (const s of searches) {
      expect(typeof s.term).toBe("string");
      expect(s.term.length).toBeGreaterThan(0);
    }
  });

  it("应该返回历史累计搜索总次数（service 层转发冒烟）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("总量词A");
    await service.recordSearch("总量词A");
    await service.recordSearch("总量词B");
    await service.flush();

    const total = await service.getTotalSearches();
    // 词A count=2 + 词B count=1 = 3
    expect(total).toBe(3);
  });

  it("flush 时按日期精确聚合写入 daily_searches（部署起计数）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("日词A");
    await service.recordSearch("日词A");
    await service.recordSearch("日词B");
    await service.flush();

    const today = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayKey = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;

    // 今日精确次数：词A 2 次 + 词B 1 次 = 3
    expect(await service.getDailySearches(todayKey)).toBe(3);
  });

  it("getCalendar 分离返回每天的词数与次数（2026-08-30 用户拍板，不再混用）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("历词A");
    await service.recordSearch("历词A");
    await service.recordSearch("历词B");
    await service.flush();

    const today = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayKey = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;

    const calendar = await service.getCalendar(3);
    const todayRow = calendar.find((d) => d.date === todayKey);
    expect(todayRow).toBeDefined();
    // 词数：历词A / 历词B 共 2 个词（search_terms 口径）
    expect(todayRow!.count).toBe(2);
    // 次数：2 + 1 = 3 次搜索（daily_searches 口径），两者独立不覆盖
    expect(todayRow!.searches).toBe(3);

    // 早期无次数记录的天：searches 为 null（不得拿词数冒充次数）
    const earlyRow = calendar[0];
    expect(earlyRow.date).not.toBe(todayKey);
    expect(earlyRow.searches).toBeNull();
    expect(earlyRow.count).toBe(0);
  });

  it("getCalendarMeta 一次返回总词数/总次数/有记录天数", async () => {
    await service.clearHotSearches();
    await service.recordSearch("页头词A");
    await service.recordSearch("页头词A");
    await service.recordSearch("页头词B");
    await service.flush();

    const meta = await service.getCalendarMeta();
    expect(meta.totalTerms).toBe(2);
    expect(meta.totalSearches).toBe(3);
    expect(meta.dailyDayCount).toBeGreaterThan(0);
  });

  it("应该返回词库累计词数（service 层转发冒烟）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("词数A");
    await service.recordSearch("词数B");
    await service.recordSearch("词数A"); // 同词合并
    await service.flush();

    expect(await service.getTotalTerms()).toBe(2);
  });
});

describe("HotSearchService 读缓存", () => {
  let service: HotSearchService;
  let resetHotSearchService: () => void;

  beforeAll(async () => {
    process.env.TURSO_URL = "file::memory:";
    delete process.env.TURSO_AUTH_TOKEN;
    const mod = await import("../../server/core/services/hotSearchService");
    resetHotSearchService = mod.resetHotSearchService;
    service = mod.getOrCreateHotSearchService();
    await service.clearHotSearches();
  });

  afterAll(() => {
    resetHotSearchService();
    delete process.env.TURSO_URL;
  });

  it("首次读取查库并写入缓存，TTL 内重复读取命中（不再查库）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("缓存词A");
    await service.flush();

    // 首次读取：缓存 miss → 查库 → 写入缓存
    const first = await service.getHotSearches(10);
    expect(first.some((s) => s.term === "缓存词A")).toBe(true);
    const cacheAfterFirst = (service as any).readCache as Map<string, { value: unknown; expires: number }>;
    expect(cacheAfterFirst.has("hot:10")).toBe(true);

    // 二次读取：TTL 内命中缓存，缓存条目数不增加（未再查库）
    const cacheSizeBefore = cacheAfterFirst.size;
    const second = await service.getHotSearches(10);
    expect(second).toEqual(first);
    expect(cacheAfterFirst.size).toBe(cacheSizeBefore);
    expect(cacheAfterFirst.get("hot:10")).toBeDefined();
  });

  it("词云随机抽样同样走缓存（60s 内结果稳定）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("词云缓存词");
    await service.flush();

    const a = await service.getRandomHotSearches(25);
    const cache = (service as any).readCache as Map<string, unknown>;
    expect(cache.has("random:25")).toBe(true);
    const b = await service.getRandomHotSearches(25);
    expect(b).toEqual(a);
  });

  it("不同 limit 共享同一份候选池缓存（2026-09-01：首页 limit=5/25 只打一次库）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("共享池词");
    await service.flush();

    // 先以 limit=25 填充 canonical 池缓存
    const pool = await service.getRandomHotSearches(25);
    expect(((service as any).readCache as Map<string, unknown>).has("random:25")).toBe(true);

    // 再以更小的 limit 读取：命中同一缓存键，不产生新键、结果为池的切片
    const cacheSizeBefore = ((service as any).readCache as Map<string, unknown>).size;
    const five = await service.getRandomHotSearches(5);
    expect(((service as any).readCache as Map<string, unknown>).size).toBe(cacheSizeBefore);
    expect(five.length).toBeLessThanOrEqual(5);
    for (const item of five) {
      expect(pool.some((p) => p.term === item.term)).toBe(true);
    }
  });

  it("getHomeYesterdayData 返回昨日结算数据并按昨日键缓存（每天只读一次）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("今日词A");
    await service.recordSearch("今日词A");
    await service.recordSearch("今日词B");
    await service.flush();

    const cache = (service as any).readCache as Map<string, { value: unknown; expires: number }>;
    cache.clear();

    const data = await service.getHomeYesterdayData(10);
    // 昨日（无数据）→ 词数 0、词池空；但今日的搜索不会算进昨日
    expect(data.yesterdayTerms).toBe(0);
    expect(data.yesterdaySearches).toBe(0);
    expect(data.wordPool).toEqual([]);
    // 累计值仍来自 stats_meta 计数器：今日词 A(2)+B(1)=3 次、2 词
    expect(data.totalSearches).toBe(3);
    expect(data.totalTerms).toBe(2);

    // 缓存按 "home_yesterday:{昨日日期}" 写入
    const yesterdayKey = formatDateKey(Date.now() - 86400000);
    expect(cache.has(`home_yesterday:${yesterdayKey}`)).toBe(true);
  });

  it("deleteHotSearch 后读缓存立即失效（被删词不再出现）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("待删缓存词");
    await service.flush();

    // 先读一次填充缓存
    const before = await service.getHotSearches(50);
    expect(before.some((s) => s.term === "待删缓存词")).toBe(true);
    expect(((service as any).readCache as Map<string, unknown>).size).toBeGreaterThan(0);

    // 删除后缓存清空，再读走查库 → 不含被删词
    await service.deleteHotSearch("待删缓存词");
    expect(((service as any).readCache as Map<string, unknown>).size).toBe(0);
    const after = await service.getHotSearches(50);
    expect(after.some((s) => s.term === "待删缓存词")).toBe(false);
  });

  it("clearHotSearches 清空读缓存", async () => {
    await service.clearHotSearches();
    await service.recordSearch("清空缓存词");
    await service.flush();
    await service.getHotSearches(10); // 填充缓存
    expect(((service as any).readCache as Map<string, unknown>).size).toBeGreaterThan(0);

    await service.clearHotSearches();
    expect(((service as any).readCache as Map<string, unknown>).size).toBe(0);
  });

  it("flush 不再清任何读缓存（2026-09-01：TTL 自然刷新，避免 60s flush 打穿 5min TTL）", async () => {
    await service.clearHotSearches();
    await service.recordSearch("flush前词");
    await service.flush(); // flush 后缓存空

    // 填充三类缓存：日期聚合(calendar/day/daily) + 首页(hot/random)
    await service.getCalendar(30);
    await service.getDayItems("2026-08-25");
    await service.getDailySearches("2026-08-25");
    await service.getHotSearches(10);
    await service.getRandomHotSearches(25);
    const cache = (service as any).readCache as Map<string, unknown>;
    expect(cache.has("calendar:30")).toBe(true);
    expect(cache.has("day:2026-08-25")).toBe(true);
    expect(cache.has("daily:2026-08-25")).toBe(true);
    expect(cache.has("hot:10")).toBe(true);
    expect(cache.has("random:25")).toBe(true);

    // 新搜索再次 flush：所有读缓存保留，交给 TTL 过期自然刷新
    await service.recordSearch("flush后新词");
    await service.flush();
    expect(cache.has("calendar:30")).toBe(true);
    expect(cache.has("day:2026-08-25")).toBe(true);
    expect(cache.has("daily:2026-08-25")).toBe(true);
    expect(cache.has("hot:10")).toBe(true);
    expect(cache.has("random:25")).toBe(true);
  });

  it("缓存未命中瞬间的并发请求只查库一次（in-flight 去重防缓存击穿）", async () => {
    await service.clearHotSearches();
    // 清空读缓存后用慢速假 store 模拟冷启动查库，统计真实调用次数
    ((service as any).readCache as Map<string, unknown>).clear();
    const store = (service as any).store;
    let calls = 0;
    const original = store.getHotSearches.bind(store);
    store.getHotSearches = async (limit: number) => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return original(limit);
    };
    try {
      // 缓存已空（clearHotSearches 只清 service 缓存），3 个并发同时未命中
      const [a, b, c] = await Promise.all([
        service.getHotSearches(10),
        service.getHotSearches(10),
        service.getHotSearches(10),
      ]);
      expect(calls).toBe(1); // 3 个并发复用同一 fetch Promise
      expect(a).toEqual(b);
      expect(b).toEqual(c);
    } finally {
      store.getHotSearches = original;
    }
  });
});
