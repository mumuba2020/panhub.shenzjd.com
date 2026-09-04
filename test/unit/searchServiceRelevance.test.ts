import { describe, expect, it } from "vitest";
import { SearchService } from "../../server/core/services/searchService";
import {
  BaseAsyncPlugin,
  PluginManager,
} from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

/**
 * 2026-08-27 用户拍板：搜索结果做相关性过滤——真实存在但名字对不上
 * 搜索词的结果不展示（上游如 dyyjv 自带「相关推荐」板块，搜「阿甘正传」
 * 会混入「好莱坞俗套大吐槽」等无关资源；yunso 已因上游失效于同日移除）。
 */

/** 返回一组 mix：相关 + 无关 title 的插件 */
class MixedPlugin extends BaseAsyncPlugin {
  async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "rel-1",
        unique_id: "rel-1",
        channel: "mixed",
        datetime: "2026-01-01T00:00:00.000Z",
        title: "阿甘正传 (1994) 4K HDR BluRay",
        content: "阿甘正传",
        links: [{ type: "quark", url: "https://example.com/rel", password: "" }],
      },
      {
        message_id: "rel-2",
        unique_id: "rel-2",
        channel: "mixed",
        datetime: "2026-01-02T00:00:00.000Z",
        title: "【阿甘正传】1994 中英双字",
        content: "",
        links: [{ type: "baidu", url: "https://example.com/rel2", password: "" }],
      },
      {
        message_id: "irrel-1",
        unique_id: "irrel-1",
        channel: "mixed",
        datetime: "2026-01-03T00:00:00.000Z",
        title: "好莱坞俗套大吐槽 (2021)丨6.8分",
        content: "冷门喜剧纪录片推荐",
        links: [{ type: "quark", url: "https://example.com/irrel", password: "" }],
      },
      {
        message_id: "irrel-2",
        unique_id: "irrel-2",
        channel: "mixed",
        datetime: "2026-01-04T00:00:00.000Z",
        title: "【黑暗侵袭】1-2部",
        content: "",
        links: [{ type: "quark", url: "https://example.com/irrel2", password: "" }],
      },
      {
        message_id: "irrel-3",
        unique_id: "irrel-3",
        channel: "mixed",
        datetime: "2026-01-05T00:00:00.000Z",
        title: "一人之下，天官赐福 作者：白二十五.txt",
        content: "",
        links: [{ type: "quark", url: "https://example.com/irrel3", password: "" }],
      },
    ];
  }
}

/** 关键词在 content 里（title 可能不含）也要保留 */
class KeywordInContentPlugin extends BaseAsyncPlugin {
  async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "c-1",
        unique_id: "c-1",
        channel: "content-match",
        datetime: "2026-01-01T00:00:00.000Z",
        title: "【原盘】4K蓝光",
        content: "阿甘正传 Forrest Gump 1994 REMUX",
        links: [{ type: "baidu", url: "https://example.com/c", password: "" }],
      },
    ];
  }
}

function createService(plugin: BaseAsyncPlugin) {
  const manager = new PluginManager();
  manager.registerPlugin(plugin);
  return new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 1000,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
    },
    manager
  );
}

describe("SearchService 结果相关性过滤（2026-08-27）", () => {
  it("与搜索词无关的结果整条丢弃（title/content 都匹配不到关键词）", async () => {
    const service = createService(new MixedPlugin("mixed", 1));
    const { response } = await service.searchWithWarnings(
      "阿甘正传",
      [],
      2,
      false,
      "merged_by_type",
      "plugin",
      ["mixed"],
      undefined,
      {}
    );

    expect(response.total).toBe(2); // 只有 2 条相关，3 条无关被滤掉

    const notes = (Object.values(response.merged_by_type || {}) as any[])
      .flat()
      .map((item: any) => item.note);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(String(note)).toContain("阿甘正传");
    }
    expect(notes.join(" ")).not.toContain("好莱坞俗套大吐槽");
    expect(notes.join(" ")).not.toContain("黑暗侵袭");
    expect(notes.join(" ")).not.toContain(".txt");
  });

  it("关键词出现在 content（而非 title）时结果保留", async () => {
    const service = createService(
      new KeywordInContentPlugin("content-match", 1)
    );
    const { response } = await service.searchWithWarnings(
      "阿甘正传",
      [],
      2,
      false,
      "merged_by_type",
      "plugin",
      ["content-match"],
      undefined,
      {}
    );

    expect(response.total).toBe(1);
  });

  it("单字符关键词跳过相关性过滤（插件兜底变体如 电影/movie/1080p）", async () => {
    // 插件返回完全不相关的 title，但 keyword 是单字符 "a"：
    // 不能过滤（会误杀「搜 1 出 1080p 资源」这类兜底场景）
    const service = createService(new MixedPlugin("mixed", 1));
    const { response } = await service.searchWithWarnings(
      "a",
      [],
      2,
      false,
      "merged_by_type",
      "plugin",
      ["mixed"],
      undefined,
      {}
    );

    expect(response.total).toBe(5); // 单字符不过滤，5 条全保留
  });
});
