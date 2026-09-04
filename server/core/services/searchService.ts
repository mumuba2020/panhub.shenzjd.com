import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { safeExecute } from "../utils/fetch";
import type { MergedLinks, SearchResponse, SearchResult } from "../types/models";
import { PluginManager, type AsyncSearchPlugin } from "../plugins/manager";
import {
  PluginHealthChecker,
  createPluginHealthChecker,
} from "../plugins/pluginHealth";
import {
  ErrorCollector,
  classifyError,
  type WarningInfo,
} from "../utils/errors";
import { buildSearchKeywordVariants, matchesSearchKeyword } from "../utils/searchKeyword";
import { loggers } from "../utils/logger";

/**
 * 判断链接是否为磁力链接（产品需求：搜索结果不出现磁力链接）。
 * 按 URL 协议与 type 双重判断，避免上游把 magnet URL 标成其他 type 而漏网。
 */
function isMagnetLink(link: { type?: string; url?: string } | undefined | null): boolean {
  if (!link) return false;
  if (typeof link.url === "string" && link.url.toLowerCase().startsWith("magnet:")) {
    return true;
  }
  return (link.type || "").toLowerCase() === "magnet";
}

/**
 * 从结果中剔除磁力链接（原地修改 links）。
 * @returns 是否确实移除了磁力链接（供调用方判断“纯磁力资源”以丢弃整条结果）
 */
function stripMagnetLinks(result: SearchResult): boolean {
  if (!Array.isArray(result.links) || result.links.length === 0) return false;
  const before = result.links.length;
  result.links = result.links.filter((l) => !isMagnetLink(l));
  return result.links.length !== before;
}

/**
 * 规范化单个插件返回的结果（隔离闸 C）：
 * - 强制 links 为数组、每条 link 必含 string 类型的 url；
 * - datetime / title / content 等统一为字符串；
 * 避免某个插件返回畸形结构（如 links 为非数组）在后续合并阶段抛错拖垮整响应。
 */
function normalizeSearchResult(raw: any): SearchResult {
  const safeStr = (v: unknown): string =>
    typeof v === "string" ? v : v == null ? "" : String(v);

  const linksRaw = Array.isArray(raw?.links) ? raw.links : [];
  const links: SearchResult["links"] = linksRaw
    .filter((l: any) => l && typeof l.url === "string" && l.url.length > 0)
    .map((l: any) => ({
      type: safeStr(l.type),
      url: safeStr(l.url),
      password: safeStr(l.password),
    }));

  const tagsRaw = Array.isArray(raw?.tags) ? raw.tags : undefined;
  const tags = tagsRaw?.map((t: any) => safeStr(t)).filter(Boolean);

  return {
    message_id: safeStr(raw?.message_id),
    unique_id:
      safeStr(raw?.unique_id) || `plugin-${Math.random().toString(36).slice(2)}`,
    channel: safeStr(raw?.channel),
    datetime: safeStr(raw?.datetime),
    title: safeStr(raw?.title),
    content: safeStr(raw?.content),
    links,
    tags: tags && tags.length ? tags : undefined,
  };
}

export interface SearchServiceOptions {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMinutes: number;
}

export class SearchService {
  private static readonly TG_CHANNEL_LIMIT = 80;
  private static readonly TG_DEEP_CHANNEL_LIMIT = 160;
  private static readonly TG_DEEP_SEARCH_TRIGGER = 3;
  private static readonly PLUGIN_VARIANT_TRIGGER = 5;

  private options: SearchServiceOptions;
  private pluginManager: PluginManager;
  private cache: UnifiedCache;
  private healthChecker: PluginHealthChecker;

  constructor(options: SearchServiceOptions, pluginManager: PluginManager) {
    this.options = options;
    this.pluginManager = pluginManager;
    this.cache = new UnifiedCache(
      {
        enabled: options.cacheEnabled,
        ttlMinutes: options.cacheTtlMinutes,
      },
      "search"
    );

    this.healthChecker = createPluginHealthChecker();
  }

