import { createClient, type Client } from "@libsql/client";
import { formatDateKey, beijingDayStart } from "./hotSearchUtils";

/**
 * Turso IP 黑名单存储（2026-08-24 用户拍板）
 *
 * 背景：分布式低频刷词攻击每个 IP 不到 60 req/min（限流中间件阈值），
 * 限流拦不住；多个真实浏览器 UA 绕过 requireHumanOrCredential 拦截；
 * 数据库 search_terms 不带 IP 列，无法事后查询攻击来源。
 *
 * 设计：以 Turso 单表 rejected_ips 作为持久化 IP 黑名单真源。
 * - recordRejection：记录一次"被拦截"，hit_count +1；
 *   service 层根据累积次数触发 extendBlock 拉入正式黑名单（延长 expires_at）
 * - extendBlock：黑名单动作，**分级递增**（2026-08-25 用户拍板）：
 *   block_count=1 → 24h；=2 → 7 天；>=3 → 30 天。
 *   block_count 跨周期保留（prune 不删惯犯条目），顽固爬虫越关越久。
 * - isBlocked：查 IP 是否还在封禁期内
 * - pruneExpired：只清理"从未被正式拉黑过（block_count=0）"的过期条目；
 *   惯犯档案永久保留，避免解封后又从 0 累计
 *
 * 不走 IHotSearchStore 接口（语义与热搜无关，独立维护），由 botDefense
 * service 封装后调用。Worker / Docker 双跑，自动从环境变量取连接信息。
 *
 * 表结构：
 *   rejected_ips(
 *     ip TEXT PRIMARY KEY,        -- IPv4 / IPv6 字符串（normalizeIp 规整后）
 *     first_at INTEGER NOT NULL,  -- 首次被 reject 的时间戳（ms）
 *     last_at INTEGER NOT NULL,   -- 最近一次被 reject 的时间戳（ms）
 *     hit_count INTEGER NOT NULL DEFAULT 1,
 *     reason TEXT NOT NULL,       -- 最近一次被拒原因：bot_ua / rate_limit / bad_term
 *     expires_at INTEGER NOT NULL -- 当前封禁到期时间戳（ms）
 *     block_count INTEGER NOT NULL DEFAULT 0 -- 被正式拉黑次数（分级递增依据，惯犯保留）
 *   )
 *   honeypot_hits(
 *     openid TEXT NOT NULL,      -- 带有效凭证命中蜜罐的真人 openid（wx-auth 解析）
 *     ip TEXT NOT NULL,          -- 其请求来源 IP（同 rejected_ips 规整口径）
 *     hits INTEGER NOT NULL,     -- 累计命中次数
 *     last_at INTEGER NOT NULL,  -- 最近一次蜜罐命中时间戳（ms）
 *     PRIMARY KEY (openid, ip)
 *   )
 *
 * 蜜罐命中记录（2026-09-03）：当真实用户（带有效 wxauth 凭证）访问一个已被
 * 拉黑的共享出口 IP 时被喂蜜罐，把 (openid, ip) 关联记下来，管理端可按 openid
 * 反查"该用户是否正在被某个封禁 IP 蜜罐"，实现反馈解封闭环。
 * 说明：recordRejection 的三类拦截（bot_ua/rate_limit/bad_term）都是**无凭证**
 * 爬虫，不会走到这里；只有 isBlocked 命中且带凭证的真人请求才记录。
 */

/** 单次被拒绝自动过期时间（首次累计期间短过期，给 1h 等待阈值判定） */
const HIT_TTL_MS = 60 * 60_000;
/** 永久封禁的到期时间戳（采用 far-future，语义上视作永久) */
const PERMANENT_EXPIRES_AT = 4_100_000_000_000; // 2100-01-01，远超任何真实年份
/** 分级封禁时长（按 block_count 取档：1→24h，2→7 天，3→30 天，>=4→永久；2026-08-25 用户拍板）
 *  永久档由 blockExpiresAt 单独处理（>=4 直接返回 PERMANENT_EXPIRES_AT） */
