import { defineEventHandler, getQuery, createError } from "h3";
import { getSearchLogStore } from "../core/services/tursoSearchLogStore";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";
import { withAdminCache, ADMIN_LIST_TTL_MS } from "../core/cache/adminReadCache";

/**
 * 搜索明细管理查询 API（2026-08-25 用户拍板：排查"哪个 openid 搜了什么"）
 *
 * 鉴权（用户拍板：**不用密码、不用 key、不用白名单配置**，
 * 直接用 wx-auth 返回的管理员标记）：
 * - 请求带 wxauth cookie → isAdminUser 调 wx-auth /api/auth/userinfo
 *   （返回 user.isAdmin，10min TTL 缓存）→ 管理员放行
 * - 区分（2026-08-25）：无 wxauth-token cookie → 401（未登录，请先到
 *   首页完成关注公众号）；是登录态但非管理员 → 403
 * - userinfo 不可达 → 403（fail-closed，管理接口宁可不可用不裸奔）
 *
 * 用法：
 *   GET /api/search-log?openid=<openid>&limit=50&days=7
 *     → 某 openid 最近搜了什么（term/ip/createdAt，时间倒序）
 *   GET /api/search-log?term=<词>&limit=50&days=7
 *     → 搜过该词的所有 openid/ip（时间倒序）
 *   GET /api/search-log?ip=<IP>&limit=50&days=7
 *     → 该 IP 最近搜过什么（term/openid/createdAt，时间倒序；2026-08-26 新增）
 *
 * 数据为个人搜索历史，严禁暴露给前端页面（仅管理端排查用）。
 */

export default defineEventHandler(async (event) => {
  // ---- 鉴权：wx-auth 管理员标记（2026-08-25 用户拍板，无任何配置）----
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const store = getSearchLogStore();
  if (!store) {
    throw createError({ statusCode: 503, statusMessage: "search log store unavailable" });
  }

  const q = getQuery(event);
  const limit = Math.min(Math.max(1, parseInt(String(q.limit || "50"), 10) || 50), 200);
  const offset = Math.max(0, parseInt(String(q.offset || "0"), 10) || 0);
  const daysRaw = parseInt(String(q.days || ""), 10);

  const targetOpenid = String(q.openid || "").trim().slice(0, 128);
  const term = String(q.term || "").trim().slice(0, 200);
  const ip = String(q.ip || "").trim().slice(0, 64);

  const given = [targetOpenid, term, ip].filter(Boolean).length;
  if (given !== 1) {
    throw createError({ statusCode: 400, statusMessage: "openid / term / ip 只能三选一" });
  }
  if (!targetOpenid && !term && !ip) {
    throw createError({ statusCode: 400, statusMessage: "需提供 openid / term / ip 参数" });
  }

  // 读缓存（2026-09-01）：明细 SELECT + COUNT 两条查询按条件缓存 30s。
  // 缓存 key 用 days 而非精确 since（滚动时间戳每毫秒都变会导致永远 miss），
  // since 在 fetcher 内现算，TTL 内窗口最多滞后 30s，排查场景无感知。
  const daysKey = Number.isFinite(daysRaw) && daysRaw >= 1 ? daysRaw : "all";
  const computeSince = () =>
    Number.isFinite(daysRaw) && daysRaw >= 1 ? Date.now() - daysRaw * 86400000 : undefined;

  if (targetOpenid) {
    const cached = await withAdminCache(
      `admin:searchlog:openid:${targetOpenid}:${limit}:${offset}:${daysKey}`,
      ADMIN_LIST_TTL_MS,
      async () => {
        const since = computeSince();
        return {
          items: await store.searchByOpenid(targetOpenid, limit, since, offset),
          total: await store.countSearch("openid", targetOpenid, since),
        };
      }
    );
    return {
      code: 0,
      message: "success",
      data: { mode: "openid", openid: targetOpenid, items: cached.items, total: cached.total },
    };
  }

  if (term) {
    const cached = await withAdminCache(
      `admin:searchlog:term:${term}:${limit}:${offset}:${daysKey}`,
      ADMIN_LIST_TTL_MS,
      async () => {
        const since = computeSince();
        return {
          items: await store.searchByTerm(term, limit, since, offset),
          total: await store.countSearch("term", term, since),
        };
      }
    );
    return {
      code: 0,
      message: "success",
      data: { mode: "term", term, items: cached.items, total: cached.total },
    };
  }

  const cached = await withAdminCache(
    `admin:searchlog:ip:${ip}:${limit}:${offset}:${daysKey}`,
    ADMIN_LIST_TTL_MS,
    async () => {
      const since = computeSince();
      return {
        items: await store.searchByIp(ip, limit, since, offset),
        total: await store.countSearch("ip", ip, since),
      };
    }
  );
  return {
    code: 0,
    message: "success",
    data: { mode: "ip", ip, items: cached.items, total: cached.total },
  };
});
