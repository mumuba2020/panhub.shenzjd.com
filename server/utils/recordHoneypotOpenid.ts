import type { H3Event } from "h3";
import { getBearerToken, getWxAuthCredential, verifyWxAuthOnceCached } from "./wxAuthCheck";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { loggers } from "../core/utils/logger";

/**
 * 蜜罐命中时记录真实用户的 openid（2026-09-03 用户反馈解封闭环）
 *
 * 背景：黑名单 isBlocked 拦截发生在 requireWxAuth 之前（search 端点最前），
 * 真实用户（带有效 wxauth 凭证）若所在 IP 被封（共享出口 NAT / 公司出口被
 * 爬虫拖累）会被直接喂蜜罐假数据，openid 从未解析、search_log 也不记录。
 * 用户拿 openid 找管理员反馈时，后台无从定位"他被哪个 IP 蜜罐了"。
 *
 * 本函数在蜜罐命中分支 fire-and-forget 调用：
 * - 先同步检查请求是否带凭证；无凭证（纯爬虫，蜜罐命中的大头）直接跳过，
 *   零远程零 DB
 * - 带凭证 → 调 verifyWxAuthOnceCached 解 openid（10min 跨请求缓存，真人
 *   此前成功搜索过的 token 通常已缓存，纯内存无远程；缓存 miss 才打一次
 *   wx-auth check）
 * - 成功解出 openid → recordHoneypotHit 落库（异步 DB 写，不阻塞蜜罐响应）
 *
 * 全程静默：蜜罐路径绝不能被记录逻辑拖慢或抛错。
 */
export function maybeRecordHoneypotOpenid(event: H3Event, ip: string): void {
  try {
    // 无凭证（爬虫/直调）直接跳过——蜜罐命中的绝大多数请求零成本
    if (!getBearerToken(event) && !getWxAuthCredential(event).token && !getWxAuthCredential(event).openid) {
      return;
    }
    void (async () => {
      try {
        const ok = await verifyWxAuthOnceCached(event);
        if (!ok) return;
        const openid = ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || "";
        if (!openid) return;
        await getOrCreateBotDefenseService().recordHoneypotHit(openid, ip);
      } catch (err) {
        loggers.api?.debug?.("记录蜜罐命中 openid 失败（静默）", {
          error: err instanceof Error ? err.message : String(err),
          ip,
        });
      }
    })();
  } catch {
    // 同步取凭证失败也完全静默
  }
}
