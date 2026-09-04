import { defineEventHandler, readBody, sendError, createError } from "h3";

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
  // IP 黑名单拦截（2026-08-24）：累积到阈值的攻击源 24h 内拒绝所有搜索请求。
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
    // 2026-09-03：若该请求带有效凭证（真实用户被共享出口 IP 拖累误伤），
    // 异步记录 openid↔ip，供管理端按 openid 反馈解封（不阻塞蜜罐响应）
    maybeRecordHoneypotOpenid(event, ip);
    return buildBlockedFakeGenericResponse();
  }
  // 搜索入口 IP 频控（2026-08-25）：60s 内超过阈值（默认 30 次）→ 429
  if (await isSearchRateLimited(ip)) {
    throw createError({ statusCode: 429, statusMessage: "too many requests" });
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
  const body = (await readBody<SearchRequest>(event)) || ({} as SearchRequest);

  const kw = (body.kw || "").trim();
  if (!kw) {
    return sendError(
      event,
      createError({ statusCode: 400, statusMessage: "kw is required" })
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

  body.channels = parseList(body.channels);
  body.plugins = parseList(body.plugins);
  body.cloud_types = parseList(body.cloud_types);

  if (!body.res || body.res === "merge") body.res = "merged_by_type";
  if (!body.src) body.src = "all";
  if (body.src === "tg") body.plugins = undefined;
  else if (body.src === "plugin") body.channels = undefined;

  // countOnly：前端"问后端有 N 批"，不实际搜索，立即返回（零落地）
  const requestedChannels = body.channels;
  const { batch, batchSize, countOnly } = parseBatchQuery(body as any);
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

  // 决定本次要搜的频道（channels 显式 > batch 切片 > 一次性全量）
  const allChannels = getChannelConfigService().getSnapshot().defaultChannels;
  body.channels =
    requestedChannels && requestedChannels.length > 0
      ? requestedChannels
      : batch != null
      ? sliceBatchChannels(allChannels, batch, batchSize)
      : allChannels;

  const signal = getClientAbortSignal(event);

  const { response: result, warnings } = await service.searchWithWarnings(
    kw,
    body.channels,
    body.conc,
    !!body.refresh,
    body.res,
    body.src,
    body.plugins,
    body.cloud_types,
    body.ext || {},
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
