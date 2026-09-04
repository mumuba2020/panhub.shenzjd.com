import { defineEventHandler, getQuery, createError } from "h3";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { isAdminUser, getWxAuthCredential } from "../utils/wxAuthCheck";
import { withAdminCache, ADMIN_LIST_TTL_MS } from "../core/cache/adminReadCache";

/**
 * IP 黑名单管理查询 API（2026-08-25 管理页"IP 黑名单" tab 数据源；2026-08-26 加分页筛选）
 *
 * 鉴权：与 /api/search-log 一致 —— wx-auth isAdminUser（管理员标记）。
 * 区分（2026-08-25）：无 wxauth-token cookie → 401（未登录，请先到首页
 * 完成关注公众号）；是登录态但非管理员 → 403。
 *
 * 参数：
 *   limit  - 每页条数（默认 100，上限 500）
 *   offset - 分页偏移（2026-08-26 新增）
 *   ip     - IP 子串模糊搜索（2026-08-26 新增）
 *   status - blocked（仅封禁中）| free（仅已解封）| 缺省全部（2026-08-26 新增）
 *
 * 返回：{ now, items, total }
 *   items 已附带 blocked（是否封禁中）/ remainingMs（剩余封禁时长）
 *   total 为当前筛选条件下的总条数（供前端分页）
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const q = getQuery(event);
  const limit = Math.min(Math.max(1, parseInt(String(q.limit || "100"), 10) || 100), 500);
  const offset = Math.max(0, parseInt(String(q.offset || "0"), 10) || 0);
  const ipFilter = String(q.ip || "").trim().slice(0, 64);
  const statusRaw = String(q.status || "").trim();
  const status =
    statusRaw === "blocked" || statusRaw === "free" ? statusRaw : undefined;

  // 读缓存（2026-09-01）：按筛选条件缓存原始列表 30s（COUNT + SELECT 两条查询）；
  // blocked/remainingMs 用当前时间在缓存外计算，缓存命中时剩余时长依然新鲜。
  // 黑名单 post/delete 写操作会主动失效本缓存。
  const cacheKey = `admin:blacklist:${limit}:${offset}:${ipFilter}:${status ?? "all"}`;
  const { items, total } = await withAdminCache(cacheKey, ADMIN_LIST_TTL_MS, () =>
    getOrCreateBotDefenseService().listEntries(limit, { ipFilter, status, offset })
  );

  const now = Date.now();
  const enriched = items.map((it) => ({
    ...it,
    blocked: it.expiresAt > now, // 是否仍在封禁期
    remainingMs: it.expiresAt > now ? it.expiresAt - now : 0, // 剩余封禁时长
  }));

  return {
    code: 0,
    message: "success",
    data: { now, items: enriched, total },
  };
});