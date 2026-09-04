import { defineEventHandler, createError } from "h3";
import { getChannelConfigService } from "../../core/services/channelConfigService";
import { isAdminUser, getWxAuthCredential } from "../../utils/wxAuthCheck";

/**
 * 频道配置管理查询 API（2026-08-26 管理后台"频道管理"面板数据源）
 *
 * 返回完整频道配置（含 priority 频道，不经 getGrantedChannels 过滤），供管理员查看：
 *   data: { version, priorityChannels, defaultChannels, channelNames, priorityCount, defaultCount }
 *
 * 鉴权：与 /api/search-log 一致 —— wx-auth isAdminUser（管理员标记）。
 *   无 wxauth-token cookie → 401；登录态但非管理员 → 403。
 */
export default defineEventHandler(async (event) => {
  if (!getWxAuthCredential(event).token) {
    throw createError({ statusCode: 401, statusMessage: "wx auth required" });
  }
  if (!(await isAdminUser(event))) {
    throw createError({ statusCode: 403, statusMessage: "forbidden" });
  }

  const service = getChannelConfigService();
  await service.ensureLoaded();
  const snap = service.getSnapshot();

  return {
    code: 0,
    message: "success",
    data: {
      version: snap.version,
      priorityChannels: snap.priorityChannels,
      defaultChannels: snap.defaultChannels,
      channelNames: snap.channelNames ?? {},
      priorityCount: snap.priorityChannels.length,
      defaultCount: snap.defaultChannels.length,
    },
  };
});