import type { H3Event } from "h3";
import { getCookie, getRequestHeader } from "h3";
import { loggers } from "../core/utils/logger";

/**
 * wx-auth 统一登录态校验（服务端，2026-08-28 起为唯一认证通道）
 *
 * 凭证两来源，均由 wx-auth 签发、wx-auth /api/auth/check 权威校验：
 * - 小程序：Authorization: Bearer <wx-auth token>（wx-auth /api/auth/mp-login 签发）
 * - 网页端：cookie wxauth-token（wx-auth-sdk 关注公众号 + 验证码后种下）
 *
 * check 响应（新版 wx-auth 附带用户身份）：
 * - authenticated: true → 放行，user 里带身份：
 *   - user.openid   全局唯一身份（小程序用户形如 mp:oXXXX，公众号用户是 oXXXX）
 *   - user.type     "mp"（小程序）/ "official"（公众号）
 *   - user.mpOpenid 小程序用户的裸 openid（资料存 wx-auth 账号系统，panhub 不再本地存储）
 *   老调用方（如 parse）只读 authenticated，不受影响。
 *
 * 关键设计（2026-08-26 用户拍板：写死强制，移除开关）：
 * 1. **写死强制**：不再有 WX_AUTH_ENFORCE 开关，生产环境所有搜索请求
 *    必须带有效 wxauth 凭证（本地 dev 由 requireWxAuth 统一放行）
 * 2. **实时校验、不缓存**：取消关注 = 退出登录，取消搜索立即 401，
 *    绝不把已失效的登录态当有效（用户明确要求）
 *    （跨请求短 TTL 缓存仅存在于 verifyWxAuthOnceCached，见下）
 * 3. 请求内去重：同一次请求（搜索）内只查一次（前端一次搜索会并发
 *    多个 /api/search 子请求，靠 event.context 标记避免同打远程；
 *    这是请求内复用，不是跨请求缓存）
 * 4. **服务故障 fail-closed**：wx-auth 服务不可达/超时/非 2xx → 拒绝，
 *    打 warn 日志便于观察（宁可误伤，不裸奔——用户拍板）
 * 5. 无凭证 / 校验失败 → 返回 false（拒绝）
 */

const WX_AUTH_API_BASE = process.env.WX_AUTH_API_BASE || "https://wx-auth.shenzjd.com";
const WX_AUTH_CHECK_TIMEOUT_MS = 5000;

/** check 响应里的用户身份（新版 wx-auth 提供） */
export interface WxAuthUser {
  /** 全局唯一身份：小程序用户形如 mp:oXXXX，公众号用户是 oXXXX */
  openid: string;
  /** "mp"（小程序）/ "official"（公众号） */
  type: string;
  /** 小程序用户的裸 openid（wx-auth 账号体系身份）；公众号用户为 null */
  mpOpenid: string | null;
}

