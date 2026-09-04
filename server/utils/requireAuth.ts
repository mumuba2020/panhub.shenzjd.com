import type { H3Event } from "h3";
import { createError, getHeader, getRequestHeader } from "h3";
import { isBotUA } from "../../utils/botUA";
import { loggers } from "../core/utils/logger";
import { getClientIp } from "../middleware/rateLimiter";
import { getWxAuthCredential, verifyWxAuthOnceCached, getBearerToken } from "./wxAuthCheck";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";

/**
 * 搜索入口的爬虫/脚本 UA 拦截（2026-08-22）
 *
 * 背景：仅过滤"搜索词记录"不足以防刷——攻击者照样触发完整搜索
 * （一次搜索 = 并发请求全部 TG 频道 + 插件源，资源放大数十倍），
 * 刷词持续占用服务器资源。因此在入口直接 403 拒绝 bot UA 请求，
 * 连搜索都不执行，从根上杜绝资源消耗。
 *
 * 放行规则：
 * - 正常浏览器 UA → 放行（真人搜索不受影响）
 * - bot/脚本 UA 且无凭证 → 403（curl/python-requests 等刷词工具）
 * - bot/脚本 UA 但带 Authorization: Bearer → 放行
 *   （小程序/已授权 API 客户端，UA 常被识别为脚本但属真实渠道）
 *
 * 注意（2026-08-28）：Bearer 在本层只判断"有没有"，不校验有效性。
 * 有效性校验在 requireWxAuth 里统一走 wx-auth /api/auth/check（Bearer 头转发）。
 * 无效 Bearer → requireHumanOrCredential 放行 → requireWxAuth 校验失败 → 401。
 * 这比直接 403 更语义准确（401=未认证，403=禁止访问）。
 *
 * 2026-08-28 收紧：删除 x-panhub-client-secret 放行（此前无任何校验，
 * 任何人随便填就能绕过强制登录，是安全漏洞）。小程序 Bearer token
 * 由 wx-auth /api/auth/mp-login 签发（自建登录已下线），本层校验。
 *
 * 2026-08-22 收紧：命中拦截时打 warn 日志（含 UA 与路径），
 * 便于观察是否误伤真实用户；发现误伤可随时收紧/回退。
 */
export function requireHumanOrCredential(event: H3Event): void {
  const ua = getHeader(event, "user-agent");
  if (!isBotUA(ua)) return;
  // 已授权客户端（小程序/API）凭据放行，避免误伤真实渠道
  const auth = getRequestHeader(event, "authorization");
  if (auth && auth.startsWith("Bearer ")) return;
  const ip = getClientIp(event);
  loggers.search.warn(`拦截 bot UA 搜索请求`, {
    ip,
    ua: ua?.slice(0, 200),
    path: event.path,
    method: event.method,
  });
  // 累积到 IP 黑名单（异步、不阻塞 hot path 拒绝）；同一 IP 多次命中阈值后自动 24h 拉黑
  void getOrCreateBotDefenseService().recordRejection(ip, "bot_ua");
  throw createError({ statusCode: 403, statusMessage: "bot forbidden" });
}

