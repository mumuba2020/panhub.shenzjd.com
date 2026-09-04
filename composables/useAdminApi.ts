/**
 * 管理后台 API 封装（2026-08-25 admin 规范化重构）
 *
 * 统一处理：
 * - /api/search-log：搜索记录查询（按 openid / 按词）
 * - /api/blacklist：黑名单查询 / 手动拉黑 / 移除
 * - 鉴权状态：401 → no-login（未登录）、403 → no-admin（非管理员）、
 *   其他错误 → 抛出含 message 的 Error
 *
 * 页面只需关心返回数据，不用重复写状态码分支。
 */

export type AdminAuthStatus = "checking" | "ok" | "no-login" | "no-admin" | "error";

/** 搜索记录条目 */
export interface SearchLogItem {
  term?: string;
  openid?: string;
  ip?: string;
  createdAt?: number;
}

/** 黑名单条目 */
export interface BlacklistItem {
  ip: string;
  reason?: string;
  hitCount?: number;
  blockCount?: number;
  firstAt?: number;
  lastAt?: number;
  expiresAt?: number;
  blocked?: boolean;
  remainingMs?: number;
}

/** 频道配置（管理面板全量视图，含 priority） */
export interface ChannelAdminData {
  version: number;
  priorityChannels: string[];
  defaultChannels: string[];
  /** 频道备注名映射（ID → 显示名/备注），可空 */
  channelNames: Record<string, string>;
  priorityCount: number;
  defaultCount: number;
}

/** 409 之外的错误会被包装为 AdminApiError（serverMessage 来自后端 message） */
export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/** 全站共享的鉴权状态（模块级单例，见 useAdminApi 内注释） */
const sharedAuthStatus = ref<AdminAuthStatus>("checking");
/** checkAdminAuth 失败原因（error 态时给页面展示用） */
const sharedProbeError = ref("");

