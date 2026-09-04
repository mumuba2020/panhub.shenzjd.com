import { defineEventHandler, getQuery, sendError, createError } from "h3";

/** 从 H3 event 中提取客户端断开信号（兼容 h3 无 getAbortSignal 的版本） */
function getClientAbortSignal(event: any): AbortSignal | undefined {
  // 优先使用 h3 原生能力（若未来版本支持）
  if (typeof event._signal === "object" && event._signal instanceof AbortSignal) {
    return event._signal;
  }
  // 回退：监听 node req 的 close 事件
  const req = event.node?.req;
  if (req && typeof req.on === "function") {
    const controller = new AbortController();
    req.on("close", () => {
      if (req.destroyed || req.writableEnded === false && req.readableEnded) {
        controller.abort();
      }
    });
    return controller.signal;
  }
  return undefined;
}
import { requireHumanOrCredential, requireWxAuth } from "../utils/requireAuth";
import { maybeRecordHoneypotOpenid } from "../utils/recordHoneypotOpenid";
import { isSearchRateLimited } from "../utils/entryRateLimit";
import { parseList } from "../utils/parseQuery";
import { recordSearchTerm } from "../utils/recordSearchTerm";
import { getClientIp } from "../middleware/rateLimiter";
import { getOrCreateBotDefenseService } from "../core/services/botDefense";
import { buildBlockedFakeGenericResponse } from "../core/utils/blockedFakeData";
import { getOrCreateSearchService } from "../core/services";
import { getChannelConfigService } from "../core/services/channelConfigService";
import { loggers } from "../core/utils/logger";
import {
  buildBatchPlan,
  sliceBatchChannels,
  parseBatchQuery,
} from "../core/utils/batchChannels";
import type { GenericResponse, SearchRequest } from "../core/types/models";

export default defineEventHandler(async (event) => {
  // IP 黑名单拦截（2026-08-24 用户拍板：累积到阈值的攻击源 24h 内拒绝所有搜索请求）
  // 2026-08-27 改为蜜罐假数据：不再 403（爬虫收到 403 仍会继续请求），
  // 改为返回标准结构的公众号宣传数据——无论搜什么都是同一份纯静态内容，
  // 不触发真实搜索（零资源消耗），聚合采集方抓到后等于帮我们传播公众号。
  const ip = getClientIp(event);
  if (await getOrCreateBotDefenseService().isBlocked(ip)) {
    loggers.search.debug(`黑名单 IP 命中，返回蜜罐假数据`, {
      ip,
      method: event.method,
      path: event.path,
    });
    // 2026-09-03：带凭证真实用户被误伤时异步记录 openid↔ip（见 recordHoneypotOpenid）
    maybeRecordHoneypotOpenid(event, ip);
    return buildBlockedFakeGenericResponse();
  }
  // 搜索入口 IP 频控（2026-08-25）：60s 内超过阈值（默认 30 次）→ 429。
  // 独立于全局限流（按路径前缀），跨三个搜索端点共享同一计数，防换端点绕限。
  if (await isSearchRateLimited(ip)) {
    throw createError({
      statusCode: 429,
      statusMessage: "too many requests",
      message: "请求过于频繁，请稍后重试",
    });
  }
  // 爬虫/脚本 UA 直接 403，不执行搜索（防刷词持续占用服务器资源）
  requireHumanOrCredential(event);
  // 微信关注公众号登录态校验（恒强制）。三态：
  // - "ok"           → 放行
  // - "honeypot"     → 无凭证（爬虫/直调）→ 返回蜜罐假数据帮我们传播公众号
  // - "unauthorized" → 有凭证但失效（取消关注真人）→ 401 触发前端重新引导关注
  const wxAuth = await requireWxAuth(event);
  if (wxAuth === "honeypot") {
    loggers.search.debug(`无凭证请求，返回蜜罐假数据`, {
      ip,
      method: event.method,
      path: event.path,
    });
    return buildBlockedFakeGenericResponse();
  }
  if (wxAuth === "unauthorized") {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  const config = useRuntimeConfig();
  // 确保频道配置已加载（Turso 加密配置 → 解密缓存），幂等、带 TTL
  await getChannelConfigService().ensureLoaded();
  const service = getOrCreateSearchService(config);
  const q = getQuery(event);

  const kw = ((q.kw as string) || "").trim();
  if (!kw) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw is required" })
    );
  }
  if (kw.length > 200) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw too long (max 200)" })
    );
  }

  // 记录搜索词（2026-08-22：只要搜索就记录，便于排查）。
  // 防刷由入口 requireHumanOrCredential 承担（bot UA 403），本层不再过滤。
  // 2026-08-25：附带 openid（由 requireWxAuth 解出存
  // event.context），供 search_log 明细关联"谁搜了什么"
  await recordSearchTerm(
    kw,
    ip,
    ((event.context as Record<string, any>)?.__wxAuthOpenid as string) || ""
  );

  let ext: Record<string, any> | undefined;
  const extStr = (q.ext as string | undefined)?.trim();
  if (extStr) {
    if (extStr === "{}") ext = {};
    else {
      try {
        ext = JSON.parse(extStr);
      } catch (e: any) {
        return sendError(
          event,
          createError({
            statusCode: 400,
            statusMessage: "invalid ext json",
          })
        );
      }
    }
  }

  const requestedChannels = parseList(q.channels);
  const { batch, batchSize, countOnly } = parseBatchQuery(q as any);

  // countOnly：前端用于"问后端有 N 批"，不实际搜索，立即返回
  // （返回的只是数字，不含频道名，零落地）
  if (countOnly) {
    const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
    const plan = buildBatchPlan(allChannels, batchSize);
    const resp: GenericResponse<typeof plan> = {
      code: 0,
      message: "ok",
      data: plan,
    };
    return resp;
  }

  // 决定本次要搜的频道（优先级：前端显式 channels > batch 切片 > 一次性全量）
  // 切片逻辑在 batchChannels.ts，便于测试
  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  const effChannels: string[] =
    requestedChannels && requestedChannels.length > 0
      ? requestedChannels
      : batch != null
      ? sliceBatchChannels(allChannels, batch, batchSize)
      : allChannels;

  const req: SearchRequest = {
    kw,
    channels: effChannels,
    conc: (() => {
      const n = q.conc ? parseInt(String(q.conc), 10) : NaN;
      return Number.isFinite(n) && n >= 1 && n <= 16 ? n : undefined;
    })(),
    refresh: String(q.refresh).trim() === "true",
    res: (q.res as any) || "merged_by_type",
    src: (q.src as any) || "all",
    plugins: parseList(q.plugins),
    cloud_types: parseList(q.cloud_types),
    ext,
  };

  if (req.src === "tg") req.plugins = undefined;
  else if (req.src === "plugin") req.channels = undefined;
  if (!req.res || req.res === "merge") req.res = "merged_by_type";

  const signal = getClientAbortSignal(event);

  const { response: result, warnings } = await service.searchWithWarnings(
    req.kw,
    req.channels,
    req.conc,
    !!req.refresh,
    req.res,
    req.src,
    req.plugins,
    req.cloud_types,
    req.ext || {},
    signal
  );

  const resp: GenericResponse<typeof result> = {
    code: 0,
    message: warnings.length > 0 ? "partial_success" : "success",
    data: result,
  };

  if (warnings.length > 0) {
    (resp as any).warnings = warnings;
  }

  return resp;
});
