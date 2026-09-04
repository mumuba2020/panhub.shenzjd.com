/**
 * TursoSearchLogStore 单元测试（2026-08-25 新增）
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL：
 * - logSearch 写入 openid/ip/term/created_at 明细
 * - 长期保留策略（用户拍板）：默认不自动清理；pruneExpired 仅在
 *   显式调用时删除超过保留期的数据（默认 90 天，未来撑不住时启用）
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoSearchLogStore } from "../../server/core/services/tursoSearchLogStore";
import { formatDateKey, beijingDayStart } from "../../server/core/services/hotSearchUtils";

describe("TursoSearchLogStore", () => {
  let store: TursoSearchLogStore;

  beforeEach(async () => {
    store = new TursoSearchLogStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  it("logSearch 写入 openid/ip/term/created_at 明细", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "openid-abc", ip: "1.2.3.4", term: "霸王别姬", now });

    const rows = (
      await (store as any).client.execute(
        "SELECT openid, ip, term, created_at FROM search_log"
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].openid).toBe("openid-abc");
    expect(rows[0].ip).toBe("1.2.3.4");
    expect(rows[0].term).toBe("霸王别姬");
    expect(rows[0].created_at).toBe(now);
  });

  it("未登录请求 openid 空串，仅记 ip+term", async () => {
    await store.logSearch({ ip: "9.9.9.9", term: "使徒行者" });
    const rows = (
      await (store as any).client.execute("SELECT openid FROM search_log")
    ).rows;
    expect(rows[0].openid).toBe("");
  });

  it("长期保留：90 天内数据不被 pruneExpired 默认清理", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 60 天前的数据（在默认 90 天保留期内）
    await store.logSearch({ openid: "o1", term: "老词", now: now - 60 * day });
    // 今天的数据
    await store.logSearch({ openid: "o2", term: "新词", now });

    const pruned = await store.pruneExpired(now); // 默认 90 天
    expect(pruned).toBe(0); // 60 天 < 90 天，不删

    const rows = (
      await (store as any).client.execute("SELECT COUNT(*) AS c FROM search_log")
    ).rows;
    expect(rows[0].c).toBe(2);
  });

  it("pruneExpired 显式短保留期可清理旧数据（未来撑不住时启用）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    await store.logSearch({ openid: "o1", term: "老词", now: now - 200 * day });
    await store.logSearch({ openid: "o2", term: "新词", now });

    const pruned = await store.pruneExpired(now, 90 * day);
    expect(pruned).toBe(1); // 只删 200 天前的

    const rows = (
      await (store as any).client.execute("SELECT term FROM search_log")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].term).toBe("新词");
  });

  it("getDayTopTerms：某天每词次数按降序（当天热词榜）", async () => {
    const dayStart = 1_700_000_000_000;
    const dayEnd = dayStart + 86400000;
    await store.logSearch({ term: "霸王别姬", now: dayStart + 1000 });
    await store.logSearch({ term: "霸王别姬", now: dayStart + 2000 });
    await store.logSearch({ term: "霸王别姬", now: dayStart + 3000 });
    await store.logSearch({ term: "使徒行者", now: dayStart + 4000 });
    await store.logSearch({ term: "长津湖", now: dayStart + 5000 });
    // 跨天数据（不应计入）
    await store.logSearch({ term: "昨天的词", now: dayStart - 1000 });

    const top = await store.getDayTopTerms(dayStart, dayEnd, 10);
    expect(top).toEqual([
      { term: "霸王别姬", count: 3 },
      { term: "使徒行者", count: 1 },
      { term: "长津湖", count: 1 },
    ]);
  });

  it("getRandomDayTerms：只返回当天词（带次数）", async () => {
    const dayStart = 1_700_000_000_000;
    const dayEnd = dayStart + 86400000;
    await store.logSearch({ term: "今天词A", now: dayStart + 1000 });
    await store.logSearch({ term: "今天词B", now: dayStart + 2000 });
    await store.logSearch({ term: "昨天词C", now: dayStart - 1000 });

    const rand = await store.getRandomDayTerms(dayStart, dayEnd, 10);
    const terms = rand.map((t) => t.term).sort();
    expect(terms).toEqual(["今天词A", "今天词B"]);
    expect(rand.every((t) => t.count >= 1)).toBe(true);
  });

  it("getDaySummaries：补全连续 N 天序列，每天词数与 top3", async () => {
    const dayMs = 86400000;
    // 以"真实今天"（北京 0 点）为基准，保证 SQL 的 date() 分组与
    // store 内部 Date.now() 补序列在同一时间轴上
    const todayStart = beijingDayStart(formatDateKey(Date.now()));
    const now = todayStart + 3600_000;
    // 今天：3 个词（霸王别姬 2 次排第一）
    await store.logSearch({ term: "霸王别姬", now });
    await store.logSearch({ term: "霸王别姬", now });
    await store.logSearch({ term: "使徒行者", now });
    await store.logSearch({ term: "长津湖", now });
    // 昨天：1 个词
    await store.logSearch({ term: "昨天的词", now: todayStart - dayMs + 1000 });

    const days = await store.getDaySummaries(todayStart - 2 * dayMs, 3);
    expect(days).toHaveLength(3);
    // 前天无数据（不编造）
    expect(days[0].count).toBe(0);
    expect(days[0].top).toEqual([]);
    // 昨天 1 词
    expect(days[1].count).toBe(1);
    expect(days[1].top).toEqual(["昨天的词"]);
    // 今天 3 词，top1 是霸王别姬（次数最多）
    expect(days[2].count).toBe(3);
    expect(days[2].top[0]).toBe("霸王别姬");
  });

  it("searchByOpenid：某 openid 的搜索记录（时间倒序）", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-abc", ip: "1.1.1.1", term: "霸王别姬", now: now + 3000 });
    await store.logSearch({ openid: "o-abc", ip: "2.2.2.2", term: "使徒行者", now: now + 1000 });
    await store.logSearch({ openid: "o-xyz", ip: "3.3.3.3", term: "长津湖", now: now + 2000 });

    const items = await store.searchByOpenid("o-abc", 50);
    expect(items).toHaveLength(2);
    // 时间倒序：霸王别姬（now+3000）在前
    expect(items[0].term).toBe("霸王别姬");
    expect(items[0].ip).toBe("1.1.1.1");
    expect(items[1].term).toBe("使徒行者");
  });

  it("searchByOpenid 带 since 只返回该时间点之后", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-abc", term: "老词", now: now - 1000 });
    await store.logSearch({ openid: "o-abc", term: "新词", now: now + 1000 });

    const items = await store.searchByOpenid("o-abc", 50, now);
    expect(items).toHaveLength(1);
    expect(items[0].term).toBe("新词");
  });

  it("searchByTerm：搜过某词的所有 openid/ip", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-1", ip: "1.1.1.1", term: "霸王别姬", now: now + 1000 });
    await store.logSearch({ openid: "o-2", ip: "2.2.2.2", term: "霸王别姬", now: now + 2000 });
    await store.logSearch({ openid: "o-3", ip: "3.3.3.3", term: "使徒行者", now: now + 3000 });

    const items = await store.searchByTerm("霸王别姬", 50);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.openid).sort()).toEqual(["o-1", "o-2"]);
    expect(items.every((i) => i.ip !== "")).toBe(true);
  });

  it("searchByIp：某 IP 的所有搜索记录（时间倒序）", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-1", ip: "9.9.9.9", term: "花开锦绣", now: now + 3000 });
    await store.logSearch({ openid: "o-2", ip: "9.9.9.9", term: "凡人修仙传", now: now + 1000 });
    await store.logSearch({ openid: "o-3", ip: "8.8.8.8", term: "别的词", now: now + 2000 });

    const items = await store.searchByIp("9.9.9.9", 50);
    expect(items).toHaveLength(2);
    // 时间倒序：花开锦绣（now+3000）在前
    expect(items[0].term).toBe("花开锦绣");
    expect(items[0].openid).toBe("o-1");
    expect(items[1].term).toBe("凡人修仙传");
  });

  it("getOverviewStats：今日搜索数/去重词数 + 近 N 天趋势 + TOP 词", async () => {
    // 以真实"今天"（北京 0 点）为基准，避免时区差异导致 todayStart 判定偏差
    const todayStart = beijingDayStart(formatDateKey(Date.now()));
    const dayMs = 86400000;
    const diag = todayStart + 3600_000; // 今天内
    // 今天：花开锦绣 2 次 + 凡人修仙传 1 次 = 3 条，2 个词
    await store.logSearch({ term: "花开锦绣", now: diag });
    await store.logSearch({ term: "花开锦绣", now: diag + 1000 });
    await store.logSearch({ term: "凡人修仙传", now: diag + 2000 });
    // 昨天：1 条不同词
    await store.logSearch({ term: "昨天的词", now: todayStart - dayMs + 1000 });
    // 8 天前（不在最近 7 天窗口内）
    await store.logSearch({ term: "更老的词", now: todayStart - 8 * dayMs + 1000 });

    const stats = await store.getOverviewStats(7, 10);
    expect(stats.todayCount).toBe(3);
    expect(stats.todayTerms).toBe(2);
    expect(stats.trend).toHaveLength(7);
    // 最后一天（今天）计数 3
    expect(stats.trend[6].count).toBe(3);
    // 昨天计数 1；更老的不在窗口，趋势里不应出现
    expect(stats.trend[5].count).toBe(1);
    // TOP 词：花开锦绣 2 次第一
    expect(stats.topTerms[0]).toEqual({ term: "花开锦绣", count: 2 });
    expect(stats.topTerms[1]).toEqual({ term: "凡人修仙传", count: 1 });
  });

  it("searchByXxx 支持 offset 分页（配合 countSearch 算总量）", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-p", ip: "1.1.1.1", term: "词1", now: now + 1000 });
    await store.logSearch({ openid: "o-p", ip: "1.1.1.1", term: "词2", now: now + 2000 });
    await store.logSearch({ openid: "o-p", ip: "1.1.1.1", term: "词3", now: now + 3000 });

    // 不带 offset：取前 2 条（时间倒序：词3、词2）
    const first = await store.searchByOpenid("o-p", 2, undefined, 0);
    expect(first.map((i) => i.term)).toEqual(["词3", "词2"]);
    // offset=2：取剩余 1 条（词1）
    const second = await store.searchByOpenid("o-p", 2, undefined, 2);
    expect(second.map((i) => i.term)).toEqual(["词1"]);
    // 总量
    expect(await store.countSearch("openid", "o-p")).toBe(3);

    // term 分页
    await store.logSearch({ openid: "o-q", ip: "9.9.9.9", term: "词2", now: now + 1000 });
    const termPage = await store.searchByTerm("词2", 1, undefined, 1);
    expect(termPage).toHaveLength(1);
    expect(await store.countSearch("term", "词2")).toBe(2);

    // ip 分页
    const ipAll = await store.searchByIp("1.1.1.1", 50);
    expect(ipAll).toHaveLength(3);
    expect(await store.countSearch("ip", "1.1.1.1")).toBe(3);
  });

  it("countSearch 支持 since 过滤", async () => {
    const now = 1_700_000_000_000;
    await store.logSearch({ openid: "o-c", term: "旧", now: now - 1000 });
    await store.logSearch({ openid: "o-c", term: "新", now: now + 1000 });
    expect(await store.countSearch("openid", "o-c", now)).toBe(1); // 只统计 now 之后
  });
});
