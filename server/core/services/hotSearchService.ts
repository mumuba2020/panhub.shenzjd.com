import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * 写聚合缓冲配置
 * - FLUSH_MAX_PENDING：缓冲内不同词数达到该值立即落盘（请求内同步，Worker 可靠）
 * - FLUSH_INTERVAL_MS：兜底定时落盘（Node/Docker 可靠；Worker 空闲回收时可能丢失未落盘增量，
 *   热搜为尽力而为数据，可接受）。2026-08-24：3s → 60s，降低数据库写往返频次
 *   （可被环境变量 HOT_SEARCH_FLUSH_INTERVAL_MS 覆盖）
 */
const FLUSH_MAX_PENDING = 100;
const FLUSH_INTERVAL_MS =
  Number(process.env.HOT_SEARCH_FLUSH_INTERVAL_MS) || 60_000;

/**
 * 读缓存 TTL（2026-08-24 新增：热搜读接口不再每次请求都查库）
 * - READ_TTL_FAST：词云/榜单等高频且实时性要求中的接口
 * - READ_TTL_SLOW：日历/统计等低频变化的历史聚合数据
 * 2026-09-01 起 flush 不再清读缓存（原每次 flush 清 calendar:/day:/daily:，
 * 活跃站点 60s flush 一次导致 5min TTL 形同虚设），所有读缓存一律 TTL 过期
 * 自然刷新；仅 delete/clear 等管理操作清全部缓存保证立即生效。
 */
const READ_TTL_FAST_MS = Number(process.env.HOT_SEARCH_READ_TTL_MS) || 60_000;
const READ_TTL_SLOW_MS = 5 * 60_000;
/**
 * 首页"昨日结算数据"日缓存 TTL（2026-09-03 用户拍板：单 Docker 场景下
 * 大幅削减 Turso 读配额）。首页统计带/词云展示"昨天"的最终态数字与词池，
 * 昨天数据恒定不变，故缓存 key 拼上昨日日期 + 25h TTL → 每个数字每天只读
 * 一次库（今日首次访问触发），跨天自然因 key 变化而刷新，无定时器依赖。
 */
const HOME_DAY_CACHE_TTL_MS = 25 * 60 * 60_000;
/** 读缓存容量上限（防内存无限增长，超限先清过期条目） */
const READ_CACHE_MAX = 500;

/** 单个词的待落盘增量（同词多次搜索合并为一次 delta 写入） */
interface PendingTerm {
  delta: number;
  lastAt: number;
}

/** 读缓存条目 */
interface ReadCacheEntry {
  value: unknown;
  expires: number;
}

/**
 * 热搜存储：唯一真源 Turso（libSQL，HTTP 驱动，Worker/Docker/本地通用）。
 * 无回退链：未配置 TURSO_URL 时热搜功能不可用（明确报错，不静默降级）。
 */