const BLOCK_DURATIONS_MS = [
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];
/** 永久档所需最小 block_count（>=4 → 永久封禁） */
const PERMANENT_BLOCK_COUNT = 4;
/** 取封禁到期时间：block_count>=4 → 永久（绝对 far-future）；否则 now + 档位时长 */
function blockExpiresAt(blockCount: number, now: number): number {
  if (blockCount >= PERMANENT_BLOCK_COUNT) return PERMANENT_EXPIRES_AT;
  const idx = Math.min(Math.max(blockCount, 1), BLOCK_DURATIONS_MS.length) - 1;
  return now + BLOCK_DURATIONS_MS[idx];
}

export class TursoBotDefenseStore {
  private client: Client;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  constructor(url?: string, authToken?: string) {
    const u = url ?? process.env.TURSO_URL;
    const t = authToken ?? process.env.TURSO_AUTH_TOKEN;
    if (!u) {
      throw new Error("TursoBotDefenseStore: 缺少 TURSO_URL 配置");
    }
    this.client = createClient({ url: u, authToken: t || undefined });
    this.initPromise = this.init()
      .then(() => {
        this.initPromise = null;
      })
      .catch((err) => {
        console.log(
          "[TursoBotDefenseStore] ❌ 初始化失败:",
          err instanceof Error ? err.message : err
        );
        this.initFailed = true;
        this.initPromise = null;
        throw err;
      });
  }

  private async init(): Promise<void> {
    await this.client.batch([
      `CREATE TABLE IF NOT EXISTS rejected_ips (
        ip TEXT PRIMARY KEY,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        block_count INTEGER NOT NULL DEFAULT 0
      )`,
      "CREATE INDEX IF NOT EXISTS idx_rejected_ips_expires ON rejected_ips(expires_at)",
      `CREATE TABLE IF NOT EXISTS honeypot_hits (
        openid TEXT NOT NULL,
        ip TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        last_at INTEGER NOT NULL,
        PRIMARY KEY (openid, ip)
      )`,
    ]);
    // 兼容旧表（无 block_count 列）：幂等补列（已存在时报 duplicate column，忽略）
    try {
      await this.client.execute(
        "ALTER TABLE rejected_ips ADD COLUMN block_count INTEGER NOT NULL DEFAULT 0"
      );
    } catch {
      // 列已存在（新表 CREATE 已带），忽略
    }
    console.log("[TursoBotDefenseStore] ✅ 存储已就绪");
  }

