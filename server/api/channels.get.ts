import { defineEventHandler, getQuery, getRequestHeader, createError } from "h3";
import { getChannelConfigService } from "../core/services/channelConfigService";

/**
 * 频道配置下发接口（2026-08-24）
 *
 * 返回部分频道配置供部署方兜底使用（详见 ChannelConfigService 远程兜底层）：
 *   - 无 key：默认数量（CHANNELS_DEFAULT_GRANT，默认 10 个 default 频道）
 *   - 带 key（Authorization: Bearer 或 ?key=）：按 CHANNELS_KEYS 分级，
 *     "all" 为全部 default 频道；priority 频道不随下发暴露
 *
 * 响应：{ code, data: { version, channels } } —— 只含频道名。
 * 防护：Origin 白名单 + 全局限流（rateLimiter /api/channels 条目）。
 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://panhub.shenzjd.com",
  "https://www.shenzjd.com",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

function isAllowedOrigin(event: any): boolean {
  const origin = getRequestHeader(event, "origin");
  // 服务端拉取场景（无 Origin）放行，交给限流与 key 分级
  if (!origin) return true;
  const allowRaw = process.env.CHANNELS_ALLOWED_ORIGINS;
  const allowed = allowRaw
    ? allowRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return allowed.some((o) => origin === o || origin.startsWith(`${o}/`));
}

export default defineEventHandler(async (event) => {
  if (!isAllowedOrigin(event)) {
    throw createError({ statusCode: 403, statusMessage: "origin not allowed" });
  }

  const service = getChannelConfigService();
  await service.ensureLoaded();

  // 读取 API Key：Authorization: Bearer <key> 或 ?key=<key>
  let apiKey: string | null = null;
  const auth = getRequestHeader(event, "authorization");
  if (auth && auth.startsWith("Bearer ")) {
    apiKey = auth.slice(7).trim() || null;
  }
  if (!apiKey) {
    const q = getQuery(event);
    apiKey = typeof q.key === "string" && q.key ? q.key : null;
  }

  const defaultGrant = Math.max(0, Math.floor(Number(process.env.CHANNELS_DEFAULT_GRANT) || 10));
  const grant = service.resolveChannelGrant(apiKey, defaultGrant);
  const { version, channels } = service.getGrantedChannels(grant);

  return {
    code: 0,
    message: "ok",
    data: { version, channels },
  };
});
