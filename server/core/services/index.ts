import { SearchService, type SearchServiceOptions } from "./searchService";
import { getChannelConfigService } from "./channelConfigService";
import {
  PluginManager,
  registerGlobalPlugin,
  type AsyncSearchPlugin,
} from "../plugins/manager";
import { loggers } from "../utils/logger";
// NOTE: 8 dead plugins removed on 2026-07-06 based on log analysis:
//   hunhepan   - 3 APIs all dead (504/414/404)
//   jikepan    - source down (CF 522)
//   labi       - domain expired
//   qupansou   - search upstream 502
//   duoduo     - Cloudflare JS challenge blocks all HTTP scraping
//   thepiratebay - mirror URL expired + anti-scrape
//   panta      - overseas IP unreachable (likely blocked)
//   xuexizhinan - small site offline
// See: data/panhub.shenzjd.com-20260706090537.log analysis
// NOTE: 5 个死插件于 2026-08-04 删除（无引用）：zhizhen / hdr4k / muou / huban / shandian
// NOTE: nyaa 于 2026-08-07 移除：纯磁力种子站（搜索结果只产出 magnet 链接），产品要求不出现磁力链接
// NOTE: 2026-08-07 盘点：solidtorrents/torrentgalaxy/x1337x 纯磁力站按产品要求不注册；
//       panyq/fox4k 实测死源已删除；susu/pan666 被 CF 拦（文件保留，绕过后再注册）
import { PansearchPlugin } from "../plugins/pansearch";
import { MelostPlugin } from "../plugins/melost";
import { Quark4kPlugin } from "../plugins/quark4k";
import { OugePlugin } from "../plugins/ouge";
import { WanouPlugin } from "../plugins/wanou";
import { DyyjvPlugin } from "../plugins/dyyjv";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

/**
 * 安全注册插件（隔离闸 A）：单个插件构造或初始化抛错只跳过该插件，
 * 不会让整个服务启不起来。这是“新增插件有问题也不影响现有服务”的第一道闸。
 */
function safeRegister(label: string, factory: () => AsyncSearchPlugin) {
  try {
    const plugin = factory();
    registerGlobalPlugin(plugin);
  } catch (err) {
    loggers.plugin.error("插件注册失败，已跳过（不影响其他插件）", {
      plugin: label,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 创建插件管理器并注册所有可用插件
 */
function createPluginManager(): PluginManager {
  const pm = new PluginManager();
  // 仅注册稳定可用的插件；新增插件统一走 safeRegister，单点失败不影响整体
  safeRegister("pansearch", () => new PansearchPlugin());
  safeRegister("melost", () => new MelostPlugin());
  safeRegister("quark4k", () => new Quark4kPlugin());
  safeRegister("ouge", () => new OugePlugin());
  safeRegister("wanou", () => new WanouPlugin());
  // 2026-08-27 移除 yunso / u3c3：
  // - yunso：上游 wd 参数失效（搜任何词返回同一批固定推荐列表，与搜索词完全
  //   无关），被汇总层相关性过滤兜底后等效 0 结果，保留只会白消耗超时等待
  // - u3c3：纯磁力种子站，产品要求搜索结果不出现磁力链接（同 nyaa /
  //   solidtorrents / torrentgalaxy / x1337x 的处理），整站无网盘链接无保留价值
  // 2026-08-07 新增：dyyjv（电影云集，WordPress REST API，详情页内嵌夸克/百度链接）
  safeRegister("dyyjv", () => new DyyjvPlugin());
  pm.registerAllGlobalPlugins();
  return pm;
}

/**
 * 创建搜索服务选项
 *
 * 2026-08-24：频道清单不再来自 runtimeConfig（明文已从仓库移除），
 * 改由 ChannelConfigService 提供（Turso 加密存储 → 解密缓存快照）。
 * 调用方（搜索 API 入口）应先 await getChannelConfigService().ensureLoaded()，
 * 保证首次请求时快照已就绪；未加载时返回空数组，由隔离闸 B 降级。
 */
function createServiceOptions(runtimeConfig: any): SearchServiceOptions {
  const channelSnapshot = getChannelConfigService().getSnapshot();
  return {
    priorityChannels: channelSnapshot.priorityChannels,
    defaultChannels: channelSnapshot.defaultChannels,
    defaultConcurrency: runtimeConfig.defaultConcurrency || 10,
    pluginTimeoutMs: runtimeConfig.pluginTimeoutMs || 15000,
    cacheEnabled: !!runtimeConfig.cacheEnabled,
    cacheTtlMinutes: runtimeConfig.cacheTtlMinutes || 30,
  };
}

/**
 * 获取或创建搜索服务实例
 * 使用 Nitro 上下文存储，支持测试时重置
 */
export function getOrCreateSearchService(runtimeConfig: any): SearchService {
  // 尝试从 Nitro 上下文获取
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (context?.service) {
    return context.service;
  }

  // 创建新实例
  const options = createServiceOptions(runtimeConfig);
  const pluginManager = createPluginManager();
  const service = new SearchService(options, pluginManager);

  // 存储到上下文
  (globalThis as any)[SERVICE_CONTEXT_KEY] = { service, options, pluginManager };
  return service;
}

/**
 * 重置搜索服务实例（仅用于测试）
 */
export function resetSearchService(): void {
  delete (globalThis as any)[SERVICE_CONTEXT_KEY];
}

/**
 * 获取搜索服务统计信息（用于监控）
 */
export function getSearchServiceStats(): { exists: boolean; options?: SearchServiceOptions } {
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (!context) {
    return { exists: false };
  }
  return {
    exists: true,
    options: context.options,
  };
}