  private async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (this.initFailed) {
      throw new Error("TursoBotDefenseStore 初始化失败");
    }
  }

  /**
   * 记录一次拒绝事件（不直接进黑名单，仅累计 hit_count）。
   *
   * **原子 upsert（2026-08-26 修复 UNIQUE 冲突）**：原实现是 SELECT-then-INSERT/UPDATE
   * 两段式，并发下（同一 IP 短时间内多次被频控命中）出现 TOCTOU 竞态——多个请求
   * 各自 SELECT 都没查到，然后都试图 INSERT，第 1 个成功，其余撞 PRIMARY KEY
   * UNIQUE 约束。现改为单条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`，
   * 与 extendBlock / manuallyBlock 风格统一，同时少一次 SELECT 往返。
   *
   * - 新条目：写入，hit_count=1，expires_at = now + 1h（短过期，未达阈值会被 prune），
   *   block_count=0
   * - 已有条目：hit_count +1，刷新 last_at / reason；**不动 expires_at 与
   *   block_count**（这两个由 extendBlock / manuallyBlock 专管）
   *
   * 返回当前 hit_count 与「当前是否在正式封禁期内」。
   * blocked 语义收紧（2026-08-26）：仅 `block_count > 0 且 expires_at > now`
   * 才视为封禁中——原来只看 expires_at > now 会把"累计期间的 1h 短过期标记"
   * 误判成封禁。service 层当前只用 hitCount，此收紧不影响热路径。
   */
  async recordRejection(
    ip: string,
    reason: string,
    now: number
  ): Promise<{ hitCount: number; blocked: boolean; blockCount: number }> {
    await this.waitForInit();
    const res = await this.client.execute(
      `INSERT INTO rejected_ips (ip, first_at, last_at, hit_count, reason, expires_at, block_count)
       VALUES (?, ?, ?, 1, ?, ?, 0)
       ON CONFLICT(ip) DO UPDATE SET
         hit_count = hit_count + 1,
         last_at = excluded.last_at,
         reason = excluded.reason
       RETURNING hit_count, expires_at, block_count`,
      [ip, now, now, reason, now + HIT_TTL_MS]
    );
    const row = res.rows[0];
    const hitCount = (row?.hit_count as number) ?? 1;
    const expiresAt = (row?.expires_at as number) ?? 0;
    const blockCount = (row?.block_count as number) ?? 0;
    return {
      hitCount,
      blocked: blockCount > 0 && expiresAt > now,
      blockCount,
    };
  }

  /**
   * 命中阈值后分级封禁（2026-08-25 用户拍板）：
   * block_count 递增 1，封禁时长按新值取档（1→24h，2→7 天，>=3→30 天）。
   * block_count 不因过期清零（prune 保留惯犯），顽固爬虫越关越久。
   * @returns 新 block_count（供 service 日志）
   */
  async extendBlock(
    ip: string,
    reason: string,
    now: number
  ): Promise<number> {
    await this.waitForInit();
    const existing = (
      await this.client.execute(
        "SELECT block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    const nextBlockCount = (((existing?.block_count as number) ?? 0) || 0) + 1;
    const expiresAt = blockExpiresAt(nextBlockCount, now);

    await this.client.execute(
      `INSERT INTO rejected_ips (ip, first_at, last_at, hit_count, reason, expires_at, block_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         last_at = excluded.last_at,
         reason = excluded.reason,
         expires_at = excluded.expires_at,
         block_count = excluded.block_count`,
      [ip, now, now, reason, expiresAt, nextBlockCount]
    );
    return nextBlockCount;
  }

  /**
   * 当前 IP 是否仍在封禁期内。
   *
   * 2026-08-27 修复：必须 `block_count > 0 且 expires_at > now` 才算封禁。
   * 此前只看 expires_at > now 存在致命误判——recordRejection 写入的新条目
   * expires_at = now + 1h（累计期短标记）、block_count = 0（未正式拉黑），
   * 但 isBlocked 只看 expires_at 会把这类"从未拉黑过的计数记录"误判为封禁，
   * 导致正常用户只要被记录 1 次拒绝事件（hit_count=1）就被蜜罐/拦截 1 小时
   * （用户实测：自己 IP 被假拉黑，block_count=0 / hit_count=1 / expires_at 1h）。
   * 正式拉黑（extendBlock / manuallyBlock）都会设置 block_count > 0。
   */
  async isBlocked(ip: string, now: number): Promise<boolean> {
    await this.waitForInit();
    const r = (
      await this.client.execute(
        "SELECT block_count, expires_at FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    if (!r) return false;
    const blockCount = (r.block_count as number) ?? 0;
    const expiresAt = (r.expires_at as number) ?? 0;
    return blockCount > 0 && expiresAt > now;
  }

  /**
   * 手动拉黑（2026-08-25 管理页"加入黑名单"按钮）：
   * - block_count 在历史基础上 +1（惯犯档案延续）
   * - 封禁时长按新 block_count 取档（>=4 直接永久，管理员显式拉黑的
   *   顽固来源不再给 30 天封顶，直接永久）
   * - 已有条目可能是封禁中 / 已解封 / 从未拉黑过的计数记录，统一覆盖
   * @returns 新 block_count
   */
  async manuallyBlock(
    ip: string,
    reason: string,
    now: number
  ): Promise<number> {
    await this.waitForInit();
    const existing = (
      await this.client.execute(
        "SELECT block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    const prev = (((existing?.block_count as number) ?? 0) || 0);
    // 管理员手动拉黑至少取 3 档（30 天）；历史查封 >=3 → 永久
    const nextBlockCount = Math.max(prev + 1, 3);
    const expiresAt = blockExpiresAt(nextBlockCount, now);

    await this.client.execute(
      `INSERT INTO rejected_ips (ip, first_at, last_at, hit_count, reason, expires_at, block_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         last_at = excluded.last_at,
         reason = excluded.reason,
         expires_at = excluded.expires_at,
         block_count = excluded.block_count`,
      [ip, now, now, reason, expiresAt, nextBlockCount]
    );
    return nextBlockCount;
  }

  /**
   * 手动移除黑名单（2026-08-25 管理页"移除"按钮）：
   * 直接删掉整行（含惯犯档案）——管理员显式放行，不再保留计数。
   * @returns 是否删除了条目
   */
  async removeBlock(ip: string): Promise<boolean> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM rejected_ips WHERE ip = ?",
      [ip]
    );
    return (result.rowsAffected ?? 0) > 0;
  }

  /**
   * 记录一次"真人命中蜜罐"（2026-09-03 用户反馈解封闭环）。
   *
   * 场景：真实用户（带有效 wxauth 凭证）访问已被拉黑的 IP（共享出口 NAT /
   * 公司出口被爬虫拖累），isBlocked 命中后直接喂蜜罐假数据——此前该请求
   * 在 requireWxAuth 之前就被拦下，openid 从未解析、search_log 也不记录，
   * 导致用户拿 openid 反馈时管理员无法定位到受影响 IP。
   *
   * 本方法在蜜罐命中且成功解出 openid 后异步调用（fire-and-forget）：
   * upsert 一行 (openid, ip)，hits +1、last_at 刷新。纯 DB **写**，不在热路径
   * isBlocked 上加任何读。表很小（仅带凭证的误伤真人），主键天然去重。
   *
   * @returns 是否写入成功（openid 为空串时忽略）
   */
  async recordHoneypotHit(
    openid: string,
    ip: string,
    now: number
  ): Promise<boolean> {
    const oid = (openid || "").trim();
    const nip = (ip || "").trim();
    if (!oid || !nip || oid.length > 128 || nip.length > 64) return false;
    await this.waitForInit();
    await this.client.execute(
      `INSERT INTO honeypot_hits (openid, ip, hits, last_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(openid, ip) DO UPDATE SET
         hits = hits + 1,
         last_at = excluded.last_at`,
      [oid, nip, now]
    );
    return true;
  }

  /**
   * 管理反查：某 openid 最近命中过蜜罐的 IP 列表（按最近命中倒序）。
   * 走主键 openid 前缀索引，一条查询。limit 上限 100。
   */
  async listHoneypotByOpenid(
    openid: string,
    limit = 20,
    now = Date.now()
  ): Promise<{ ip: string; hits: number; lastAt: number }[]> {
    const oid = (openid || "").trim();
    if (!oid) return [];
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 100);
    const rows = await this.client.execute(
      `SELECT ip, hits, last_at FROM honeypot_hits
       WHERE openid = ?
       ORDER BY last_at DESC LIMIT ?`,
      [oid, safe]
    );
    return rows.rows.map((r) => ({
      ip: r.ip as string,
      hits: (r.hits as number) ?? 0,
      lastAt: (r.last_at as number) ?? 0,
    }));
  }

  /**
   * 管理反查：某 IP 最近影响了哪些 openid（黑名单条目"谁被这个 IP 蜜罐过"）。
   * 全表按 ip 过滤（honeypot_hits 无 ip 独立索引，但表很小 + 低频管理查询，
   * 可接受）。limit 上限 50。
   */
  async listHoneypotByIp(
    ip: string,
    limit = 20,
    now = Date.now()
  ): Promise<{ openid: string; hits: number; lastAt: number }[]> {
    const nip = (ip || "").trim();
    if (!nip) return [];
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 50);
    const rows = await this.client.execute(
      `SELECT openid, hits, last_at FROM honeypot_hits
       WHERE ip = ?
       ORDER BY last_at DESC LIMIT ?`,
      [nip, safe]
    );
    return rows.rows.map((r) => ({
      openid: r.openid as string,
      hits: (r.hits as number) ?? 0,
      lastAt: (r.last_at as number) ?? 0,
    }));
  }

  /**
   * 清理超过保留期的蜜罐命中记录（2026-09-03）：
   * 该表只用于"近期反馈解封"，历史旧命中无价值，随 botDefense 周期 prune
   * 一并清掉，避免无界膨胀。保留期默认 90 天。
   */
  async pruneHoneypotHits(
    now: number,
    retainMs: number = 90 * 24 * 60 * 60_000
  ): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM honeypot_hits WHERE last_at <= ?",
      [now - retainMs]
    );
    return result.rowsAffected ?? 0;
  }

  /**
   * 管理排查：黑名单全部条目（封禁中 + 惯犯档案 + 未达阈值短记录），
   * 按最近活动倒序。支持：
   * - ipFilter：IP 子串模糊搜索（LIKE，含 IPv4/IPv6 部分匹配）
   * - status：'blocked'（仅封禁中）| 'free'（仅已解封）| undefined（全部）
   * - offset：分页偏移（配合 limit 翻页）
   * 返回 { items, total }：total 为当前筛选条件下的总条数（供前端分页）。
   */
  async listEntries(
    now: number,
    limit: number,
    opts: { ipFilter?: string; status?: "blocked" | "free"; offset?: number } = {}
  ): Promise<{
    items: {
      ip: string;
      reason: string;
      hitCount: number;
      blockCount: number;
      firstAt: number;
      lastAt: number;
      expiresAt: number;
    }[];
    total: number;
  }> {
    await this.waitForInit();
    const safe = Math.min(Math.max(1, limit), 500);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const where: string[] = [];
    const params: unknown[] = [];
    const filter = (opts.ipFilter ?? "").trim();
    if (filter) {
      where.push("ip LIKE ?");
      params.push(`%${filter}%`);
    }
    if (opts.status === "blocked") {
      where.push("expires_at > ? AND block_count > 0");
      params.push(now);
    } else if (opts.status === "free") {
      where.push("expires_at <= ? OR block_count = 0");
      params.push(now);
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    const countRow = (
      await this.client.execute(`SELECT COUNT(*) AS c FROM rejected_ips${whereSql}`, params)
    ).rows[0];
    const total = (countRow?.c as number) ?? 0;

    const rows = await this.client.execute(
      `SELECT ip, reason, hit_count, block_count, first_at, last_at, expires_at
       FROM rejected_ips${whereSql}
       ORDER BY last_at DESC LIMIT ? OFFSET ?`,
      [...params, safe, offset]
    );
    return {
      total,
      items: rows.rows.map((r) => ({
        ip: r.ip as string,
        reason: r.reason as string,
        hitCount: (r.hit_count as number) ?? 0,
        blockCount: (r.block_count as number) ?? 0,
        firstAt: (r.first_at as number) ?? 0,
        lastAt: (r.last_at as number) ?? 0,
        expiresAt: (r.expires_at as number) ?? 0,
      })),
    };
  }

  /**
   * 按多个 IP 批量查黑名单状态（2026-09-03 openid 反查用）。
   * 一条 IN 查询替代 N 次单查，配合 honeypot_hits 反查结果使用，
   * 尽量少 DB 读。返回按传入 IP 顺序 map（无记录的 IP 不出现在结果里）。
   */
  async listStatusByIps(
    ips: string[],
    now: number
  ): Promise<
    {
      ip: string;
      reason: string;
      hitCount: number;
      blockCount: number;
      firstAt: number;
      lastAt: number;
      expiresAt: number;
    }[]
  > {
    const cleaned = (ips || [])
      .map((s) => (s || "").trim())
      .filter(Boolean);
    if (cleaned.length === 0) return [];
    await this.waitForInit();
    // libsql 参数占位符：每个 IP 一个 ?，安全拼 IN 子句
    const placeholders = cleaned.map(() => "?").join(", ");
    const rows = await this.client.execute(
      `SELECT ip, reason, hit_count, block_count, first_at, last_at, expires_at
       FROM rejected_ips WHERE ip IN (${placeholders})`,
      cleaned
    );
    return rows.rows.map((r) => ({
      ip: r.ip as string,
      reason: (r.reason as string) ?? "",
      hitCount: (r.hit_count as number) ?? 0,
      blockCount: (r.block_count as number) ?? 0,
      firstAt: (r.first_at as number) ?? 0,
      lastAt: (r.last_at as number) ?? 0,
      expiresAt: (r.expires_at as number) ?? 0,
    }));
  }

  /**
   * 清掉过期条目，返回删除条数（用于周期 prune）。
   * 只删"从未被正式拉黑过（block_count=0）"的过期条目——
   * 惯犯档案（block_count>0）永久保留，跨周期记住封禁历史，
   * 避免解封后再刷又从 0 累计、永远只吃 24h。
   */
  async pruneExpired(now: number): Promise<number> {
    await this.waitForInit();
    const result = await this.client.execute(
      "DELETE FROM rejected_ips WHERE expires_at <= ? AND block_count = 0",
      [now]
    );
    return result.rowsAffected ?? 0;
  }

  /**
   * 管理概览统计（2026-08-26 流量概览面板数据源）。
   * 全部基于 rejected_ips（被拦截/拉黑的 IP 档案）：
   * - total：黑名单总条目数（含已解封惯犯档案）
   * - blocked：当前封禁中条数（expires_at > now 且 block_count > 0）
   * - todayActive：今日仍有活动（last_at >= 北京时间 0 点）的条目数
   * - topIps：近 N 天最活跃的被拒 IP（按 hit_count 累计降序）
   */
  async getOverviewStats(
    days = 7,
    topLimit = 10,
    now = Date.now()
  ): Promise<{
    total: number;
    blocked: number;
    todayActive: number;
    topIps: {
      ip: string;
      reason: string;
      hitCount: number;
      blockCount: number;
      expiresAt: number;
    }[];
  }> {
    await this.waitForInit();
    const safeDays = Math.min(Math.max(1, days), 90);
    const todayStart = beijingDayStart(formatDateKey(now));
    const since = todayStart - (safeDays - 1) * 86400000;

    const countRow = (
      await this.client.execute(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN expires_at > ? AND block_count > 0 THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN last_at >= ? THEN 1 ELSE 0 END) AS todayActive
         FROM rejected_ips`,
        [now, todayStart]
      )
    ).rows[0];
    const total = (countRow?.total as number) ?? 0;
    const blocked = (countRow?.blocked as number) ?? 0;
    const todayActive = (countRow?.todayActive as number) ?? 0;

    const topRows = await this.client.execute(
      `SELECT ip, reason, hit_count, block_count, expires_at FROM rejected_ips
       WHERE last_at >= ?
       ORDER BY hit_count DESC LIMIT ?`,
      [since, Math.min(Math.max(1, topLimit), 50)]
    );

    return {
      total,
      blocked,
      todayActive,
      topIps: topRows.rows.map((r) => ({
        ip: r.ip as string,
        reason: (r.reason as string) ?? "",
        hitCount: (r.hit_count as number) ?? 0,
        blockCount: (r.block_count as number) ?? 0,
        expiresAt: (r.expires_at as number) ?? 0,
      })),
    };
  }

  close(): void {
    try {
      this.client.close();
    } catch {}
  }
}

export function createTursoBotDefenseStore(
  url?: string,
  authToken?: string
): TursoBotDefenseStore {
  return new TursoBotDefenseStore(url, authToken);
}
