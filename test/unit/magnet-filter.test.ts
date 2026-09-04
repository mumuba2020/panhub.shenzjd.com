/**
 * 磁力链接过滤测试
 * 产品需求：搜索结果不出现磁力链接。
 * 验证 SearchService 在 results / merged_by_type 两种输出模式下都剔除 magnet。
 */
import { describe, expect, it } from "vitest";
import { SearchService } from "../../server/core/services/searchService";
import { BaseAsyncPlugin, PluginManager } from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

// 纯种子站风格：结果只有磁力链接
class MagnetOnlyPlugin extends BaseAsyncPlugin {
  override async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "m1",
        unique_id: "magnet-only-1",
        channel: "seed",
        datetime: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        title: "测试 纯种子资源",
        content: "",
        links: [{ type: "magnet", url: "magnet:?xt=urn:btih:abc123", password: "" }],
      },
    ];
  }
}

// 混合风格：同一条结果里既有网盘又有磁力链接
class MixedPlugin extends BaseAsyncPlugin {
  override async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "mx1",
        unique_id: "mixed-1",
        channel: "mixed",
        datetime: new Date("2026-01-02T00:00:00.000Z").toISOString(),
        title: "测试 混合资源",
        content: "",
        links: [
          { type: "quark", url: "https://pan.quark.cn/s/abc", password: "1234" },
          { type: "magnet", url: "magnet:?xt=urn:btih:def456", password: "" },
        ],
      },
    ];
  }
}

// 上游把磁力 URL 标成其他 type 的漏网场景
class MislabeledPlugin extends BaseAsyncPlugin {
  override async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "ml1",
        unique_id: "mislabeled-1",
        channel: "mislabeled",
        datetime: new Date("2026-01-03T00:00:00.000Z").toISOString(),
        title: "测试 错误标注",
        content: "",
        links: [
          { type: "others", url: "magnet:?xt=urn:btih:deadbeef", password: "" },
        ],
      },
    ];
  }
}

// 正常网盘插件：不受影响
class PanOnlyPlugin extends BaseAsyncPlugin {
  override async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "p1",
        unique_id: "pan-only-1",
        channel: "pan",
        datetime: new Date("2026-01-04T00:00:00.000Z").toISOString(),
        title: "测试 网盘资源",
        content: "",
        links: [
          { type: "baidu", url: "https://pan.baidu.com/s/xyz", password: "abcd" },
        ],
      },
    ];
  }
}

function createService(plugins: BaseAsyncPlugin[]) {
  const manager = new PluginManager();
  for (const plugin of plugins) manager.registerPlugin(plugin);
  return new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 2,
      pluginTimeoutMs: 100,
      cacheEnabled: false,
      cacheTtlMinutes: 1,
    },
    manager
  );
}

describe("搜索结果过滤磁力链接", () => {
  it("merged_by_type 模式：纯磁力结果不产出任何链接分组", async () => {
    const svc = createService([new MagnetOnlyPlugin("magnet-only", 1)]);
    const { response } = await svc.searchWithWarnings(
      "测试",
      undefined,
      undefined,
      false,
      "merged_by_type",
      "plugin",
      undefined,
      undefined,
      {},
      undefined
    );
    expect(response.merged_by_type).toBeDefined();
    expect(Object.keys(response.merged_by_type!).length).toBe(0);
    expect(response.total).toBe(0);
  });

  it("merged_by_type 模式：混合结果保留网盘、剔除磁力", async () => {
    const svc = createService([new MixedPlugin("mixed", 1)]);
    const { response } = await svc.searchWithWarnings(
      "测试",
      undefined,
      undefined,
      false,
      "merged_by_type",
      "plugin",
      undefined,
      undefined,
      {},
      undefined
    );
    const merged = response.merged_by_type!;
    expect(merged.quark).toHaveLength(1);
    expect(merged.quark![0].url).toBe("https://pan.quark.cn/s/abc");
    expect(merged.magnet).toBeUndefined();
  });

  it("url 以 magnet: 开头即使 type 标错也会被剔除", async () => {
    const svc = createService([new MislabeledPlugin("mislabeled", 1)]);
    const { response } = await svc.searchWithWarnings(
      "测试",
      undefined,
      undefined,
      false,
      "merged_by_type",
      "plugin",
      undefined,
      undefined,
      {},
      undefined
    );
    expect(Object.keys(response.merged_by_type!).length).toBe(0);
  });

  it("results 模式：纯磁力结果整条不返回", async () => {
    const svc = createService([
      new MagnetOnlyPlugin("magnet-only", 1),
      new PanOnlyPlugin("pan-only", 1),
    ]);
    const { response } = await svc.searchWithWarnings(
      "测试",
      undefined,
      undefined,
      false,
      "results",
      "plugin",
      undefined,
      undefined,
      {},
      undefined
    );
    const ids = response.results!.map((r) => r.unique_id);
    expect(ids).not.toContain("magnet-only-1");
    expect(ids).toContain("pan-only-1");
  });

  it("results 模式：混合结果的 links 中不含磁力链接", async () => {
    const svc = createService([new MixedPlugin("mixed", 1)]);
    const { response } = await svc.searchWithWarnings(
      "测试",
      undefined,
      undefined,
      false,
      "results",
      "plugin",
      undefined,
      undefined,
      {},
      undefined
    );
    expect(response.results).toHaveLength(1);
    const urls = response.results![0].links.map((l) => l.url);
    expect(urls).toEqual(["https://pan.quark.cn/s/abc"]);
  });
});