export class HotSearchService {
  private store: IHotSearchStore | null = null;
  private storeType: "turso" | "unavailable" = "unavailable";
  private initPromise: Promise<void> | null = null;
  private initFailedLogged = false;
  private summaryLogged = false;
  /** 待落盘增量缓冲（同词多次搜索合并） */
  private pending = new Map<string, PendingTerm>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /** 读缓存（方法+参数 → 结果，TTL 过期自动刷新） */
  private readCache = new Map<string, ReadCacheEntry>();
  /** in-flight 去重：同 key 并发未命中复用同一 fetch Promise（防缓存击穿） */
  private inflightFetches = new Map<string, Promise<unknown>>();

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { createTursoHotSearchStore } = await import("./tursoHotSearchStore");
      const store = createTursoHotSearchStore();
      await (store as any)["waitForInit"]?.();
      this.store = store;
      this.storeType = "turso";
      console.log("[HotSearchService] ✅ 使用 Turso 存储模式");
    } catch (err) {
      console.log(
        "[HotSearchService] ❌ Turso 初始化失败:",
        err instanceof Error ? err.message : err
      );
      console.log(
        "[HotSearchService] 热搜功能不可用。请配置 TURSO_URL / TURSO_AUTH_TOKEN（Worker 用 wrangler secret，Docker 用 .env）"
      );
    }
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (!this.store && !this.initFailedLogged) {
      this.initFailedLogged = true;
      console.log("[HotSearchService] ⚠️ 热搜存储未就绪（TURSO_URL 未配置），相关接口将返回错误");
    }
  }

  /** 获取可用 store；未配置 Turso 时抛错（调用方转 500，前端提示配置） */
  private requireStore(): IHotSearchStore {
    if (!this.store) {
      throw new Error("热搜存储未配置：请设置环境变量 TURSO_URL / TURSO_AUTH_TOKEN");
    }
    return this.store;
  }

  /**
   * 读缓存包装（2026-08-24）：TTL 内命中直接返回，避免每次请求查库。
   * 容量保护：超上限时先清过期条目，仍超则淘汰最旧一条（防止缓存无限膨胀）。
   *
   * 2026-09-03 新增 in-flight 去重（防缓存击穿）：TTL 到期瞬间并发请求
   * 都会未命中，各自 fetcher 同时查库（CF Worker 冷启动 isolate 频繁回收
   * 场景下更明显）。现同 key 并发复用同一个 Promise，N 个并发只查库 1 次。
   */
  private async getCached<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const hit = this.readCache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value as T;
    }
    const inflight = this.inflightFetches.get(key);
    if (inflight) return (await inflight) as T;

    const p = (async () => {
      const value = await fetcher();
      if (this.readCache.size >= READ_CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of this.readCache) {
          if (v.expires <= now) this.readCache.delete(k);
        }
        if (this.readCache.size >= READ_CACHE_MAX) {
          // 仍满：淘汰最早过期的一条（Map 按插入序迭代）
          const oldestKey = this.readCache.keys().next().value as string | undefined;
          if (oldestKey) this.readCache.delete(oldestKey);
        }
      }
      this.readCache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })();
    this.inflightFetches.set(key, p);
    try {
      return await p;
    } finally {
      this.inflightFetches.delete(key);
    }
  }

  /** 清空全部读缓存（delete/clear 后调用，保证删后立即可见） */
  private clearReadCache(): void {
    this.readCache.clear();
  }

  /**
   * 热搜存储是否已就绪（Turso 已配置且初始化成功）。
   * 未配置时各 GET 接口返回空数据（不报错），页面表现为"没有热搜"。
   */
  async isReady(): Promise<boolean> {
    await this.waitForInit();
    return !!this.store;
  }

  async recordSearch(term: string): Promise<void> {
    // 写路径：先规范化，累积进内存缓冲，达到阈值或定时器批量落盘。
    // 不保证写后立即可读（读为随机词云/榜单，实时性要求低）。
    const normalized = normalize(term);
    if (!normalized) return;

    const now = Date.now();
    const cur = this.pending.get(normalized);
    if (cur) {
      cur.delta += 1;
      cur.lastAt = now;
    } else {
      this.pending.set(normalized, { delta: 1, lastAt: now });
    }

    if (this.pending.size >= FLUSH_MAX_PENDING) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * 将缓冲中的增量批量落盘到 store（同词合并为一次 delta 写入）。
   * 并发安全：flush 进行中时复用同一 Promise；期间新的 recordSearch 进入新的缓冲。
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0) return;

    const snapshot = this.pending;
    this.pending = new Map();
    this.clearFlushTimer();

    this.flushing = (async () => {
      await this.waitForInit();
      const store = this.store;
      if (!store) return; // 未配置 Turso：静默丢弃缓冲（热搜尽力而为），错误已在 waitForInit 记录一次
      // 按日期聚合增量（daily_searches 精确计数：从部署起每天一次 upsert，写放大极小）
      const dailyDelta = new Map<string, number>();
      for (const [, p] of snapshot) {
        const day = formatDateKey(p.lastAt);
        dailyDelta.set(day, (dailyDelta.get(day) ?? 0) + p.delta);
      }
      // 2026-09-01 优化：词表与每日次数各一次 batch 往返（原逐词 await，
      // 100 词的 flush = 100+ 次 HTTP 往返）
      // 2026-09-03 优化读量：recordSearchBatch 返回本批新增词数，
      // recordDailySearchesBatch 同批累计 total_searches——两个计数器
      // 让 getCalendarMeta 只读几行，不再全表 COUNT(*)/SUM(count)
      const newTerms = await store.recordSearchBatch(
        [...snapshot.entries()].map(([term, p]) => ({
          term,
          lastAt: p.lastAt,
          delta: p.delta,
        }))
      );
      const counterWrites: Promise<void>[] = [
        store.recordDailySearchesBatch(
          [...dailyDelta.entries()].map(([date, delta]) => ({ date, delta }))
        ),
      ];
      if (newTerms > 0) counterWrites.push(store.incrementTotalTerms(newTerms));
      await Promise.all(counterWrites);
      // 2026-09-01 优化：flush 不再清任何读缓存，全部交给 TTL 过期自然刷新。
      // 原实现每次 flush 清 calendar/day/daily 缓存，活跃站点 60s flush 一次，
      // hot 页 5min TTL 形同虚设、几乎每次进页都真查库；不清后页头/列表/日历
      // 在 TTL 内一致老化，口径仍互相一致，只是最多滞后一个 TTL（5min）。
    })()
      .catch((err) => {
        console.log(
          "[HotSearchService] flush 失败:",
          err instanceof Error ? err.message : err
        );
      })
      .finally(() => {
        this.flushing = null;
      });

    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Node 下 unref，避免定时器阻止进程退出；CF Worker 无此方法则忽略
    const t = this.flushTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async getHotSearches(limit: number = 30): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const items = await this.getCached(`hot:${limit}`, READ_TTL_FAST_MS, () =>
      this.requireStore().getHotSearches(limit)
    );
    // 启动后首次读取时输出榜单摘要，便于线上观测（只打一次，避免刷日志）
    if (!this.summaryLogged) {
      this.summaryLogged = true;
      loggers.hotSearch.info("热搜榜单摘要", {
        total: items.length,
        top5: items.slice(0, 5).map((i) => ({
          term: i.term,
          score: Math.round((i.displayScore ?? i.score) * 100) / 100,
        })),
      });
    }
    return items;
  }

  /**
   * 今日热搜词池随机抽样（首页词云展示用；TTL 内缓存同一批词，60s 刷新）
   *
   * 2026-08-25 用户拍板：词云/词列表的"今天"用 search_terms today 活跃词
   * （last_at 在今天 + count desc）作为主源，**保持丰满**（今天 ~350 个
   * 活跃词）。search_log 上线当天去重仅 45 词，用于主页词云太稀。
   *
   * 2026-09-01 优化：首页两个组件分别以 limit=25（词云）和 limit=5（空状态
   * 热词）调用本方法，若缓存 key 按 limit 区分会同一页面打两次库。现统一
   * 缓存一份 canonical 候选池（25 条，即最大调用方），各调用方按需切片，
   * 同一 TTL 窗口内无论多少种 limit 都只查一次库。
   *
   * 后续：search_log 攒满一周后，再把 hover 次数切到 search_log 当天精确次数
   * （getDayItems 同步）。search_log 的明细仍只用于管理页排查，不参与展示主源。
   * search_terms 仍服务 sitemap 选词（getTopTerms）。
   */
  async getRandomHotSearches(limit: number = 25): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const canonical = Math.max(25, limit);
    const pool = await this.getCached(`random:${canonical}`, READ_TTL_FAST_MS, () =>
      this.requireStore().getRandomHotSearches(canonical)
    );
    return pool.slice(0, limit);
  }

  /**
   * 首页"昨日结算数据"（2026-09-03 用户拍板：压减 Turso 读配额到每天一次）
   *
   * 首页词云 + 统计带改为展示**昨天**的最终态数据（昨天已结束，值恒定，
   * 与"今天实时涨"的旧口径不同），配合日期键缓存可做到：今日首次访问触发
   * 一次查库，此后一整天命中内存缓存，跨天 key 变化自动刷新——**每个数字
   * 每天只读一次库**，无需定时器，单 Docker 常驻下对读配额几乎零消耗。
   *
   * 返回（一次 fetch 内并发取齐，避免多次往返）：
   * - yesterdayTerms   ：昨日被搜索过的去重词数（昨日词云词池大小）
   * - yesterdaySearches：昨日真实搜索次数（daily_searches 精确记录，未记录为 0）
   * - wordPool         ：昨日被搜词池（作为首页词云候选，随机取若干展示）
   * - totalSearches / totalTerms：累计值（源自 stats_meta 计数器，几行读）
   */
  async getHomeYesterdayData(limit = 100): Promise<{
    yesterdayTerms: number;
    yesterdaySearches: number;
    totalSearches: number;
    totalTerms: number;
    wordPool: { term: string; count: number }[];
  }> {
    await this.waitForInit();
    // 昨日日期键（北京时间）；缓存 key 带它 → 每天自然只查一次。
    // limit 只影响返回切片，不影响缓存内容（fetch 每次缓存满 100 词池，
    // 由各调用方按需 slice），保证 hot-stats / hot-searches 共享同一缓存。
    const yesterday = formatDateKey(Date.now() - 86400000);
    const safe = Math.min(Math.max(1, limit), 100);
    const poolSize = 100; // 缓存始终备足 100，供词云按 limit 切片
    const cached = await this.getCached(`home_yesterday:${yesterday}`, HOME_DAY_CACHE_TTL_MS, async () => {
      const store = this.requireStore();
      // 并发取齐（getDayItems 昨日全量词单 / getDailySearches 昨日次数 /
      // getCalendarMeta 累计计数）。词单为昨日最终态，行数=昨日词数，
      // 一天一次读取，读配额可忽略。
      const [dayItems, searches, meta] = await Promise.all([
        store.getDayItems(yesterday),
        store.getDailySearches(yesterday),
        store.getCalendarMeta(),
      ]);
      // 词云候选池：昨日词先随机打散再取前 poolSize 个（词云随机展示语义），
      // 每日首次触发随机一次并缓存一整天，跨天 key 变化再重新随机。
      const shuffled = dayItems.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const wordPool = shuffled.slice(0, poolSize).map((it) => ({
        term: it.term,
        count: it.count,
      }));
      return {
        yesterdayTerms: dayItems.length,
        yesterdaySearches: searches,
        totalSearches: meta.totalSearches,
        totalTerms: meta.totalTerms,
        wordPool,
      };
    });
    return {
      yesterdayTerms: cached.yesterdayTerms,
      yesterdaySearches: cached.yesterdaySearches,
      totalSearches: cached.totalSearches,
      totalTerms: cached.totalTerms,
      wordPool: cached.wordPool.slice(0, safe),
    };
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    // 等当前 flush 完成，避免清空后仍在写的 flush 把旧数据写回
    if (this.flushing) await this.flushing;
    // 丢弃未落盘增量后清空，避免清空后缓冲又写回旧数据
    this.pending.clear();
    this.clearFlushTimer();
    await this.waitForInit();
    const result = await this.requireStore().clearHotSearches();
    // 清空后读缓存立即失效，避免旧榜单继续展示
    this.clearReadCache();
    return result;
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    // 先落盘缓冲（含待删词的增量），再删除，避免删除后缓冲复活该词
    await this.flush();
    const result = await this.requireStore().deleteHotSearch(term);
    // 删除后读缓存立即失效，避免被删词继续出现在榜单/词云
    this.clearReadCache();
    return result;
  }

  async getStats(): Promise<{ total: number; topTerms: HotSearchItem[]; mode: string }> {
    await this.waitForInit();
    const stats = await this.getCached("stats", READ_TTL_FAST_MS, () =>
      this.requireStore().getStats()
    );
    return {
      ...stats,
      mode: this.storeType,
    };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    return this.getCached(`topterms:${limit}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getTopTerms(limit)
    );
  }

  /**
   * 每日榜单日历：近 N 天每天词数 + 次数 + top3（日历热力图）。
   * 2026-08-30 用户拍板：次数与词数彻底分离，不再混用——
   *   - count：当天搜索词数（search_terms 按 last_at 分组，历史全有）
   *   - searches：当天真实搜索次数（daily_searches 精确记录，2026-08-22 起；
   *     无记录为 null，前端不得拿词数冒充次数）
   * 日历格子只展示次数；词数在当日词单面板展示。
   */
  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    return this.getCached(`calendar:${days}`, READ_TTL_SLOW_MS, async () => {
      const safeDays = Math.min(Math.max(1, days), 90);
      const startTs =
        beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;
      // daily_searches 当天次数（精确，有记录的天才在 map 中）
      const dailyByDate = await this.requireStore().getDailySearchesRange(startTs, safeDays);
      // search_terms 当天词数（历史全有）
      const termDays = await this.requireStore().getCalendar(safeDays);
      return termDays.map((td) => ({
        ...td,
        searches: dailyByDate.get(td.date) ?? null,
      }));
    });
  }

  /**
   * 某天热词列表（2026-08-25 用户拍板：今天用 search_terms 活跃词为主源）
   *
   * 数据源选择：
   * - search_terms 当天活跃词（last_at 当天 + count desc）—— 主源，丰满
   * - search_log 攒满一周后，再把 hover 次数切到 search_log 当天精确次数
   *
   * 历史日期（search_log 上线 8-25 之前）天然由 search_terms last_at 过滤
   * 给出，搜索行为连续，无空白期。
   */
  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    return this.getCached(`day:${date}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getDayItems(date)
    );
  }

  async getTotalSearches(): Promise<number> {
    await this.waitForInit();
    return this.getCached("total_searches", READ_TTL_SLOW_MS, () =>
      this.requireStore().getTotalSearches()
    );
  }

  async getTotalTerms(): Promise<number> {
    await this.waitForInit();
    return this.getCached("total_terms", READ_TTL_SLOW_MS, () =>
      this.requireStore().getTotalTerms()
    );
  }

  async getDailySearches(date: string): Promise<number> {
    await this.waitForInit();
    return this.getCached(`daily:${date}`, READ_TTL_SLOW_MS, () =>
      this.requireStore().getDailySearches(date)
    );
  }

  /** 已精确记录搜索次数的天数（< 7 天时前端不展示次数，只展示词数） */
  async getDailySearchesDayCount(): Promise<number> {
    await this.waitForInit();
    return this.getCached("daily_daycount", READ_TTL_SLOW_MS, () =>
      this.requireStore().getDailySearchesDayCount()
    );
  }

  /**
   * 合并查日历页头指标（2026-08-30 扩展：totalTerms + totalSearches +
   * dailyDayCount 一次 batch 往返，避免多次打库）
   */
  async getCalendarMeta(): Promise<{
    totalTerms: number;
    totalSearches: number;
    dailyDayCount: number;
  }> {
    await this.waitForInit();
    return this.getCached("calendar_meta", READ_TTL_SLOW_MS, () =>
      this.requireStore().getCalendarMeta()
    );
  }

  getStoreType(): "turso" | "unavailable" {
    return this.storeType;
  }

  close(): void {
    this.clearFlushTimer();
    this.pending.clear();
    this.readCache.clear();
    this.inflightFetches.clear();
    this.store?.close();
  }
}

const HOT_SEARCH_SERVICE_KEY = "__panhub_hot_search_service_v3__";

export function getOrCreateHotSearchService(): HotSearchService {
  const context = (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
  if (context?.service) {
    return context.service;
  }

  const service = new HotSearchService();
  (globalThis as any)[HOT_SEARCH_SERVICE_KEY] = { service };
  return service;
}

export function resetHotSearchService(): void {
  const context = (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
  if (context?.service) {
    context.service.close();
  }
  delete (globalThis as any)[HOT_SEARCH_SERVICE_KEY];
}

export type { HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm };
