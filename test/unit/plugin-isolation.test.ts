/**
 * 插件隔离测试
 * 验证“新增插件/接口有问题也不影响现有服务”三道闸：
 *   闸A 注册隔离（index.ts safeRegister）
 *   闸B 顶层任务隔离（searchWithWarnings 的 tg/plugin 任务 try/catch）
 *   闸C 结果合并隔离（normalizeSearchResult + mergeResultsByType 守卫）
 * 并验证 panLink 集中网盘识别。
 */
import { describe, it, expect } from "vitest";
import { SearchService } from "../../server/core/services/searchService";
import { PluginManager, BaseAsyncPlugin } from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";
import { MelostPlugin } from "../../server/core/plugins/melost";
import { Quark4kPlugin } from "../../server/core/plugins/quark4k";
import { getLinkType, extractLinksFromText } from "../../server/core/plugins/panLink";

class FakeNormalPlugin extends BaseAsyncPlugin {
  constructor() {
    super("fake-normal", 2);
  }
  override async search(): Promise<SearchResult[]> {
    return [
      {
        message_id: "",
        unique_id: "fake-normal-1",
        channel: "",
        datetime: new Date().toISOString(),
        title: "测试 正常结果",
        content: "",
        links: [{ type: "quark", url: "https://pan.quark.cn/s/normal", password: "" }],
      },
    ];
  }
}

class FakeThrowingPlugin extends BaseAsyncPlugin {
  constructor() {
    super("fake-throwing", 1);
  }
  override async search(): Promise<SearchResult[]> {
    throw new Error("boom");
  }
}

class FakeMalformedPlugin extends BaseAsyncPlugin {
  constructor() {
    super("fake-malformed", 3);
  }
  override async search(): Promise<any> {
    // links 故意为非数组，模拟上游插件返回畸形结构
    return [
      {
        message_id: "",
        unique_id: "fake-malformed-1",
        channel: "",
        datetime: "",
        title: "畸形",
        content: "",
        links: "not-an-array" as any,
      },
    ];
  }
}

function makeService(): SearchService {
  const pm = new PluginManager();
  pm.registerPlugin(new FakeNormalPlugin());
  pm.registerPlugin(new FakeThrowingPlugin());
  pm.registerPlugin(new FakeMalformedPlugin());
  return new SearchService(
    {
      priorityChannels: [],
      defaultChannels: [],
      defaultConcurrency: 4,
      pluginTimeoutMs: 3000,
      cacheEnabled: false,
      cacheTtlMinutes: 30,
    },
    pm
  );
}

describe("插件隔离（新增插件出问题不影响现有服务）", () => {
  it("坏插件抛错时，正常插件结果仍返回且整响应不抛异常", async () => {
    const svc = makeService();
    const { response, warnings } = await svc.searchWithWarnings(
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
    expect(Array.isArray(response.results)).toBe(true);
    const normal = response.results!.find((r) => r.unique_id === "fake-normal-1");
    expect(normal).toBeDefined();
    expect(normal!.links[0].url).toBe("https://pan.quark.cn/s/normal");
    // 坏插件抛错被收集为 warning，而不是让整响应失败
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("畸形 links（非数组）不会在合并阶段抛错", async () => {
    const svc = makeService();
    await expect(
      svc.searchWithWarnings(
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
      )
    ).resolves.toBeDefined();
  });

  it("坏插件连续失败触发熔断，后续请求自动跳过", async () => {
    const svc = makeService();
    for (let i = 0; i < 6; i += 1) {
      await svc.searchWithWarnings(
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
    }
    const status = svc.getPluginHealthStatus().find((s) => s.name === "fake-throwing");
    expect(status?.isHealthy).toBe(false);
  });

  it("新插件类可正常构造", () => {
    expect(new MelostPlugin().name()).toBe("melost");
    expect(new Quark4kPlugin().name()).toBe("quark4k");
  });
});

describe("panLink 集中网盘识别", () => {
  it("getLinkType 识别各网盘与协议", () => {
    expect(getLinkType("https://pan.quark.cn/s/abc")).toBe("quark");
    expect(getLinkType("https://alipan.com/s/abc")).toBe("aliyun");
    expect(getLinkType("https://pan.baidu.com/s/abc")).toBe("baidu");
    expect(getLinkType("https://drive.uc.cn/s/abc")).toBe("uc");
    expect(getLinkType("https://cloud.189.cn/t/abc")).toBe("tianyi");
    expect(getLinkType("https://115.com/s/abc")).toBe("115");
    expect(getLinkType("https://123pan.com/s/abc")).toBe("123");
    expect(getLinkType("magnet:?xt=urn:btih:abc")).toBe("magnet");
    expect(getLinkType("https://example.com/x")).toBe("others");
  });

  it("extractLinksFromText 还原 JSON 转义并提取多网盘", () => {
    const text =
      '见 https:\\/\\/pan.quark.cn\\/s\\/abc 提取码: 1234 还有 https://alipan.com/s/xyz';
    const links = extractLinksFromText(text);
    const types = links.map((l) => l.type).sort();
    expect(types).toContain("quark");
    expect(types).toContain("aliyun");
  });
});
