import { loggers } from "../utils/logger";

/** IPv4-mapped IPv6 规范化（独立内联，不反向依赖 middleware，
 *  避免 service 被无 server 上下文时引用断链） */
function normalizeIp(ip: string): string {
  const v = ip.trim();
  if (v.startsWith("::ffff:")) return v.slice(7);
  return v;
}

/** 简单 IP 匹配：精确相等 + IPv4 CIDR 段。IPv6 CIDR 也支持（按 /64 简化为前缀匹配） */
function ipMatches(ip: string, entry: string): boolean {
  if (!entry) return false;
  if (entry === ip) return true;
  if (entry.includes("/")) {
    // CIDR 段
    const [base, bitsStr] = entry.split("/");
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits)) return false;
    if (base.includes(":")) {
      // IPv6 CIDR：仅按整段比较（前 bits/16 段）
      const a = base.split(":");
      const b = ip.split(":");
      const n = Math.floor(bits / 16);
      if (a.length < n || b.length < n) return false;
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    // IPv4 CIDR
    const toInt = (s: string) =>
      s.split(".").reduce((acc, p) => (acc << 8) | Number(p), 0) >>> 0;
    const ipNum = toInt(ip);
    const baseNum = toInt(base);
    if (isNaN(ipNum) || isNaN(baseNum)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
  }
  return false;
}

/**
 * Bot 防御服务（2026-08-24 用户拍板）
 *
 * 内存正/负缓存 + Turso 持久化黑名单真源（tursoBotDefenseStore）。
 * - recordRejection：累计同一 IP 的 reject 次数，达到阈值自动 extendBlock（24h）
 * - isBlocked：先查内存 cache，未命中查 Turso，回写缓存
 * - startMaintenance：周期性 pruneExpired，避免表无限膨胀
 *
 * Turso 不可用时降级为"不持久化"（仅靠内存拦截；服务重启后丢黑名单）。
 * 这种降级是安全选择：宁可临时漏拦，不要误把可恢复 IP 永久拉黑。
 *
 * 设计要点：
 * - 黑名单缓存 5min，负缓存 5min（2026-09-01 从 30s 拉长，见常量处说明）：
 *   两者保证拦截 hot path 极少触发 Turso 读
 * - 阈值策略：同一 IP 在 60s 内累计 5 次 reject → 拉黑 24h
 *   既能逮住分布式低频攻击（被拦 5+ 次说明意图明显），也能容忍真人偶发误判
 * - recordRejection 静默吞错：拦截 hot path 不能因持久化失败拖慢搜索
 *
 * 2026-08-24 紧急调整（用户调试 WX_AUTH 时真人 IP 被累计拉黑）：
 * - HOT_THRESHOLD 5→50：原 5 次门槛太敏感，真人调试 WX_AUTH 用 curl
 *   触发 UA 拦截 7 次就被拉黑
 * - HOT_WINDOW_MS 60s→300s：5min 累计 50 次才拉黑，分布式持续攻击仍能逮
 *   （即使 1 req/6s 也能在 5min 内累积 50），调试期真人短时间多次不触发
 * - 新增 BOT_DEFENSE_WHITELIST 环境变量（逗号分隔 IP/CIDR），命中跳过
 *   一切 recordRejection（owner 本机/IPv6 段豁免）
 * - 新增 BOT_DEFENSE_ENFORCE=1 开关：未开启时 isBlocked 恒返回 false
 *   （只累计、不拦截）。**2026-08-24 22:53 紧急恢复线上：用户真人 IP 被
 *   误拉黑后所有搜索 403，先默认关闭拦截恢复搜索，等机制稳定再开**
 */

/** 黑名单内存缓存 TTL（热 path 长期命中） */
const POS_CACHE_TTL_MS = 5 * 60_000;
/**
 * 负缓存 TTL（短时间内不再查同一个非黑名单 IP）
 * 2026-09-01 优化：30s → 5min。Docker 单进程部署，内存缓存全局共享，
 * negCache 5min 内该 IP 的 isBlocked 完全不查库；而所有拉黑路径
 * （阈值自动拉黑 / 手动拉黑 / 探查升级）都会同步删掉该 IP 的 negCache，
 * 新拉黑立即生效，拉长负缓存不产生"已拉黑仍放行 5min"的窗口。
 */
