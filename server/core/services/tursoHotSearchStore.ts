import { createClient, type Client } from "@libsql/client";
import type { IHotSearchStore, HotSearchItem, HotSearchStats, TopTerm, DaySnapshot, DayTerm } from "./hotSearchStore";
import { loggers } from "../utils/logger";
import { normalize, formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * Turso 热搜存储实现（libSQL / SQLite fork，HTTP 驱动）
 *
 * 热搜唯一持久化存储（2026-08-18 起，SQLite/Memory 已移除），
 * 供迁移到 Turso 使用：Worker 与 Docker 两侧都通过 @libsql/client 走 HTTP 读写同一份数据。
 * 相比 D1 免费档（5M 行读/天、100K 行写/天），Turso Free 提供 5 亿行读/月、1000 万行写/月，
 * 且超额为软限制（继续运行、按量计费），不会直接失败。
 *
 * 配置（环境变量，缺失时构造函数抛错，由工厂回退 sqlite）：
 *   TURSO_URL           libsql://xxx.turso.io（或 file: 本地库，测试用）
 *   TURSO_AUTH_TOKEN    Turso 数据库 auth token
 */
const MAX_ENTRIES = 30;

export class TursoHotSearchStore implements IHotSearchStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoHotSearchStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoHotSearchStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS search_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)",
      // 每日搜索次数精确表（2026-08-22 用户拍板：从部署起记录，攒满一周再展示）
      `CREATE TABLE IF NOT EXISTS daily_searches (
        date TEXT PRIMARY KEY,
        searches INTEGER NOT NULL DEFAULT 0
      )`,
      // 首页统计带计数器（2026-09-03 优化读量）：total_searches/total_terms 由
      // flush 增量维护，getCalendarMeta 只读 2 行，替代每次 COUNT(*)/SUM(count)
      // 对 search_terms 的全表扫描（23k+ 行 × 每次缓存过期是读量大头）
      `CREATE TABLE IF NOT EXISTS stats_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      )`,
    ]);
    // hot_searches 表已废弃（2026-08-18）：生产 API 全部只读 search_terms，
    // 热搜写入只落 search_terms 一张表（原双表每次搜索写 2 行 → 1 行，省一半写入配额）
    console.log("[TursoHotSearchStore] ✅ Turso 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoHotSearchStore 初始化失败");
    }
  }

  async recordSearch(term: string, now: number, delta = 1): Promise<void> {
    await this.waitForInit();
    const normalized = normalize(term);
    if (!normalized) return;
    const d = Math.max(1, delta);

    // 原子 upsert（2026-08-27 优化：消除 SELECT-then-UPDATE 两段式，
    // 每次 flush 往返数减半；与 tursoBotDefenseStore.recordRejection 写法统一）
    await this.client.execute(
      `INSERT INTO search_terms (term, count, first_at, last_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET
         count = count + excluded.count,
         last_at = excluded.last_at`,
      [normalized, d, now, now]
    );
  }

  /**
   * 批量落盘一批词增量（2026-09-01 优化：flush 原来在 service 层逐词 await
   * recordSearch，100 词 = 100 次 HTTP 往返；现合并为一次 client.batch）
   *
   * 2026-09-03 优化读量：同批先对每个词做 `INSERT ... count=0 ... DO NOTHING
   * RETURNING term`（新词才会返回行），再做常规 upsert 累加 delta——
   * 新词行最终 count = 0 + delta，旧词行直接 +delta，语义不变；
   * 返回"本批新增词数"供 flush 维护 stats_meta.total_terms 计数器，
   * 替代 getCalendarMeta 里的全表 COUNT(*)。
   *
   * @returns 本批新增词数（新词的 RETURNING 行数之和）
   */
  async recordSearchBatch(
    entries: { term: string; lastAt: number; delta: number }[]
  ): Promise<number> {
    await this.waitForInit();
    const norm = entries
      .map((e) => ({ ...e, term: normalize(e.term), delta: Math.max(1, e.delta) }))
      .filter((e) => e.term);
    if (norm.length === 0) return 0;
    const stmts = norm.flatMap((e) => [
      {
        // 新词探测：count=0 占位插入，仅新词返回行（旧词 DO NOTHING）
        sql: `INSERT INTO search_terms (term, count, first_at, last_at)
              VALUES (?, 0, ?, ?)
              ON CONFLICT(term) DO NOTHING
              RETURNING term`,
        args: [e.term, e.lastAt, e.lastAt],
      },
      {
        sql: `INSERT INTO search_terms (term, count, first_at, last_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(term) DO UPDATE SET
                count = count + excluded.count,
                last_at = excluded.last_at`,
        args: [e.term, e.delta, e.lastAt, e.lastAt],
      },
    ]);
    const results = await this.client.batch(stmts);
    // 偶数位语句是新词探测（flatMap 顺序：探测、upsert、探测、upsert ...）
    let newTerms = 0;
    for (let i = 0; i < results.length; i += 2) {
      newTerms += results[i].rows.length > 0 ? 1 : 0;
    }
    return newTerms;
  }

  /**
   * 批量累加多天搜索次数（2026-09-01 优化：与 recordSearchBatch 同理，
   * 多天 daily upsert 合并为一次 client.batch）
   *
   * 2026-09-03 优化读量：同一批内顺手把总搜索次数累计进 stats_meta
   * （total_searches 计数器），getCalendarMeta 不再全表 SUM(count)。
   * 计数器在首次读取时一次性回填（见 getCalendarMeta），回填用 MAX
   * 取大，重复回填/并发回填不会把已累计的增量写丢。
   */
  async recordDailySearchesBatch(
    entries: { date: string; delta: number }[]
  ): Promise<void> {
    await this.waitForInit();
    const stmts = entries
      .filter((e) => Math.max(0, e.delta) > 0)
      .map((e) => ({
        sql: `INSERT INTO daily_searches (date, searches) VALUES (?, ?)
              ON CONFLICT(date) DO UPDATE SET searches = searches + excluded.searches`,
        args: [e.date, e.delta],
      }));
    const totalDelta = entries.reduce((s, e) => s + Math.max(0, e.delta), 0);
    if (totalDelta > 0) {
      stmts.push({
        sql: `INSERT INTO stats_meta (key, value) VALUES ('total_searches', ?)
              ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
        args: [totalDelta],
      });
    }
    if (stmts.length === 0) return;
    await this.client.batch(stmts);
  }

  /**
   * 累加词库总词数计数器（flush 检测到新词时调用，通常一次 +1~+N）。
   * 计数器行不存在时静默（说明尚未回填，后续 getCalendarMeta 回填会算准）。
   */
  async incrementTotalTerms(n: number): Promise<void> {
    if (n <= 0) return;
    await this.waitForInit();
    await this.client.execute(
      `INSERT INTO stats_meta (key, value) VALUES ('total_terms', ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      [n]
    );
  }

  /**
   * 获取热搜列表（按搜索次数降序；hot_searches 表已废弃，从 search_terms 聚合）
   * 无生产调用方，保留接口语义：count 当 score，last_at 当 lastSearched
   */
  async getHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), MAX_ENTRIES);
    const rows = (
      await this.client.execute(
        `SELECT term, count, first_at, last_at FROM search_terms
         ORDER BY count DESC, last_at DESC
         LIMIT ?`,
        [safeLimit]
      )
    ).rows;

    return rows.map((obj, index) => ({
      term: obj.term as string,
      score: obj.count as number,
      lastSearched: obj.last_at as number,
      createdAt: obj.first_at as number,
      rank: index + 1,
      displayScore: obj.count as number,
    }));
  }

  async getRandomHotSearches(limit: number): Promise<HotSearchItem[]> {
    await this.waitForInit();
    const dayStart = beijingDayStart(formatDateKey(Date.now()));
    const safeLimit = Math.min(Math.max(1, limit), 100);
    // 2026-08-27 优化：去掉 ORDER BY RANDOM() 全表扫，
    // 改为走索引 idx_search_terms_last 取候选池，内存 shuffle 后截取
    const candidateLimit = Math.min(safeLimit * 4, 400);
    const rows = (
      await this.client.execute(
        `SELECT term, count, first_at, last_at FROM search_terms
         WHERE last_at >= ?
         ORDER BY last_at DESC
         LIMIT ?`,
        [dayStart, candidateLimit]
      )
    ).rows;

    // Fisher-Yates 内存 shuffle，保证每次刷新有新鲜感
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    const picked = rows.slice(0, safeLimit);

    const out: HotSearchItem[] = [];
    for (const obj of picked) {
      out.push({
        term: obj.term as string,
        score: obj.count as number,
        lastSearched: obj.last_at as number,
        createdAt: obj.first_at as number,
        rank: out.length + 1,
        displayScore: obj.count as number,
      });
    }
    return out;
  }

  async cleanupOldEntries(maxEntries: number): Promise<void> {
    // hot_searches 表已废弃，search_terms 是全量词库（不清理），此处 no-op 保持接口兼容
  }

  async clearHotSearches(): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    // stats_meta 一并清空：下次 getCalendarMeta 回填空表得到 0/0
    await this.client.batch([
      "DELETE FROM search_terms",
      "DELETE FROM daily_searches",
      "DELETE FROM stats_meta",
    ]);
    return { success: true, message: "热搜记录已清除" };
  }

  async deleteHotSearch(term: string): Promise<{ success: boolean; message: string }> {
    await this.waitForInit();
    const before = (
      await this.client.execute(
        "SELECT COUNT(*) as c FROM search_terms WHERE term = ?",
        [term]
      )
    ).rows[0];
    const had = (before?.c ?? 0) as number;
    await this.client.execute("DELETE FROM search_terms WHERE term = ?", [term]);
    if (had > 0) {
      // 同步维护 total_terms 计数器（行不存在说明尚未回填，回填时会算准）
      await this.client.execute(
        "UPDATE stats_meta SET value = value - 1 WHERE key = 'total_terms' AND value > 0"
      );
      return { success: true, message: `热搜词 "${term}" 已删除` };
    }
    return { success: false, message: "热搜词不存在" };
  }

  async getStats(): Promise<HotSearchStats> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT COUNT(*) as c FROM search_terms")
    ).rows[0];
    const total = (row?.c ?? 0) as number;
    const topTerms = await this.getHotSearches(10);
    return { total, topTerms };
  }

  async getTopTerms(limit: number): Promise<TopTerm[]> {
    await this.waitForInit();
    const safeLimit = Math.min(Math.max(1, limit), 50000);
    const rows = (
      await this.client.execute(
        `SELECT term, count FROM search_terms
         WHERE count >= 2 AND length(term) >= 2
         ORDER BY count DESC, last_at DESC
         LIMIT ?`,
        [safeLimit]
      )
    ).rows;
    return rows.map((obj) => ({ term: obj.term as string, count: obj.count as number }));
  }

  async getCalendar(days: number): Promise<DaySnapshot[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const startTs = beijingDayStart(formatDateKey(Date.now())) - (safeDays - 1) * 86400000;

    const countRows = (
      await this.client.execute(
        `SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, COUNT(*) as c
         FROM search_terms
         WHERE last_at >= ?
         GROUP BY day`,
        [startTs]
      )
    ).rows;
    const countMap = new Map<string, number>();
    for (const row of countRows) {
      countMap.set(row.day as string, row.c as number);
    }

    const topRows = (
      await this.client.execute(
        `SELECT day, term FROM (
           SELECT date((last_at + 8*3600*1000) / 1000, 'unixepoch') as day, term, count, last_at,
                  ROW_NUMBER() OVER (PARTITION BY date((last_at + 8*3600*1000) / 1000, 'unixepoch') ORDER BY count DESC, last_at DESC) as rn
           FROM search_terms
           WHERE last_at >= ?
         ) WHERE rn <= 3`,
        [startTs]
      )
    ).rows;
    const topMap = new Map<string, string[]>();
    for (const row of topRows) {
      const day = row.day as string;
      const list = topMap.get(day) ?? [];
      if (list.length < 3) list.push(row.term as string);
      topMap.set(day, list);
    }

    const out: DaySnapshot[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * 86400000);
      out.push({
        date,
        count: countMap.get(date) ?? 0,
        // 次数不在本查询内：由 service 层用 getDailySearchesRange 合并（职责分离）
        searches: null,
        top: topMap.get(date) ?? [],
      });
    }
    return out;
  }

  async getDayItems(date: string): Promise<DayTerm[]> {
    await this.waitForInit();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const start = beijingDayStart(date);
    const end = start + 86400000;
    const rows = (
      await this.client.execute(
        `SELECT term, count, last_at FROM search_terms
         WHERE last_at >= ? AND last_at < ?
         ORDER BY count DESC, last_at DESC`,
        [start, end]
      )
    ).rows;
    return rows.map((obj, index) => ({
      term: obj.term as string,
      rank: index + 1,
      count: obj.count as number,
    }));
  }

  async getTotalSearches(): Promise<number> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT COALESCE(SUM(count), 0) as s FROM search_terms")
    ).rows[0];
    return (row?.s ?? 0) as number;
  }

  async getTotalTerms(): Promise<number> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT COUNT(*) as c FROM search_terms")
    ).rows[0];
    return (row?.c ?? 0) as number;
  }

  async recordDailySearches(date: string, delta: number): Promise<void> {
    await this.waitForInit();
    const d = Math.max(0, delta);
    if (d === 0) return;
    await this.client.execute(
      `INSERT INTO daily_searches (date, searches) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET searches = searches + excluded.searches`,
      [date, d]
    );
  }

  async getDailySearches(date: string): Promise<number> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT searches as s FROM daily_searches WHERE date = ?", [date])
    ).rows[0];
    return (row?.s ?? 0) as number;
  }

  /**
   * 范围查询 daily_searches（2026-08-25：日历"有次数显示次数"数据源）。
   * 返回 Map<date, searches>，仅含已记录的天（未记录的天不在 map 中）。
   */
  async getDailySearchesRange(startTs: number, days: number): Promise<Map<string, number>> {
    await this.waitForInit();
    const rows = await this.client.execute(
      `SELECT date, searches FROM daily_searches
       WHERE date >= ? AND date <= ?
       ORDER BY date`,
      [formatDateKey(startTs), formatDateKey(startTs + days * 86400000)]
    );
    const map = new Map<string, number>();
    for (const r of rows.rows) map.set(r.date as string, (r.searches as number) ?? 0);
    return map;
  }

  async getDailySearchesDayCount(): Promise<number> {
    await this.waitForInit();
    const row = (
      await this.client.execute("SELECT COUNT(DISTINCT date) as c FROM daily_searches")
    ).rows[0];
    return (row?.c ?? 0) as number;
  }

  /**
   * 一次读齐日历页头三件套（2026-08-30 扩展：在原 totalTerms + dailyDayCount
   * 基础上并入 SUM(count) 总搜索次数，hot-stats 一次往返拿全统计带指标）
   *
   * 2026-09-03 优化读量（读量大头修复）：totalSearches/totalTerms 改读
   * stats_meta 计数器（flush 落盘时增量维护），日常读取只有几行；
   * 计数器缺 key 时一次性回填（对 search_terms 全表 SUM/COUNT 扫一遍，
   * 仅首次或 clear 后发生）。回填用 MAX 取大写入：即使回填与 flush 增量
   * 并发，也不会把已累计的增量写丢（SUM/COUNT 本身已含增量，MAX 只增不减）。
   * dailyDayCount 仍实时聚合 daily_searches（仅十几行，代价可忽略）。
   */
  async getCalendarMeta(): Promise<{
    totalTerms: number;
    totalSearches: number;
    dailyDayCount: number;
  }> {
    await this.waitForInit();
    const counterRows = (
      await this.client.execute(
        "SELECT key, value FROM stats_meta WHERE key IN ('total_searches', 'total_terms')"
      )
    ).rows;
    let totalSearches: number | null = null;
    let totalTerms: number | null = null;
    for (const r of counterRows) {
      if (r.key === "total_searches") totalSearches = (r.value as number) ?? 0;
      else if (r.key === "total_terms") totalTerms = (r.value as number) ?? 0;
    }

    // 缺计数器 → 一次性回填（此后由 flush 增量维护，不再全表扫描）
    if (totalSearches === null) {
      const row = (
        await this.client.execute(
          "SELECT COALESCE(SUM(count), 0) as s FROM search_terms"
        )
      ).rows[0];
      totalSearches = (row?.s as number) ?? 0;
      await this.client.execute(
        `INSERT INTO stats_meta (key, value) VALUES ('total_searches', ?)
         ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
        [totalSearches]
      );
    }
    if (totalTerms === null) {
      const row = (
        await this.client.execute("SELECT COUNT(*) as c FROM search_terms")
      ).rows[0];
      totalTerms = (row?.c as number) ?? 0;
      await this.client.execute(
        `INSERT INTO stats_meta (key, value) VALUES ('total_terms', ?)
         ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
        [totalTerms]
      );
    }

    const dayRow = (
      await this.client.execute(
        "SELECT COUNT(DISTINCT date) as c FROM daily_searches"
      )
    ).rows[0];
    const dailyDayCount = (dayRow?.c as number) ?? 0;
    return { totalTerms, totalSearches, dailyDayCount };
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

/**
 * 创建 Turso 热搜存储
 * 配置缺失时抛错（工厂层捕获后回退 sqlite）
 */
export function createTursoHotSearchStore(
  url?: string,
  authToken?: string
): TursoHotSearchStore {
  return new TursoHotSearchStore(url, authToken);
}
