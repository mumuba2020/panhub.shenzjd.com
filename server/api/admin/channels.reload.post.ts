import { defineEventHandler, createError } from "h3";
import { getChannelConfigService } from "../../core/services/channelConfigService";
import { isAdminUser, getWxAuthCredential } from "../../utils/wxAuthCheck";

/**
 * 频道配置重载 API（2026-08-26 管理后台"频道管理"面板"重新加载"按钮）
 *
 * 强制忽略内存缓存重新加载频道配置（Turso → env → 远程），
 * 用于修改频道表（sync-channels）后无需重启进程即同步最新配置。
 *
 * 鉴权：与 admin/channels.get 一致 —— wx-auth isAdminUser（管理员标记）。
 * 加载失败：保持旧配置可用并返回 500（前端提示失败，不破坏现有服务）。
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  try {
    const service = getChannelConfigService();
    const snap = await service.reload();
    return {
      code: 0,
      message: "success",
      data: {
        version: snap.version,
        priorityCount: snap.priorityChannels.length,
        defaultCount: snap.defaultChannels.length,
      },
    };
  } catch (err: any) {
    throw createError({
      statusCode: 400,
      statusMessage: "频道配置重载失败",
      message:
        err instanceof Error ? err.message : String(err),
    });
  }
});