/**
 * 微信登录态校验（2026-08-22 引入，2026-08-26 起写死强制，2026-08-28 起统一走 wx-auth）
 *
 * 思路：前端已强制"关注公众号 + 验证码"才能搜索，但脚本直调 API 可绕过
 * 前端弹窗。本层在服务端校验凭证（Bearer 头或 wxauth cookie），转发
 * wx-auth /api/auth/check 权威校验，未认证请求挡住（蜜罐/401）。
 *
 * 规则（2026-08-26 用户拍板：写死强制，不设开关）：
 * - **恒强制**：所有环境（生产 + 本地 dev）搜索请求必经此校验，不依赖任何环境变量
 *   （此前 WX_AUTH_ENFORCE 开关已删除，不再存在"默认关闭"路径；
 *    2026-08-26 起同步移除 import.meta.dev 放行：dev 行为 == 生产，
 *    localhost 可当 fork 站验证"无 cookie → 401 → 前端弹验证码"链路）
 * - Bearer（小程序 wx-auth token）或 cookie（网页端公众号）→ 统一转发
 *   wx-auth check 校验，有效放行，无效 401
 * - 取消关注 = 退出登录，下次搜索 401（check 结果有 10min 跨请求缓存，
 *   见 wxAuthCheck.verifyWxAuthOnceCached）
 * - wx-auth 服务故障 → 拒绝（fail-closed，宁可误伤，不裸奔）
 *
 * 2026-08-28 变更：
 * - 删除 x-panhub-client-secret 放行（无校验，安全漏洞）
 * - Bearer 从"直接放行"改为"校验 token 有效性"
 *
 * 2026-08-28 蜜罐化改造：
 * - 返回值从 void 改为三态 WxAuthResult：
 *   - "ok"           → 放行（有效凭证）
 *   - "honeypot"     → 完全无凭证（爬虫/脚本/直调）→ 调用方返回蜜罐假数据
 *   - "unauthorized" → 有凭证但失效（如取消关注）→ 调用方返回 401 引导重新关注
 * - 不再 recordRejection 拉黑（用户拍板：让爬虫持续抓蜜罐假数据传播公众号，不封禁）
 * - 蜜罐假数据由各搜索接口在返回 "honeypot" 时返回
 *   （复用黑名单蜜罐 buildBlockedFake*，见 search.get/post/stream）
 *
 * 2026-08-28 自建登录下线：
 * - Bearer 凭证（小程序，wx-auth /api/auth/mp-login 签发）与 cookie 凭证
 *   （网页端公众号验证码流程）统一走 wx-auth /api/auth/check 校验，
 *   panhub 不再自签自校 token（原 mpToken/mp_token 表已删除）
 *
 * 区分"无凭证/凭证失效"的原因（2026-08-28 用户拍板）：
 * - 页面用户搜索前必过前端 checkSearchAuth（读 cookie 判断），无 cookie 时
 *   前端直接弹窗、根本不会发请求 → 后端收到的"无凭证"请求只可能是爬虫/直调
 * - 但"有凭证但失效"（如取消关注）时，前端 isVerified 缓存仍为 true 会放行
 *   发请求，此时必须返回 401 触发前端 forceVerify 重新引导关注，不能给蜜罐
 *
 * 2026-08-29 修正（蜜罐误伤小程序真人）：
 * - 上述"无凭证只可能是爬虫"的假设对小程序不成立：小程序不走 cookie，
 *   凭证只靠 Authorization 头，登录态缺失（静默登录失败/未登录先搜索）
 *   时会发出零凭证请求，此前被喂蜜罐假数据（实测 2026-08-29）
 * - 现按 UA 区分：微信渠道（MicroMessenger/wechatdevtools）无凭证 →
 *   unauthorized（401 引导重新登录）；其余无凭证 → 蜜罐不变
 */
export type WxAuthResult = "ok" | "honeypot" | "unauthorized";

/**
 * 微信客户端 UA 识别（2026-08-29）：
 * - 小程序 wx.request 真机 UA 形如 "...MicroMessenger/8.0.49..."
 * - 微信开发者工具 UA 含 wechatdevtools（部分版本带 MicroMessenger 模拟 UA）
 * - 微信内置浏览器（H5 分享页）同样含 MicroMessenger
 * 命中即视为"真实微信渠道"：无凭证时应走 401 引导重新登录，而不是蜜罐。
 */
function isWeChatUA(ua: string | undefined | null): boolean {
  if (!ua) return false;
  return /MicroMessenger|wechatdevtools/i.test(ua);
}

export async function requireWxAuth(event: H3Event): Promise<WxAuthResult> {
  // 统一校验：Bearer（小程序）优先，其次 cookie（网页端公众号），
  // 均由 wxAuthCheck 转发 wx-auth /api/auth/check 权威校验（含 10min 缓存）
  const ok = await verifyWxAuthOnceCached(event);
  if (ok) return "ok";

  // 校验失败：区分"完全无凭证"（爬虫→蜜罐）与"有凭证但失效"（→401 引导重新认证）
  const bearer = getBearerToken(event);
  const cred = getWxAuthCredential(event);
  if (!bearer && !cred.token && !cred.openid) {
    // 2026-08-29：微信渠道的"无凭证"请求不再喂蜜罐 → 401 引导重新登录。
    // 背景：小程序登录态缺失（静默登录失败/未登录先搜索）时请求不带任何
    // 凭证，此前被当爬虫返回蜜罐假数据——结构 100% 与真实结果一致，
    // 真人用户毫无感知地看到假资源。微信 UA 的请求视为真实客户端，
    // 转 unauthorized（401）走重新登录链路。爬虫伪装 MicroMessenger UA
    // 可绕过蜜罐，但 401 同样不给数据，蜜罐收益损失可接受。
    if (isWeChatUA(getHeader(event, "user-agent"))) {
      return "unauthorized";
    }
    return "honeypot";
  }

  const ip = getClientIp(event);
  loggers.search.warn(`拦截未认证的搜索请求`, {
    ip,
    path: event.path,
    method: event.method,
  });
  return "unauthorized";
}