export function useAdminApi() {
  // 鉴权状态为模块级单例（2026-09-02）：布局层（layouts/admin.vue 的鉴权门）
  // 与各面板的 useAdminApi() 共享同一份状态——任何面板的接口 401/403 都会
  // 驱动布局层统一反应（踢去登录页/提示无权限），而不是各面板各自为战。
  // 仅客户端可变（probeAuth/request 均在 onMounted 后调用），SSR 无跨请求污染。
  const authStatus = sharedAuthStatus;
  const probeError = sharedProbeError;

  async function request<T = any>(url: string, init?: RequestInit): Promise<T> {
    // credentials: "same-origin" 显式声明：管理接口靠 wxauth-token cookie 鉴权，
    // 必须确保每次请求携带 cookie（同源默认也带，但显式声明排除一切边角情况）
    const res = await fetch(url, { ...init, credentials: "same-origin" });
    if (res.status === 401) {
      authStatus.value = "no-login";
      throw new AdminApiError(401, "未登录");
    }
    if (res.status === 403) {
      authStatus.value = "no-admin";
      throw new AdminApiError(403, "无权限");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new AdminApiError(res.status, data?.message || `请求失败（HTTP ${res.status}）`);
    }
    const data = await res.json();
    if (data?.code !== 0) {
      throw new AdminApiError(200, data?.message || "业务处理失败");
    }
    return data.data as T;
  }

  /** 是否存在 wxauth-token cookie（纯本地判断，不发请求、不碰 SDK） */
  function hasTokenCookie(): boolean {
    return typeof document !== "undefined" && /(?:^|;\s*)wxauth-token=/.test(document.cookie);
  }

  /**
   * 管理员鉴权探测（2026-09-02 重写，流程极简）：
   *   没有 cookie → no-login（前端直接去登录页，不发请求）
   *   有 cookie   → GET /api/admin/auth 一次出结论：
   *                 200 → ok（是管理员，直接进）
   *                 401 → no-login（token 无效/过期，去登录页）
   *                 403 → no-admin（已登录但非管理员）
   *   其他异常    → error（网络等，展示重试）
   *
   * 不调用 wx-auth SDK 的 silentCheck——它拿 localStorage 里可能残留的
   * 小程序 mp: token 去校验，失败时会删掉整个 wxauth-token cookie
   * （连刚扫码登录的新 token 一起没），是一切"时好时坏"问题的根源。
   */
  async function checkAdminAuth(): Promise<AdminAuthStatus> {
    authStatus.value = "checking";
    probeError.value = "";
    if (!hasTokenCookie()) {
      authStatus.value = "no-login";
      return authStatus.value;
    }
    try {
      await request("/api/admin/auth");
      authStatus.value = "ok";
    } catch (e: any) {
      // 401/403 已由 request 写入 authStatus（明确的鉴权结论）
      if (authStatus.value === "checking") {
        authStatus.value = "error";
        probeError.value = e?.message || "登录状态检测失败";
      }
    }
    return authStatus.value;
  }

  /** 搜索记录查询 */
  async function querySearchLog(opts: {
    mode: "openid" | "term" | "ip";
    keyword: string;
    days?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ mode: string; items: SearchLogItem[]; total: number }> {
    const q = new URLSearchParams();
    q.set(opts.mode, opts.keyword.trim());
    q.set("limit", String(opts.limit ?? 100));
    if (opts.offset) q.set("offset", String(opts.offset));
    if (opts.days) q.set("days", opts.days);
    return request(`/api/search-log?${q.toString()}`);
  }

  /**
   * 蜜罐命中反查（2026-09-03 用户反馈解封闭环）：
   * - openid：反查该 openid 最近命中过蜜罐的 IP + 各 IP 封禁状态
   * - ip：反查该 IP 最近影响了哪些 openid
   */
  async function lookupHoneypot(opts: {
    openid?: string;
    ip?: string;
    limit?: number;
  }): Promise<any> {
    const q = new URLSearchParams();
    if (opts.openid) q.set("openid", opts.openid.trim());
    if (opts.ip) q.set("ip", opts.ip.trim());
    if (opts.limit) q.set("limit", String(opts.limit));
    return request(`/api/blacklist-lookup?${q.toString()}`);
  }

  /** 黑名单列表（支持 IP 模糊搜索、状态筛选、分页） */
  async function loadBlacklist(opts: {
    limit?: number;
    offset?: number;
    ip?: string;
    status?: "blocked" | "free" | "";
  } = {}): Promise<{ now: number; items: BlacklistItem[]; total: number }> {
    const q = new URLSearchParams();
    q.set("limit", String(opts.limit ?? 100));
    if (opts.offset) q.set("offset", String(opts.offset));
    if (opts.ip?.trim()) q.set("ip", opts.ip.trim());
    if (opts.status) q.set("status", opts.status);
    return request(`/api/blacklist?${q.toString()}`);
  }

  /** 手动拉黑 */
  async function blockIp(ip: string, reason = "manual"): Promise<{ blockCount: number }> {
    return request("/api/blacklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, reason }),
    });
  }

  /** 移除黑名单 */
  async function removeIp(ip: string): Promise<{ removed: boolean }> {
    return request(`/api/blacklist?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
  }

  /** 频道配置全量（含 priority 频道） */
  async function loadChannels(): Promise<ChannelAdminData> {
    return request("/api/admin/channels");
  }

  /** 频道配置全量保存（CRUD 提交：priority/default 互斥已由服务端处理） */
  async function saveChannels(payload: {
    priorityChannels: string[];
    defaultChannels: string[];
    channelNames?: Record<string, string>;
  }): Promise<{ version: number; priorityCount: number; defaultCount: number }> {
    return request("/api/admin/channels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** 频道配置重载（强制重新拉取，不重启进程） */
  async function reloadChannels(): Promise<{
    version: number;
    priorityCount: number;
    defaultCount: number;
  }> {
    return request("/api/admin/channels/reload", { method: "POST" });
  }

  /** 流量概览统计（搜索 + 黑名单两块聚合，只读） */
  async function loadStats(): Promise<{
    search: {
      todayCount: number;
      todayTerms: number;
      trend: { date: string; count: number }[];
      topTerms: { term: string; count: number }[];
    };
    defense: {
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
    };
  }> {
    return request("/api/admin/stats");
  }

  return { authStatus, probeError, hasTokenCookie, checkAdminAuth, request, querySearchLog, loadBlacklist, blockIp, removeIp, loadChannels, saveChannels, reloadChannels, loadStats, lookupHoneypot };
}