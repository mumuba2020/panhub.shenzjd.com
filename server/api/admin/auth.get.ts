import { defineEventHandler, createError } from "h3";
import { verifyWxAuthOnceCached, isAdminUser } from "../../utils/wxAuthCheck";

/**
 * 管理后台鉴权探测 API（2026-09-02 新增）
 *
 * 前端流程（layouts/admin.vue / pages/admin/login.vue 共用）：
 *   1. 前端先看有没有 wxauth-token cookie（纯本地判断，没有就直接去登录页）
 *   2. 有 cookie → 打本接口，服务端一次出结论：
 *      - token 无效/过期（wx-auth check 不通过）→ 401 → 前端跳登录页
 *      - 已登录但非管理员（wx-auth userinfo 的 isAdmin 标记）→ 403 → 前端显示无权限
 *      - 是管理员 → 200 → 直接进后台
 *
 * 结论只有这三种，前端不需要再猜。check/userinfo 均走 wxAuthCheck 的
 * 跨请求 TTL 缓存，正常一次进后台只打一次远程。
 */
export default defineEventHandler(async (event) => {
  // token 有效性（wx-auth /api/auth/check，10min TTL 缓存）
  if (!(await verifyWxAuthOnceCached(event))) {
    throw createError({ statusCode: 401, statusMessage: "token invalid or expired" });
  }
  // 管理员标记（wx-auth /api/auth/userinfo，10min TTL 缓存，fail-closed）
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "not admin" });
  }
  return { code: 0, message: "success", data: { ok: true } };
});