  getPluginManager() {
    return this.pluginManager;
  }

  async search(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    signal?: AbortSignal
  ): Promise<SearchResponse> {
    const { response } = await this.searchWithWarnings(
      keyword,
      channels,
      concurrency,
      forceRefresh,
      resultType,
      sourceType,
      plugins,
      cloudTypes,
      ext,
      signal
    );

    return response;
  }

  async searchWithWarnings(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    signal?: AbortSignal
  ): Promise<{ response: SearchResponse; warnings: WarningInfo[] }> {
    // 客户端已断开，直接返回空结果
    if (signal?.aborted) {
      return { response: { total: 0 }, warnings: [] };
    }

    const errorCollector = new ErrorCollector();
    const requestStart = Date.now();
    const effChannels =
      channels && channels.length > 0 ? channels : this.options.defaultChannels;
    const effConcurrency =
      concurrency && concurrency > 0
        ? concurrency
        : this.options.defaultConcurrency;
    const effResultType =
      !resultType || resultType === "merge" ? "merged_by_type" : resultType;
    const effSourceType = sourceType ?? "all";

    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];

    const tasks: Array<() => Promise<void>> = [];

    if (effSourceType === "all" || effSourceType === "tg") {
      tasks.push(async () => {
        try {
          const concOverride =
            typeof concurrency === "number" && concurrency > 0
              ? concurrency
              : undefined;
          tgResults = await this.searchTG(
            keyword,
            effChannels,
            !!forceRefresh,
            concOverride,
            ext,
            signal
          );
        } catch (err) {
          // 隔离闸 B：TG 整路抛错时降级为 []，不影响插件结果返回
          loggers.search.error("TG 搜索整路失败，已降级", {
            keyword,
            error: err instanceof Error ? err.message : String(err),
          });
          tgResults = [];
        }
      });
    }
    if (effSourceType === "all" || effSourceType === "plugin") {
      tasks.push(async () => {
        try {
          pluginResults = await this.searchPlugins(
            keyword,
            plugins,
            !!forceRefresh,
            effConcurrency,
            ext ?? {},
            errorCollector,
            signal
          );
        } catch (err) {
          // 隔离闸 B：插件整路抛错时降级为 []，不影响 TG 结果返回
          loggers.search.error("插件搜索整路失败，已降级", {
            keyword,
            error: err instanceof Error ? err.message : String(err),
          });
          pluginResults = [];
        }
      });
    }

    await Promise.all(tasks.map((task) => task()));

    const allResults = this.mergeSearchResults(tgResults, pluginResults);
    this.sortResultsByTimeDesc(allResults);

    // 结果与搜索关键词相关性过滤（2026-08-27 用户拍板：真实资源但
    // 名字对不上搜索词的结果不展示）。
    // 背景：部分插件会返回与搜索词无关的真实资源（如 dyyjv 自带
    // 「相关推荐」板块；yunso 已于 2026-08-27 因上游 wd 参数失效从
    // 注册表移除，u3c3 同日因纯磁力源移除）——用户搜「阿甘正传」曾
    // 混入「好莱坞俗套大吐槽」「熊出没」等。
    // 兜底：title/content 经 normalize 后不含关键词变体 → 整条丢弃。
    // TG 来源在抓取阶段已按全文匹配，这里对插件来源做统一兜底。
    // 边界：单字符关键词会触发插件兜底变体（如搜 "1" → "电影"/"movie"/
    // "1080p"），返回的 title 可能不含单字符，此时不过滤避免误杀。
    const keywordTrimmed = keyword.trim();
    const relevantResults =
      keywordTrimmed.length <= 1
        ? allResults
        : allResults.filter((result) => {
            const haystack = [result.title, result.content]
              .filter(Boolean)
              .join(" ");
            return matchesSearchKeyword(haystack, keyword);
          });

