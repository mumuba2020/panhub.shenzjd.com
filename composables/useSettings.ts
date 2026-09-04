import type { Ref } from "vue";
import { DEFAULT_USER_SETTINGS } from "~/config/plugins";

export interface UserSettings {
  concurrency: number;
  pluginTimeoutMs: number;
}

export interface UseSettingsReturn {
  settings: Ref<UserSettings>;
  loadSettings: () => void;
}

function getDefaultSettings(): UserSettings {
  return {
    // 2026-08-24：频道清单彻底移出前端，搜索源（频道/插件）全在后端，
    // 前端不再配置；仅保留并发/超时默认值供 fallback 逃生通道使用。
    concurrency: DEFAULT_USER_SETTINGS.concurrency,
    pluginTimeoutMs: DEFAULT_USER_SETTINGS.pluginTimeoutMs,
  };
}

/**
 * 用户设置（服务端下发版）。
 *
 * 2026-08-21：设置面板已移除 —— 频道/插件信息是核心资产，
 * 由服务端接口与广告一起下发；客户端不再提供可配置入口。
 *
 * 2026-08-24：频道清单彻底移出前端（不再经 /api/channels 下发），
 * 搜索时分批逻辑也由后端负责（前端只发"第几批"），前端永远见不到
 * 完整频道清单；插件亦全在后端注册启用。前端不再持有任何搜索源配置。
 */
export function useSettings(): UseSettingsReturn {
  const settings = useState<UserSettings>("user-settings", () => getDefaultSettings());

  // 保留函数签名以兼容现有调用方；不再做任何本地持久化
  function loadSettings(): void {}

  return {
    settings,
    loadSettings,
  };
}
