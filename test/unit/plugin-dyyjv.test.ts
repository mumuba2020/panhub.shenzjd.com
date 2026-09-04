import { describe, it, expect } from "vitest";
import {
  parseDyyjvSearch,
  extractDyyjvLinks,
  DyyjvPlugin,
} from "../../server/core/plugins/dyyjv";

describe("dyyjv（电影云集）解析", () => {
  it("解析 wp-json 搜索结果", () => {
    const json = [
      { id: 15451, title: "流浪地球之大夏战狼 (2024)", url: "https://dyyjv.com/15451.html", type: "post" },
      { id: 15452, title: "流浪地球2 (2023)", url: "https://dyyjv.com/15452.html", type: "post" },
      { id: 0, title: "bad", url: "" }, // 无效项应被跳过
    ];
    const items = parseDyyjvSearch(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: 15451, title: "流浪地球之大夏战狼 (2024)" });
  });

  it("非数组返回空", () => {
    expect(parseDyyjvSearch(null)).toEqual([]);
    expect(parseDyyjvSearch({})).toEqual([]);
  });

  it("从详情页 HTML 提取夸克+百度链接并补密码", () => {
    const html = `
      <meta name="description" content="主演：杨桃 集数：52 夸克网盘 https://pan.quark.cn/s/19e3b2ed3f7e 百度网盘 https://pan.baidu.com/s/12O7eZFBDUajKy951QK-WyQ?pwd=dyyj 短剧">
      <a href="https://pan.quark.cn/s/19e3b2ed3f7e">夸克</a>
      <a href="https://example.com/irrelevant">普通链接应被过滤</a>
    `;
    const links = extractDyyjvLinks(html);
    expect(links.length).toBe(2);
    const quark = links.find((l) => l.url.includes("quark"));
    const baidu = links.find((l) => l.url.includes("baidu"));
    expect(quark?.type).toBe("quark");
    expect(baidu?.type).toBe("baidu");
    expect(baidu?.password).toBe("dyyj"); // 从 ?pwd= 提取
    expect(links.some((l) => l.url.includes("example.com"))).toBe(false);
  });

  it("插件构造正常", () => {
    const p = new DyyjvPlugin();
    expect(p.name()).toBe("dyyjv");
  });
});