    const filteredForResults: SearchResult[] = [];
    for (const result of relevantResults) {
      // 统一剔除磁力链接（TG / 插件来源都覆盖）
      const strippedMagnet = stripMagnetLinks(result);
      const hasTime = !!result.datetime;
      const hasLinks = Array.isArray(result.links) && result.links.length > 0;
      // 原本只有磁力链接的资源（如种子站点结果）过滤后无链接，整条不展示
      if (strippedMagnet && !hasLinks) continue;
      if (hasTime || hasLinks) {
        filteredForResults.push(result);
      }
    }

    const mergedLinks = this.mergeResultsByType(
      relevantResults,
      keyword,
      cloudTypes
    );

    let total = 0;
    let response: SearchResponse = { total: 0 };
    if (effResultType === "merged_by_type") {
      total = Object.values(mergedLinks).reduce(
        (sum, items) => sum + items.length,
        0
      );
      response = { total, merged_by_type: mergedLinks };
    } else if (effResultType === "results") {
      total = filteredForResults.length;
      response = { total, results: filteredForResults };
    } else {
      total = filteredForResults.length;
      response = {
        total,
        results: filteredForResults,
        merged_by_type: mergedLinks,
      };
    }

    const requestMs = Date.now() - requestStart;
    loggers.search.debug("搜索请求完成", {
      keyword,
      total,
      tgCount: tgResults.length,
      pluginSources: pluginResults.length,
      sourceType: effSourceType,
      requestedPlugins: plugins ?? "all",
      requestedChannels: effChannels.length,
      durationMs: requestMs,
      filteredResultCount: filteredForResults.length,
    });

