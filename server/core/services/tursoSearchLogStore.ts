import { createClient, type Client } from "@libsql/client";
import { formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * Turso 搜索明细日志存储（2026-08-25 用户拍板）
 *
 * 背景：已能通过 openid 区分个体 + 已记录搜索词，但二者没有关联，
 * 无法排查"哪个 openid 搜了什么"。新建独立明细表 search_log：
 *   - 每次搜索一条：openid / ip / term / created_at
 *   - openid 原文存储（管理侧排查用，不进前端）
 *   - 90 天自动清理（隐私最小化 + 防表膨胀）
 *
 * 与 search_terms（聚合统计）解耦：search_terms 继续匿名聚合，明细
 * 日志单独成表，不污染统计口径。
 *
 * 保留策略（2026-08-25 用户拍板）：**长期保留**，不设自动清理——
 * 热词/日历按天 GROUP BY 本表明细即得"每天每词次数"，需要全量历史。
 * 数据量估算：日 2-3k 次搜索 ≈ 百万行/年，Turso 免费额度（5 亿行读/月）
 * 足够。若未来撑不住，再启用 pruneExpired 补清理/归档（方法已保留）。
 *
 * 表结构：
 *   search_log(
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     openid TEXT NOT NULL DEFAULT '',   -- wxauth 解出的 openid（未登录为 ''）
 *     ip TEXT NOT NULL DEFAULT '',       -- 来源 IP（未知为 ''）
 *     term TEXT NOT NULL,                -- 搜索词
 *     created_at INTEGER NOT NULL        -- 时间戳（ms）
 *   )
 */

/**
 * 明细保留策略：**长期保留**（2026-08-25 用户拍板，热词/日历需要全量历史）。
 * 不再自动清理；pruneExpired 保留方法，未来撑不住时手动/定时补清理。
 */

export class TursoSearchLogStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoSearchLogStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoSearchLogStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS search_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        openid TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        term TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at)",
      // 2026-09-04：openid 索引——黑名单 openid 反查兜底 search_log 时走索引，
      // 避免每次管理反查全表扫（读量吃紧，务必索引化反查路径）
      "CREATE INDEX IF NOT EXISTS idx_search_log_openid ON search_log(openid)",
    ]);
    console.log("[TursoSearchLogStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoSearchLogStore 初始化失败");
    }
  }

  /** 写入一条搜索明细（异步，调用方失败静默，绝不影响搜索主流程） */
  async logSearch(input: {
    openid?: string;
    ip?: string;
    term: string;
    now?: number;
  }): Promise<void> {
    await this.waitForInit();
    await this.client.execute(
      "INSERT INTO search_log (openid, ip, term, created_at) VALUES (?, ?, ?, ?)",
      [
        (input.openid || "").slice(0, 128),
        (input.ip || "").slice(0, 64),
        input.term.slice(0, 200),
        input.now ?? Date.now(),
      ]
    );
  }

  /**
   * 清理超过保留期的明细（默认 90 天），返回删除条数。
   * 当前策略为长期保留（用户拍板），此方法仅在需要时手动/定时调用。
   */
  async pruneExpired(now: number, retainMs: number = 90 * 24 * 60 * 60_000): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM search_log WHERE created_at <= ?",
      [now - retainMs]
    );
    return result.rowsAffected ?? 0;
  }

  /**
   * 某天（北京时间 [start, end)）每词搜索次数，按次数降序 TOP N。
   * 2026-08-25：热词/日历"每天次数"的真源（取代 search_terms 历史累计）。
   */
  async getDayTopTerms(
    start: number,
    end: number,
    limit: number
  ): Promise<{ term: string; count: number }[]> {
    await this.waitForInit();
    const rows = await this.client.execute(
      `SELECT term, COUNT(*) AS c FROM search_log
       WHERE created_at >= ? AND created_at < ?
       GROUP BY term ORDER BY c DESC, term LIMIT ?`,
      [start, end, Math.min(Math.max(1, limit), 500)]
    );
    return rows.rows.map((r) => ({
      term: r.term as string,
      count: (r.c as number) ?? 0,
    }));
  }

  /** 某天词随机抽样（首页词云），带当天次数 */
  async getRandomDayTerms(
    start: number,
    end: number,
    limit: number
  ): Promise<{ term: string; count: number }[]> {
    await this.waitForInit();
    const rows = await this.client.execute(
      `SELECT term, COUNT(*) AS c FROM search_log
       WHERE created_at >= ? AND created_at < ?
       GROUP BY term ORDER BY RANDOM() LIMIT ?`,
      [start, end, Math.min(Math.max(1, limit), 100)]
    );
    return rows.rows.map((r) => ({
      term: r.term as string,
      count: (r.c as number) ?? 0,
    }));
  }

  /**
   * 近 N 天每天词数 + top3（日历热力图）。
   * 返回连续 N 天序列（无数据的天 count=0 / top=[]，宁缺毋滥不编造）。
   */
  async getDaySummaries(
    startTs: number,
    days: number
  ): Promise<{ date: string; count: number; top: string[] }[]> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);

    // 每天词数（DISTINCT term）
    const countRows = await this.client.execute(
      `SELECT date((created_at + 8*3600*1000)/1000, 'unixepoch') AS day, COUNT(DISTINCT term) AS c
       FROM search_log WHERE created_at >= ?
       GROUP BY day`,
      [startTs]
    );
    const countMap = new Map<string, number>();
    for (const r of countRows.rows) countMap.set(r.day as string, r.c as number);

    // 每天 top3（当天次数降序）
    const topRows = await this.client.execute(
      `SELECT day, term FROM (
         SELECT date((created_at + 8*3600*1000)/1000, 'unixepoch') AS day, term,
                ROW_NUMBER() OVER (
                  PARTITION BY date((created_at + 8*3600*1000)/1000, 'unixepoch')
                  ORDER BY COUNT(*) DESC, term
                ) AS rn
         FROM search_log WHERE created_at >= ?
         GROUP BY day, term
       ) WHERE rn <= 3`,
      [startTs]
    );
    const topMap = new Map<string, string[]>();
    for (const r of topRows.rows) {
      const day = r.day as string;
      const list = topMap.get(day) ?? [];
      if (list.length < 3) list.push(r.term as string);
      topMap.set(day, list);
    }

    // 补全连续 N 天序列（今天往前）
    const out: { date: string; count: number; top: string[] }[] = [];
    const dayMs = 86400000;
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * dayMs);
      out.push({ date, count: countMap.get(date) ?? 0, top: topMap.get(date) ?? [] });
    }
    return out;
  }

  /**
   * 管理排查：某 openid 的搜索记录（谁搜了什么），按时间倒序。
   * since（ms）可选：只返回该时间点之后的记录。
   * offset：分页偏移（2026-08-26 新增）。
   */
  async searchByOpenid(
    openid: string,
    limit: number,
    since?: number,
    offset = 0
  ): Promise<{ term: string; ip: string; createdAt: number }[]> {
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 500);
    const off = Math.max(0, Math.floor(offset));
    const rows = since
      ? await this.client.execute(
          `SELECT term, ip, created_at FROM search_log
           WHERE openid = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [openid, since, safe, off]
        )
      : await this.client.execute(
          `SELECT term, ip, created_at FROM search_log
           WHERE openid = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [openid, safe, off]
        );
    return rows.rows.map((r) => ({
      term: r.term as string,
      ip: r.ip as string,
      createdAt: (r.created_at as number) ?? 0,
    }));
  }

  /** 管理排查：搜过某词的所有记录（openid/ip/时间），按时间倒序 */
  async searchByTerm(
    term: string,
    limit: number,
    since?: number,
    offset = 0
  ): Promise<{ openid: string; ip: string; createdAt: number }[]> {
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 500);
    const off = Math.max(0, Math.floor(offset));
    const rows = since
      ? await this.client.execute(
          `SELECT openid, ip, created_at FROM search_log
           WHERE term = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [term, since, safe, off]
        )
      : await this.client.execute(
          `SELECT openid, ip, created_at FROM search_log
           WHERE term = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [term, safe, off]
        );
    return rows.rows.map((r) => ({
      openid: r.openid as string,
      ip: r.ip as string,
      createdAt: (r.created_at as number) ?? 0,
    }));
  }

  /**
   * 管理排查：某 IP 的所有搜索记录（该 IP 搜过什么），按时间倒序。
   * 处置爬虫/刷词 IP 时快速定位其行为特征。
   */
  async searchByIp(
    ip: string,
    limit: number,
    since?: number,
    offset = 0
  ): Promise<{ term: string; openid: string; createdAt: number }[]> {
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 500);
    const off = Math.max(0, Math.floor(offset));
    const rows = since
      ? await this.client.execute(
          `SELECT term, openid, created_at FROM search_log
           WHERE ip = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [ip, since, safe, off]
        )
      : await this.client.execute(
          `SELECT term, openid, created_at FROM search_log
           WHERE ip = ?
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [ip, safe, off]
        );
    return rows.rows.map((r) => ({
      term: r.term as string,
      openid: r.openid as string,
      createdAt: (r.created_at as number) ?? 0,
    }));
  }

  /**
   * 管理排查：按条件统计总条数（配合 searchByXxx 分页）。
   * field ∈ 'openid' | 'term' | 'ip'，精确匹配 + 可选 since 过滤。
   */
  async countSearch(
    field: "openid" | "term" | "ip",
    value: string,
    since?: number
  ): Promise<number> {
    await this.waitForInit();
    const rows = since
      ? await this.client.execute(
          `SELECT COUNT(*) AS c FROM search_log WHERE ${field} = ? AND created_at >= ?`,
          [value, since]
        )
      : await this.client.execute(
          `SELECT COUNT(*) AS c FROM search_log WHERE ${field} = ?`,
          [value]
        );
    return (rows.rows[0]?.c as number) ?? 0;
  }

  /**
   * 管理概览统计（2026-08-26 流量概览面板数据源）。
   * 全部基于 search_log（仅真实搜索，不含被拦截流量）：
   * - todayCount：今日搜索次数（北京时间 0 点起）
   * - todayTerms：今日去重搜索词数
   * - trend：近 N 天每日搜索次数（连续序列，无数据天为 0）
   * - topTerms：近 N 天 TOP 搜索词（按次降序）
   */
  async getOverviewStats(
    days = 7,
    topLimit = 10
  ): Promise<{
    todayCount: number;
    todayTerms: number;
    trend: { date: string; count: number }[];
    topTerms: { term: string; count: number }[];
  }> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const todayStart = beijingDayStart(formatDateKey(Date.now()));
    const since = todayStart - (safeDays - 1) * 86400000;

    const todayRow = (
      await this.client.execute(
        "SELECT COUNT(*) AS c, COUNT(DISTINCT term) AS t FROM search_log WHERE created_at >= ?",
        [todayStart]
      )
    ).rows[0];
    const todayCount = (todayRow?.c as number) ?? 0;
    const todayTerms = (todayRow?.t as number) ?? 0;

    const trendRows = await this.client.execute(
      `SELECT date((created_at + 8*3600*1000)/1000, 'unixepoch') AS day, COUNT(*) AS c
       FROM search_log WHERE created_at >= ?
       GROUP BY day`,
      [since]
    );
    const trendMap = new Map<string, number>();
    for (const r of trendRows.rows) trendMap.set(r.day as string, r.c as number);

    const topRows = await this.client.execute(
      `SELECT term, COUNT(*) AS c FROM search_log
       WHERE created_at >= ?
       GROUP BY term ORDER BY c DESC, term LIMIT ?`,
      [since, Math.min(Math.max(1, topLimit), 50)]
    );

    // 补全连续 N 天序列（今天往前）
    const trend: { date: string; count: number }[] = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const date = formatDateKey(Date.now() - i * 86400000);
      trend.push({ date, count: trendMap.get(date) ?? 0 });
    }

    return {
      todayCount,
      todayTerms,
      trend,
      topTerms: topRows.rows.map((r) => ({
        term: r.term as string,
        count: (r.c as number) ?? 0,
      })),
    };
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

let storeInstance: TursoSearchLogStore | null = null;

/**
 * 获取单例 store。Turso 不可用（未配 TURSO_URL）返回 null，
 * 调用方静默跳过明细记录（不影响搜索）。
 */
export function getSearchLogStore(): TursoSearchLogStore | null {
  if (storeInstance === null) {
    try {
      storeInstance = new TursoSearchLogStore();
    } catch {
      storeInstance = null;
    }
  }
  return storeInstance;
}

/** 测试用：重置单例 */
export function resetSearchLogStore(): void {
  storeInstance = null;
}
