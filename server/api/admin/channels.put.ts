import { defineEventHandler, readBody, createError } from "h3";
import { getChannelConfigService } from "../../core/services/channelConfigService";
import { isAdminUser, getWxAuthCredential } from "../../utils/wxAuthCheck";

/**
 * 频道配置全量保存 API（2026-08-26 管理后台"频道管理"CRUD 提交）
 *
 * 语义：全量替换 priorityChannels / defaultChannels（前端本地编辑后
 * 整份提交，服务端负责去重/互斥/空保护，见 ChannelConfigService.save）。
 *
 * body: { priorityChannels?: string[], defaultChannels?: string[], channelNames?: Record<string,string> }
 *   缺省字段沿用当前配置（便于只改一边）。channelNames 为频道备注名映射（id→显示名），
 *   仅存于管理员可见的配置，不影响通道下发。
 * 返回：{ version, priorityCount, defaultCount }（新版本快照）。
 *
 * 鉴权：与 admin/channels.get 一致 —— wx-auth isAdminUser。
 *   无 wxauth-token cookie → 401；登录态但非管理员 → 403。
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const body = await readBody(event).catch(() => null);
  if (!body || typeof body !== "object") {
    throw createError({ statusCode: 400, statusMessage: "body 必须是 JSON 对象" });
  }

  const service = getChannelConfigService();
  const current = service.getSnapshot();

  // 合并缺省：未传字段沿用当前值
  const next = {
    priorityChannels: Array.isArray(body.priorityChannels)
      ? body.priorityChannels
      : current.priorityChannels,
    defaultChannels: Array.isArray(body.defaultChannels)
      ? body.defaultChannels
      : current.defaultChannels,
    channelNames:
      body.channelNames && typeof body.channelNames === "object"
        ? body.channelNames
        : current.channelNames,
  };

  try {
    const saved = await service.save(next);
    return {
      code: 0,
      message: "success",
      data: {
        version: saved.version,
        priorityCount: saved.priorityChannels.length,
        defaultCount: saved.defaultChannels.length,
      },
    };
  } catch (err: any) {
    throw createError({
      statusCode: 400,
      statusMessage: "频道配置保存失败",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});