/** 从请求头提取 Bearer token（小程序 wx-auth token），无则返回 null */
export function getBearerToken(event: H3Event): string | null {
  const auth = getRequestHeader(event, "authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

/** 从请求中提取 wxauth cookie 凭证（token 优先，openid 兜底） */
export function getWxAuthCredential(event: H3Event): { token?: string; openid?: string } {
  const token = getCookie(event, "wxauth-token");
  const openid = getCookie(event, "wxauth-openid");
  if (token) return { token };
  if (openid) return { openid };
  return {};
}

/** 统一凭证：Bearer（小程序/通用）优先，其次 cookie token/openid */
interface Credential {
  kind: "bearer" | "token" | "openid";
  value: string;
}

function getCredential(event: H3Event): Credential | null {
  const bearer = getBearerToken(event);
  if (bearer) return { kind: "bearer", value: bearer };
  const cred = getWxAuthCredential(event);
  if (cred.token) return { kind: "token", value: cred.token };
  if (cred.openid) return { kind: "openid", value: cred.openid };
  return null;
}

/** 调 wx-auth /api/auth/check（Bearer 走 Authorization 头，cookie 凭证走 query）。远程故障时 fail-closed。 */
async function remoteCheck(cred: Credential): Promise<{ ok: boolean; user?: WxAuthUser }> {
  const isBearer = cred.kind === "bearer";
  const url = isBearer
    ? `${WX_AUTH_API_BASE}/api/auth/check`
    : `${WX_AUTH_API_BASE}/api/auth/check?${cred.kind}=${encodeURIComponent(cred.value)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WX_AUTH_CHECK_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: isBearer
        ? { accept: "application/json", authorization: `Bearer ${cred.value}` }
        : { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      // 2026-08-26：非 2xx 由"降级放行"改为 fail-closed 拒绝（用户拍板：宁可误伤，不裸奔）
      loggers.api.warn?.("wx-auth check 非 2xx，fail-closed 拒绝", { status: res.status });
      return { ok: false };
    }
    const data = (await res.json()) as {
      authenticated?: boolean;
      user?: { openid?: string; type?: string; mpOpenid?: string | null };
    };
    if (data.authenticated === true) {
      // 2026-08-28：check 响应带用户身份（openid/type/mpOpenid），
      // mpOpenid 是小程序用户的裸 openid（资料已收编 wx-auth，panhub 不再本地存头像昵称）
      const u = data.user;
      const user: WxAuthUser | undefined = u?.openid
        ? {
            openid: u.openid,
            type: u.type ?? "",
            mpOpenid: u.mpOpenid ?? null,
          }
        : undefined;
      return { ok: true, user };
    }
    return { ok: false };
  } catch (err) {
    // 网络错误/超时 → 2026-08-26 起 fail-closed 拒绝（宁可误伤，不裸奔），打日志便于观察
    loggers.api.warn?.("wx-auth check 请求失败，fail-closed 拒绝", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** 调 wx-auth /api/auth/check，返回是否已认证。远程故障时 fail-closed（返回 false）并打日志。 */
export async function verifyWxAuthCredential(event: H3Event): Promise<boolean> {
  const cred = getCredential(event);
  if (!cred) {
    loggers.api.debug?.("wx-auth 无凭证");
    return false;
  }

  const { ok, user } = await remoteCheck(cred);
  if (ok) {
    // 2026-08-25：check 响应带回 openid，存请求上下文供搜索日志
    // 关联"哪个 openid 搜了什么"（见 recordSearchTerm）
    if (user?.openid) {
      (event.context as Record<string, any>).__wxAuthOpenid = user.openid;
    }
  }
  return ok;
}

/** 请求内去重：同一次请求只校验一次 wx-auth（结果存 event.context） */
export async function verifyWxAuthOnce(event: H3Event): Promise<boolean> {
  const ctx = (event.context as Record<string, any>) || {};
  if (typeof ctx.__wxAuthVerified === "boolean") return ctx.__wxAuthVerified;
  const ok = await verifyWxAuthCredential(event);
  ctx.__wxAuthVerified = ok;
  return ok;
}

/**
 * 跨请求短 TTL 缓存（2026-08-24 新增，修复 WX_AUTH_ENFORCE=1 时"认证后反复弹验证码"）
 *
 * 背景：一次搜索前端并发 35+ 子请求（countOnly + 各 batch + 各插件），每个子请求
 * 都走 verifyWxAuthOnce → 实时调 wx-auth /api/auth/check。而 wx-auth 的 check 按 IP
 * 限流 query 类型 30 次/分钟，一次搜索 40+ 次调用直接打爆 → rate_limited →
 * authenticated:false → 后端 401 → 前端 forceVerify 反复弹验证码弹窗。
 *
 * 修复：同一 credential（token/openid）在 WX_AUTH_CACHE_TTL_MS 内只调一次远程，
 * 其余子请求命中缓存（含 false 结果，TTL 内同一 token 反复失败也按 401 处理，
 * 前端 forceVerify 会重发新 token，天然绕开旧缓存）。
 *
 * TTL 10s → 10min（2026-08-25 用户拍板）：
 * - 用户关注+验证码后 token 本身 1 年有效，登录态稳定；会话级 10min 缓存
 *   让同一用户任意连续搜索不再反复调远程（check 调用量从日 2-3k 降到
 *   ~唯一用户数/10min）
 * - 取舍：取消关注后最长 10min 内仍可搜（由"实时校验"放宽为"10min 内
 *   生效"）；管理员标记变更同样最长 10min 生效（isAdminUser 独立 10min 缓存）
 * - 攻击面不因缓存延长而增大：wxauth-token 本身 1 年有效，攻击者拿到
 *   token 可直调 check 绕过本地缓存，缓存长短不影响 token 有效期
 */
const WX_AUTH_CACHE_TTL_MS = 10 * 60_000;
const wxAuthCache = new Map<
  string,
  { ok: boolean; user?: WxAuthUser; expiresAt: number }
>();

/** 测试用：清空跨请求缓存 */
export function resetWxAuthCache(): void {
  wxAuthCache.clear();
  adminCache.clear();
}

/** 管理权限 TTL 缓存（userinfo 注释建议 5~10 分钟；管理员标记变化极低频） */
const WX_AUTH_USERINFO_TTL_MS = 10 * 60_000;
const adminCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

/**
 * 管理权限校验（2026-08-25 用户拍板：不用密码/key/白名单配置，
 * 直接用 wx-auth 返回的管理员标记）：
 * 调 wx-auth /api/auth/userinfo（带 wxauth-token cookie）→ user.isAdmin。
 * - 是管理员 → true；非管理员/未登录/服务异常 → false（fail-closed）
 * - 10min TTL 缓存（同一 token 不重复打远程；管理员标记几乎不变）
 */
export async function isAdminUser(event: H3Event): Promise<boolean> {
  const cred = getWxAuthCredential(event);
  if (!cred.token) return false;
  const now = Date.now();
  const hit = adminCache.get(cred.token);
  if (hit && hit.expiresAt > now) return hit.isAdmin;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WX_AUTH_CHECK_TIMEOUT_MS);
    const res = await fetch(
      `${WX_AUTH_API_BASE}/api/auth/userinfo?token=${encodeURIComponent(cred.token)}`,
      { signal: controller.signal, headers: { accept: "application/json" } }
    );
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as { user?: { isAdmin?: boolean } };
    const isAdmin = data.user?.isAdmin === true;
    adminCache.set(cred.token, { isAdmin, expiresAt: now + WX_AUTH_USERINFO_TTL_MS });
    // 防 Map 无限膨胀：超 5k 时清掉过期条目
    if (adminCache.size > 5_000) {
      for (const [k, v] of adminCache) {
        if (v.expiresAt <= now) adminCache.delete(k);
      }
    }
    return isAdmin;
  } catch {
    // 管理接口 fail-closed：userinfo 不可达也拒绝（宁可不可用，不裸奔）
    return false;
  }
}

export async function verifyWxAuthOnceCached(event: H3Event): Promise<boolean> {
  const ctx = (event.context as Record<string, any>) || {};
  if (typeof ctx.__wxAuthVerified === "boolean") return ctx.__wxAuthVerified;

  const cred = getCredential(event);
  if (!cred) {
    ctx.__wxAuthVerified = false;
    return false;
  }
  const cacheKey = `${cred.kind}:${cred.value}`;
  const now = Date.now();

  const hit = wxAuthCache.get(cacheKey);
  let result: { ok: boolean; user?: WxAuthUser };
  if (hit && hit.expiresAt > now) {
    result = { ok: hit.ok, user: hit.user };
  } else {
    result = await remoteCheck(cred);
    wxAuthCache.set(cacheKey, {
      ok: result.ok,
      user: result.user,
      expiresAt: now + WX_AUTH_CACHE_TTL_MS,
    });
    // 防 Map 无限膨胀：超 10k 时清掉过期条目
    if (wxAuthCache.size > 10_000) {
      for (const [k, v] of wxAuthCache) {
        if (v.expiresAt <= now) wxAuthCache.delete(k);
      }
    }
  }

  ctx.__wxAuthVerified = result.ok;
  // 2026-08-25：缓存命中也要恢复 openid（搜索日志关联用）
  if (result.ok && result.user) {
    ctx.__wxAuthOpenid = result.user.openid;
    ctx.__wxAuthUser = result.user;
  }
  return result.ok;
}

/**
 * 从 Bearer token 解出已认证用户（小程序登录态，2026-08-28 新增）
 *
 * 走 wx-auth /api/auth/check（Authorization: Bearer），复用跨请求缓存。
 * 有效 → 返回用户身份（含 openid / mpOpenid）；
 * 无 Bearer / 未认证 / 服务故障 → null（调用方 401，fail-closed）。
 */
export async function getWxAuthUserFromBearer(
  event: H3Event
): Promise<WxAuthUser | null> {
  const bearer = getBearerToken(event);
  if (!bearer) return null;

  const cacheKey = `bearer:${bearer}`;
  const now = Date.now();
  const hit = wxAuthCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.ok ? (hit.user ?? null) : null;
  }

  const result = await remoteCheck({ kind: "bearer", value: bearer });
  wxAuthCache.set(cacheKey, {
    ok: result.ok,
    user: result.user,
    expiresAt: now + WX_AUTH_CACHE_TTL_MS,
  });
  if (wxAuthCache.size > 10_000) {
    for (const [k, v] of wxAuthCache) {
      if (v.expiresAt <= now) wxAuthCache.delete(k);
    }
  }
  return result.ok ? (result.user ?? null) : null;
}