    return {
      response,
      warnings: errorCollector.getWarnings(),
    };
  }

  private async searchTG(
    keyword: string,
    channels: string[] | undefined,
    forceRefresh: boolean,
    concurrencyOverride?: number,
    ext?: Record<string, any>,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const chList = Array.isArray(channels) ? channels : [];
    const cacheKey = `tg:${keyword}:${[...chList].sort().join(",")}`;
    const { cacheEnabled, priorityChannels } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.TG_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    const { fetchTgChannelPosts } = await import("./tg");
    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );
    const concurrency = Math.max(
      2,
      Math.min(concurrencyOverride ?? this.options.defaultConcurrency, 5)
    );

    const prioritySet = new Set(priorityChannels || []);
    const priorityList = chList.filter((channel) => prioritySet.has(channel));
    const normalList = chList.filter((channel) => !prioritySet.has(channel));

    const createChannelTask =
      (channel: string, limitPerChannel: number) => async () => {
        // 客户端断开时跳过
        if (signal?.aborted) return [];

        const controller = new AbortController();
        // 将外部取消和超时合并：任一触发都会 abort
        const mergedSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;

        const result = await safeExecute(
          () =>
            this.withTimeout<SearchResult[]>(
              fetchTgChannelPosts(channel, keyword, {
                limitPerChannel,
                signal: mergedSignal,
              }),
              timeoutMs,
              [],
              controller
            ),
          []
        );
        return result;
      };

    const flattenResults = (items: SearchResult[][]) => {
      const flattened: SearchResult[] = [];
      for (const arr of items) {
        if (Array.isArray(arr)) {
          flattened.push(...arr);
        }
      }
      return flattened;
    };

    const shallowTasks = [...priorityList, ...normalList].map((channel) =>
      createChannelTask(channel, SearchService.TG_CHANNEL_LIMIT)
    );
    const shallowResults = flattenResults(
      await this.runWithConcurrency(shallowTasks, concurrency, signal)
    );

    let results = shallowResults;
    // 深搜开关（前端分批请求时通过 ext.__deep_search 控制）：
    // 前端把 TG 频道拆成小批次（每批 2 个）请求后，若仍按"本批结果<3"判断，
    // 冷门词会让每一批都误触发深搜翻页（67 频道×8 页 = CPU 炸弹），
    // 因此只允许最后一批深搜（深搜只增结果，不减结果）。
    const allowDeep = (ext as any)?.__deep_search !== false;
    if (
      allowDeep &&
      results.length < SearchService.TG_DEEP_SEARCH_TRIGGER &&
      keyword.trim().length > 1 &&
      chList.length > 0
    ) {
      const deepTasks = [...priorityList, ...normalList].map((channel) =>
        createChannelTask(channel, SearchService.TG_DEEP_CHANNEL_LIMIT)
      );
      const deepResults = flattenResults(
        await this.runWithConcurrency(deepTasks, concurrency, signal)
      );
      results = this.mergeUniqueResults(results, deepResults);
    }

    if (cacheEnabled && results.length > 0) {
      this.cache.set(CacheNamespace.TG_SEARCH, cacheKey, results);
    }

    loggers.search.debug("TG 搜索汇总", {
      keyword,
      channelCount: chList.length,
      priorityCount: priorityList.length,
      normalCount: normalList.length,
      shallow: shallowResults.length,
      deep: results.length - shallowResults.length,
      wentDeep: results.length > shallowResults.length,
    });

    return results;
  }

  private async searchPlugins(
    keyword: string,
    plugins: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number,
    ext: Record<string, any>,
    errorCollector: ErrorCollector,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const cacheKey = `plugin:${keyword}:${(plugins ?? [])
      .map((plugin) => plugin?.toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",")}`;
    const { cacheEnabled } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.PLUGIN_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        return cached.value;
      }
    }

    const allPlugins = this.pluginManager.getPlugins();
    const healthyPlugins = allPlugins.filter((plugin) =>
      this.healthChecker.isHealthy(plugin.name())
    );

    let available: AsyncSearchPlugin[] = [];
    if (plugins && plugins.length > 0 && plugins.some((plugin) => !!plugin)) {
      const wanted = new Set(plugins.map((plugin) => plugin.toLowerCase()));
      available = healthyPlugins.filter((plugin) =>
        wanted.has(plugin.name().toLowerCase())
      );
    } else {
      available = healthyPlugins;
    }

    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );

    const pluginPromises = available.map((plugin) => async () => {
      plugin.setMainCacheKey(cacheKey);
      plugin.setCurrentKeyword(keyword);

      const startTime = Date.now();
      const pluginName = plugin.name();

      try {
        const queries =
          (keyword || "").trim().length <= 1
            ? [keyword, "电影", "movie", "1080p"]
            : buildSearchKeywordVariants(keyword).slice(0, 3);

        let results: SearchResult[] = [];
        for (const [index, query] of queries.entries()) {
          // 客户端断开时跳过剩余查询
          if (signal?.aborted) break;

          // 为每次插件请求创建独立的 AbortController，
          // 超时后 withTimeout 会 abort，使底层请求有机会被真正取消（而非泄漏）
          const controller = new AbortController();
          // 将外部取消和超时合并：任一触发都会 abort
          const mergedSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;
          const currentResults = await this.withTimeout<SearchResult[]>(
            plugin.search(query, { ...ext, signal: mergedSignal }),
            timeoutMs,
            [],
            controller
          );

          results = this.mergeUniqueResults(
            results,
            (currentResults || []).map(normalizeSearchResult)
          );

          if (
            results.length >= SearchService.PLUGIN_VARIANT_TRIGGER ||
            index === queries.length - 1
          ) {
            break;
          }
        }

        const responseTime = Date.now() - startTime;
        this.healthChecker.recordSuccess(pluginName, responseTime);

        return results;
      } catch (error) {
        const errorMs = Date.now() - startTime;
        this.healthChecker.recordFailure(pluginName);

        loggers.search.debug("单插件失败", {
          plugin: pluginName,
          ms: errorMs,
          error: error instanceof Error ? error.message : String(error),
          keyword,
        });

        throw error;
      }
    });

    const resultsByPlugin = await this.runWithConcurrency(
      pluginPromises.map((promiseFactory) => async () => {
        try {
          return await promiseFactory();
        } catch (error) {
          const errorDetail = classifyError(error, "plugin_search");
          errorCollector.record(errorDetail);
          return [];
        }
      }),
      concurrency,
      signal
    );

    const merged: SearchResult[] = [];
    for (const arr of resultsByPlugin) {
      if (Array.isArray(arr)) {
        merged.push(...arr);
      }
    }

    if (cacheEnabled && merged.length > 0) {
      this.cache.set(CacheNamespace.PLUGIN_SEARCH, cacheKey, merged);
    }

    return merged;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    fallback: T,
    controller?: AbortController
  ): Promise<T> {
    if (!ms || ms <= 0) return promise;
    let timeoutHandle: any;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => {
        // 超时后取消底层请求，避免 socket/内存泄漏
        if (controller && !controller.signal.aborted) {
          controller.abort();
        }
        resolve(fallback);
      }, ms);
    });
    return Promise.race([
      promise.finally(() => clearTimeout(timeoutHandle)),
      timeoutPromise,
    ]) as Promise<T>;
  }

  private mergeSearchResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    return this.mergeUniqueResults(a, b);
  }

  private mergeUniqueResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    const pushUnique = (result: SearchResult) => {
      const firstLink = Array.isArray(result.links) ? result.links[0]?.url : "";
      const key =
        result.unique_id ||
        result.message_id ||
        firstLink ||
        `${result.title}|${result.channel}|${result.datetime || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(result);
    };

    for (const result of a) pushUnique(result);
    for (const result of b) pushUnique(result);
    return out;
  }

  private sortResultsByTimeDesc(arr: SearchResult[]) {
    // 缺失/非法 datetime 不能直接 new Date(...).getTime()（会得 NaN），
    // 否则比较器返回 NaN 让排序结果未定义。统一视为 0（最旧），排到末尾。
    const toTime = (value?: string): number => {
      if (!value) return 0;
      const t = Date.parse(value);
      return Number.isFinite(t) ? t : 0;
    };
    arr.sort((x, y) => toTime(y.datetime) - toTime(x.datetime));
  }

  private mergeResultsByType(
    results: SearchResult[],
    _keyword: string,
    cloudTypes?: string[]
  ): MergedLinks {
    const allow =
      cloudTypes && cloudTypes.length > 0
        ? new Set(cloudTypes.map((value) => value.toLowerCase()))
        : undefined;
    const out: MergedLinks = {};
    for (const result of results) {
      // 隔离闸 C：即使上游插件返回畸形 links（非数组）也不会在此抛错
      if (!Array.isArray(result.links)) continue;
      for (const link of result.links) {
        if (!link || typeof link.url !== "string") continue;
        // 磁力链接一律不进聚合结果（双保险，防上游 type 标注异常）
        if (isMagnetLink(link)) continue;
        const type = (link.type || "").toLowerCase();
        if (allow && !allow.has(type)) continue;
        if (!out[type]) out[type] = [];
        out[type].push({
          url: link.url,
          password: link.password,
          note: result.title,
          datetime: result.datetime,
          images: result.images,
        });
      }
    }
    return out;
  }

  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    limit: number,
    signal?: AbortSignal
  ): Promise<T[]> {
    const limitFn = pLimit(limit);
    const limitedTasks = tasks.map((task) => limitFn(task));
    const results = await Promise.all(limitedTasks);
    // 客户端断开后，后续调用方应检查 signal，这里返回已有结果
    return results;
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(namespace?: CacheNamespace) {
    if (namespace) {
      this.cache.clearNamespace(namespace);
    } else {
      this.cache.clearAll();
    }
  }

  getPluginHealthStatus() {
    return this.healthChecker.getAllStatus();
  }

  resetPluginHealth(pluginName?: string) {
    if (pluginName) {
      this.healthChecker.reset(pluginName);
    } else {
      this.healthChecker.resetAll();
    }
  }
}