const NEG_CACHE_TTL_MS = 5 * 60_000;
/** 拉黑阈值：同一 IP 累计拒绝次数（2026-08-24 从 5 调到 50） */
const HOT_THRESHOLD = 50;
/** 拉黑阈值时间窗（毫秒，2026-08-24 从 60s 调到 300s） */
const HOT_WINDOW_MS = 5 * 60_000;
/**
 * 黑名单表 prune 周期（2026-09-03 用户拍板：5min→1h，减少 Turso 读）。
 * 被清的是 block_count=0 的计数短记录（TTL 1h，无拦截语义），删晚一小时不影响任何判定；
 * 表按 IP 为主键每 IP 一行，也不会因删除延迟而膨胀。
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** 内存 pos/neg 缓存清扫周期（纯本地零 DB；与 DB prune 解耦，避免过期项滞留 Map） */
const MEM_CACHE_CLEAN_INTERVAL_MS = 5 * 60_000;
/** 蜜罐命中记录清理周期（保留期 90 天，低频每天一次即可，顺带再省 Turso 读） */
const HONEYPOT_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
/** 黑名单命中探查升级（2026-08-25 用户拍板"751 次就直接永久拉黑"）：
 *  已拉黑 IP 在封禁期内仍持续探测 → 计数；同 IP 累计 PROBE_UPGRADE_THRESHOLD
 *  次（默认 60）后自动调 extendBlock 升一档（24h→7d→30d→永久）。
 *  **持续累计、升降后不清零**：同一攻击源持续探测会连续升级直到永久，
 *  无需等解封重新计数。
 */
const PROBE_UPGRADE_THRESHOLD = 60;
/** 探测升级统计的清理周期（与 POS_CACHE_TTL 一致，避免 Map 无限膨胀） */
const PROBE_RESET_INTERVAL_MS = 5 * 60_000;

/** 是否开启 IP 黑名单拦截（默认关闭，显式设 BOT_DEFENSE_ENFORCE=1 才拦截） */
export function isBotDefenseEnforced(): boolean {
  return process.env.BOT_DEFENSE_ENFORCE === "1";
}

interface CacheEntry {
  expiresAt: number;
}

export type RejectReason = "bot_ua" | "rate_limit" | "bad_term";

const BOT_DEFENSE_SERVICE_KEY = "__panhub_bot_defense_service_v1__";

export class BotDefenseService {
  private store: import("./tursoBotDefenseStore").TursoBotDefenseStore | null =
    null;
  private storeType: "turso" | "unavailable" = "unavailable";
  private initPromise: Promise<void> | null = null;
  private initFailedLogged = false;
  /** pos cache: ip -> 仍在黑名单的过期时间点 */
  private posCache = new Map<string, CacheEntry>();
  /** neg cache: ip -> 已知不在黑名单的过期时间点 */
  private negCache = new Map<string, CacheEntry>();
  /** hit 时间戳队列：判断是否在 HOT_WINDOW 内累计够了 HOT_THRESHOLD */
  private hitTimestamps = new Map<string, number[]>();
  /** 黑名单命中探查计数（已拉黑 IP 封禁期内仍在探测 → 达到阈值自动升级档位） */
  private probeCounts = new Map<string, { count: number; resetAt: number }>();
  /** in-flight 去重：同 IP 并发 isBlocked 复用同一 Promise，避免缓存击穿 */
  private inflightBlocked = new Map<string, Promise<boolean>>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private cacheTimer: ReturnType<typeof setInterval> | null = null;
  private honeypotTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const { createTursoBotDefenseStore } = await import("./tursoBotDefenseStore");
      const s = createTursoBotDefenseStore();
      // store 内部 init 是 lazy 的，触发一次初始化就好（错误由 store 内部 catch 抛不抛都接受）
      try {
        await (s as any)["initPromise"];
      } catch {
        // 初始化失败也允许降级运行
      }
      this.store = s;
      this.storeType = "turso";
      console.log("[BotDefenseService] ✅ 使用 Turso 持久化黑名单");
    } catch (err) {
      console.log(
        "[BotDefenseService] ❌ Turso 初始化失败（将降级为纯内存拦截）:",
        err instanceof Error ? err.message : err
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
      console.log(
        "[BotDefenseService] ⚠️ 黑名单持久化不可用（仅靠内存，重启后丢失）"
      );
    }
  }

  private isUsableIp(ip: string): boolean {
    if (!ip || ip === "unknown") return false;
    const n = normalizeIp(ip);
    if (n.length === 0) return false;
    // 白名单 IP 跳过（owner 本机/CIDR，环境变量逗号分隔；命中后直接视为"非攻击源"）
    const whitelist = (process.env.BOT_DEFENSE_WHITELIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (whitelist.some((entry) => ipMatches(n, entry))) return false;
    return true;
  }

  /**
   * IP 是否在黑名单内（命中即拦截）。
   * 缓存层级：posCache(5min) → negCache(30s) → Turso store。
   * 任何错误一律放行（fail-open），避免持久化故障误伤真人。
   *
   * 2026-08-25 新增（用户拍板"751 次就永久拉黑"）：命中黑名单的请求视为
   * "封禁期内的持续探查"——反复探测是最明确的恶意信号。每命中一次，
   * 内存累计 probeCount，达到 PROBE_UPGRADE_THRESHOLD（默认 60）后自动
   * 调 extendBlock 把该 IP 升一档（24h→7d→30d→永久）。超高频探测数天内
   * 即滚到永久档，无需人工干预。
   */
  async isBlocked(ip: string, now: number = Date.now()): Promise<boolean> {
    if (!isBotDefenseEnforced()) return false; // 2026-08-24 紧急恢复：开关关闭时不拦截
    if (!this.isUsableIp(ip)) return false;
    await this.waitForInit();
    const nip = normalizeIp(ip);

    const pos = this.posCache.get(nip);
    if (pos && pos.expiresAt > now) {
      // 命中缓存 → 按升级规则处理（异步、静默）；避免把长存活 session 的
      // 高频探测漏掉升级判定
      void this.recordProbe(nip, now);
      return true;
    }

    const neg = this.negCache.get(nip);
    if (neg && neg.expiresAt > now) return false;

    // in-flight 去重（2026-08-27）：前端一次搜索并发 35+ 子请求，
    // negCache 在首请求完成前不命中 → 全部打库（缓存击穿）。
    // 复用同 IP 进行中的 Promise，35 个并发只查库 1 次。
    const inflight = this.inflightBlocked.get(nip);
    if (inflight) return inflight;

    const p = this.queryBlockedFromStore(nip, now).finally(() => {
      this.inflightBlocked.delete(nip);
    });
    this.inflightBlocked.set(nip, p);
    return p;
  }

  /** 实际查库 + 回写缓存（抽出供 in-flight 去重复用） */
  private async queryBlockedFromStore(
    nip: string,
    now: number
  ): Promise<boolean> {
    if (!this.store) return false;
    try {
      const blocked = await this.store.isBlocked(nip, now);
      if (blocked) {
        this.posCache.set(nip, { expiresAt: now + POS_CACHE_TTL_MS });
        this.negCache.delete(nip);
        this.recordProbe(nip, now);
      } else {
        this.negCache.set(nip, { expiresAt: now + NEG_CACHE_TTL_MS });
        this.posCache.delete(nip);
      }
      return blocked;
    } catch (err) {
      loggers.api?.warn?.("黑名单查询失败，放行", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 记录一次"已拉黑 IP 的持续探查"，达到阈值自动升级档位。
   * - 纯内存计数（无持久化；进程重启后重新累计，但 store 的 block_count
   *   档案保留——跨 session 的"惯犯历史"不依赖本内存计数）
   * - **持续累计、升级不清零（2026-08-25 用户拍板）**："只要一直在攻击就算次数"——
   *   达阈值升一档后计数不清零重算，而是从阈值继续往上累加，
   *   同一攻击源在窗口内若持续探测会**连续多档升级**（24h→7d→30d→永久），
   *   751 次的流量不用等解封、几天内直接滚到永久
   * - 任何异常静默（fail-open，不影响热路径拦截结果）
   */
  private recordProbe(ip: string, now: number): void {
    try {
      const e = this.probeCounts.get(ip);
      if (e && now >= e.resetAt) {
        this.probeCounts.delete(ip);
      }
      const cur = this.probeCounts.get(ip) ?? { count: 0, resetAt: now + PROBE_RESET_INTERVAL_MS };
      cur.count++;
      // 升级判定：cur.count 必须跨过"下一个阈值倍数"才升级。
      // 例如阈值 60：第 60 次升第 1 档 → 计数保留 → 第 120 次升第 2 档（7 天）。
      // 升级后不清零，但同一次累加不会重复触发同档（避免 cur.count 一直 >=
      // 阈值导致每次命中都重复 extendBlock）。
      if (cur.count >= PROBE_UPGRADE_THRESHOLD &&
          cur.count % PROBE_UPGRADE_THRESHOLD === 0) {
        void (async () => {
          try {
            await this.waitForInit();
            if (!this.store) return;
            const blockCount = await this.store.extendBlock(ip, "probe", now);
            // 更新 posCache，让本次升级立即生效
            this.posCache.set(ip, { expiresAt: now + POS_CACHE_TTL_MS });
            loggers.search?.warn?.("黑名单升级（封禁期持续探查）", {
              ip,
              probeCount: cur.count,
              blockCount,
            });
          } catch (err) {
            loggers.api?.warn?.("黑名单升级失败", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      } else {
        this.probeCounts.set(ip, cur);
      }
    } catch {
      // 记录失败完全静默
    }
  }

  /**
   * 手动拉黑一个 IP（2026-08-25 管理页"加入黑名单"按钮）。
   * 直接走 store.manuallyBlock（block_count +1 → 30 天），
   * 并立刻刷新缓存使拦截立即生效：
   * - 写 posCache（5min 内 isBlocked 直接命中）
   * - 删 negCache / hitTimestamps（避免 30s 负缓存继续放行、避免历史计数干扰）
   */
  async manuallyBlock(ip: string, reason = "manual"): Promise<number> {
    await this.waitForInit();
    if (!this.store) throw new Error("黑名单持久化不可用，无法手动拉黑");
    const nip = normalizeIp(ip);
    const now = Date.now();
    const blockCount = await this.store.manuallyBlock(nip, reason, now);
    this.posCache.set(nip, { expiresAt: now + POS_CACHE_TTL_MS });
    this.negCache.delete(nip);
    this.hitTimestamps.delete(nip);
    this.probeCounts.delete(nip); // 重拉黑：清除历史探测计数，从新档位重新累计
    loggers.api?.info?.("IP 手动拉黑（管理页）", { ip: nip, reason, blockCount });
    return blockCount;
  }

  /**
   * 手动移除黑名单（2026-08-25 管理页"移除"按钮）。
   * 删掉 Turso 行并清理缓存，确保下一次 isBlocked 立即放行。
   * @returns 是否确实删除了条目
   */
  async removeBlock(ip: string): Promise<boolean> {
    await this.waitForInit();
    if (!this.store) throw new Error("黑名单持久化不可用，无法移除");
    const nip = normalizeIp(ip);
    const removed = await this.store.removeBlock(nip);
    this.posCache.delete(nip);
    this.negCache.delete(nip);
    this.hitTimestamps.delete(nip);
    this.probeCounts.delete(nip);
    if (removed) {
      loggers.api?.info?.("IP 手动移除黑名单（管理）", { ip: nip });
    }
    return removed;
  }

  /**
   * 记录一次"真人命中蜜罐"（2026-09-03 反馈解封闭环）。
   * 由 search 端点蜜罐拦截分支在解出 openid 后异步调用（fire-and-forget，
   * 纯写不读、失败静默），把 (openid, ip) 关联落库供管理端反查。
   */
  async recordHoneypotHit(
    openid: string,
    ip: string
  ): Promise<boolean> {
    // 空 openid/ip（爬虫或异常）直接短路，连 store 调用都不发（热路径）
    if (!(openid || "").trim() || !(ip || "").trim()) return false;
    await this.waitForInit();
    if (!this.store) return false;
    try {
      return await this.store.recordHoneypotHit(openid, ip, Date.now());
    } catch (err) {
      loggers.api?.warn?.("蜜罐命中记录失败（静默）", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** 管理反查：某 openid 最近命中过蜜罐的 IP 列表（honeypot_hits） */
  async listHoneypotByOpenid(
    openid: string,
    limit?: number
  ): Promise<{ ip: string; hits: number; lastAt: number }[]> {
    await this.waitForInit();
    if (!this.store) return [];
    try {
      return await this.store.listHoneypotByOpenid(openid, limit);
    } catch (err) {
      loggers.api?.warn?.("openid 蜜罐反查失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 管理反查：某 IP 最近影响了哪些 openid（黑名单条目关联） */
  async listHoneypotByIp(
    ip: string,
    limit?: number
  ): Promise<{ openid: string; hits: number; lastAt: number }[]> {
    await this.waitForInit();
    if (!this.store) return [];
    try {
      return await this.store.listHoneypotByIp(ip, limit);
    } catch (err) {
      loggers.api?.warn?.("IP 蜜罐反查失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 按多个 IP 批量查黑名单状态（2026-09-03 openid 反查用，IN 一次查询）。
   */
  async listStatusByIps(
    ips: string[]
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
    await this.waitForInit();
    if (!this.store) return [];
    try {
      return await this.store.listStatusByIps(ips, Date.now());
    } catch (err) {
      loggers.api?.warn?.("按 IP 批量查黑名单状态失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 管理排查：黑名单全部条目（封禁中 + 惯犯档案），按最近活动倒序。
   * 支持 IP 模糊搜索、状态筛选、offset 分页（2026-08-26）。
   * 不依赖 BOT_DEFENSE_ENFORCE 开关（管理侧只看数据，不拦截）。
   */
  async listEntries(
    limit = 100,
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
    if (!this.store) return { items: [], total: 0 };
    try {
      const { items, total } = await this.store.listEntries(
        Date.now(),
        limit,
        opts
      );
      return { items, total };
    } catch (err) {
      loggers.api?.warn?.("黑名单列表查询失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { items: [], total: 0 };
    }
  }

  /**
   * 记录一次拒绝事件（IP 命中拦截规则时被调用）。
   * - 入 store 累计 hit_count
   * - 在 60s 滑动窗口内累计达 5 次 → 自动 extendBlock（24h 拉黑）
   *
   * 完全静默：拦截 hot path 不因持久化失败拖慢。
   */
  async recordRejection(
    ip: string,
    reason: RejectReason,
    now: number = Date.now()
  ): Promise<void> {
    if (!this.isUsableIp(ip)) return;
    await this.waitForInit();
    const nip = normalizeIp(ip);
    if (!this.store) return;

    // 1. 滑动窗口累计（仅用于阈值判定，不入库）
    const recent = (this.hitTimestamps.get(nip) ?? []).filter(
      (t) => now - t <= HOT_WINDOW_MS
    );
    recent.push(now);
    this.hitTimestamps.set(nip, recent);

    // 2. 入库累计 hit_count（持久化）
    try {
      const { hitCount: storedCount } = await this.store.recordRejection(
        nip,
        reason,
        now
      );

      // 3. 阈值判定（用持久化命中次数，与滑动窗口交叉确认）
      const shouldBlock =
        storedCount >= HOT_THRESHOLD || recent.length >= HOT_THRESHOLD;

      if (shouldBlock) {
        const blockCount = await this.store.extendBlock(nip, reason, now);
        // 立刻写 pos cache，5min 内 isBlocked 直接走缓存
        this.posCache.set(nip, { expiresAt: now + POS_CACHE_TTL_MS });
        this.negCache.delete(nip);
        this.hitTimestamps.delete(nip);
        loggers.search?.warn?.("IP 拉黑（阈值）", {
          ip: nip,
          reason,
          hitCount: storedCount,
          recentInWindow: recent.length,
          // 分级封禁档位（2026-08-25）：blockCount 1→24h，2→7 天，>=3→30 天
          blockCount,
        });
      }
    } catch (err) {
      // 持久化失败不阻挡主流程
      loggers.api?.warn?.("recordRejection 失败", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 管理概览的黑名单统计（2026-08-26 流量概览面板）。
   * 转发 store.getOverviewStats；持久化不可用时返回空统计（不报错）。
   */
  async getOverviewStats(
    days = 7,
    topLimit = 10
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
    if (!this.store) {
      return { total: 0, blocked: 0, todayActive: 0, topIps: [] };
    }
    try {
      return await this.store.getOverviewStats(days, topLimit, Date.now());
    } catch (err) {
      loggers.api?.warn?.("黑名单概览统计失败", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { total: 0, blocked: 0, todayActive: 0, topIps: [] };
    }
  }

  /** 启动周期维护（懒启动：首次获取服务时由 factory 触发）。
   *  2026-09-03 拆分为三个独立定时器，把 DB 读频降到每天 25 次左右：
   *  - 黑名单表 prune 1h 一次（原来 5min → 288 次/天 DB 往返）
   *  - 内存 pos/neg 缓存清扫保持 5min（纯本地，零 DB）
   *  - 蜜罐命中清理 24h 一次（保留期 90 天，无需高频）
   */
  startMaintenance(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      void this.prune();
    }, PRUNE_INTERVAL_MS);
    this.cacheTimer = setInterval(() => {
      this.cleanExpiredCache();
    }, MEM_CACHE_CLEAN_INTERVAL_MS);
    this.honeypotTimer = setInterval(() => {
      void this.pruneHoneypot();
    }, HONEYPOT_PRUNE_INTERVAL_MS);
    // unref：不让定时器阻止进程退出（vitest / CLI 场景）
    for (const t of [this.pruneTimer, this.cacheTimer, this.honeypotTimer]) {
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** 主表过期清理：只删"从未被正式拉黑（block_count=0）"且已过期的计数短记录 */
  private async prune(): Promise<void> {
    if (!this.store) return;
    try {
      const now = Date.now();
      const deleted = await this.store.pruneExpired(now);
      if (deleted > 0) {
        console.log(`[BotDefenseService] prune 过期条目 ${deleted} 条`);
      }
    } catch (err) {
      console.log(
        "[BotDefenseService] prune 失败:",
        err instanceof Error ? err.message : err
      );
    }
  }

  /** 蜜罐命中记录清理（保留 90 天；低频每天一次，反馈反查只关心近期） */
  private async pruneHoneypot(): Promise<void> {
    if (!this.store) return;
    try {
      const hDeleted = await this.store.pruneHoneypotHits(Date.now());
      if (hDeleted > 0) {
        console.log(`[BotDefenseService] prune 过期蜜罐命中 ${hDeleted} 条`);
      }
    } catch (e) {
      loggers.api?.warn?.("prune 蜜罐命中失败", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 清掉已过期的内存缓存条目（TTL 过期重建；纯本地，无 DB） */
  private cleanExpiredCache(): void {
    const now = Date.now();
    for (const [k, v] of this.posCache) {
      if (v.expiresAt <= now) this.posCache.delete(k);
    }
    for (const [k, v] of this.negCache) {
      if (v.expiresAt <= now) this.negCache.delete(k);
    }
  }

  /** 测试用：清空所有缓存与状态 */
  reset(): void {
    this.posCache.clear();
    this.negCache.clear();
    this.hitTimestamps.clear();
    this.probeCounts.clear();
    this.inflightBlocked.clear();
  }

  getStoreType(): "turso" | "unavailable" {
    return this.storeType;
  }
}

export function getOrCreateBotDefenseService(): BotDefenseService {
  const ctx = (globalThis as any)[BOT_DEFENSE_SERVICE_KEY];
  if (ctx?.service) {
    ctx.service.startMaintenance();
    return ctx.service;
  }
  const service = new BotDefenseService();
  (globalThis as any)[BOT_DEFENSE_SERVICE_KEY] = { service };
  service.startMaintenance();
  return service;
}
