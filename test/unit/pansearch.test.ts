import { describe, it, expect } from "vitest";
import { extractTitle } from "../../server/core/plugins/pansearch";

describe("pansearch.extractTitle", () => {
  it("上游用 <span class='highlight-keyword'> 包裹命中词时，提取完整标题而非孤立 [（2026-08-26 用户截图回归）", () => {
    const content =
      "名称：[<span class='highlight-keyword'>阿甘正传</span>][1994][励志][美国] 链接：https://pan.baidu.com/s/xxx";
    const title = extractTitle(content, "阿甘正传");
    expect(title).toContain("阿甘正传");
    expect(title).not.toBe("[");
    expect(/^[\[\]《》【】\s]+$/.test(title)).toBe(false);
  });

  it("名称：后紧跟 <span> 的变体也不截断成孤立《", () => {
    const content =
      "名称：《<span class='highlight-keyword'>繁花</span>》全集高清 百度网盘 https://pan.baidu.com/s/yyy";
    const title = extractTitle(content, "繁花");
    expect(title).toContain("繁花");
    expect(/^[\[\]《》【】\s]+$/.test(title)).toBe(false);
  });

  it("content 无「名称：」字段时回退用搜索关键词", () => {
    const content = "<p>随便一段没有名称字段的内容 https://pan.baidu.com/s/zzz</p>";
    const title = extractTitle(content, "阿甘正传");
    expect(title).toBe("阿甘正传");
  });

  it("英文冒号「名称:」也能提取", () => {
    const content =
      "名称:[<span class='highlight-keyword'>泰坦尼克号</span>]1997 4K https://pan.baidu.com/s/www";
    const title = extractTitle(content, "泰坦尼克号");
    expect(title).toContain("泰坦尼克号");
  });

  it("普通无标签 content 正常提取", () => {
    const content = "名称：肖申克的救赎 1994 1080P https://pan.baidu.com/s/aaa";
    const title = extractTitle(content, "肖申克的救赎");
    expect(title).toBe("肖申克的救赎 1994 1080P https://pan.baidu.com/s/aaa");
  });

  // 2026-08-26 二次修复：pansearch 上游把所有字段挤在一行里没有 \n，
  // 原来的 [^\n]+ 会贪婪到行尾把整段（描述/链接/大小/标签/版权/频道
  // …）都当 title，UI 爆炸。改用惰性 + lookahead 截到下个字段标签前。
  it("名称、描述、链接挤在同一行时，title 只保留「名称」字段（不再贪婪到行尾）", () => {
    const realContent =
      "名称：[<span class='highlight-keyword'>阿甘正传</span> ][1994][中英双字][4K HDR][29.6G] 描述：智商不高的阿甘，凭借着单纯的信念和执着的精神…… 链接： https://pan.baidu.com/s/1ZYZilBW8mtbC27lx8U9V8Q?pwd=3z2k 📁 大小：NG 🏷 标签：#电影 #欧美电影 #阿甘正传 ⚠️ 版权：版权反馈/DMCA 📢 频道 👥 群组 🔍 投稿/搜索";
    const title = extractTitle(realContent, "阿甘正传");

    // 应只含「名称」段内容，不应包含描述/链接/大小/标签/版权等字段
    expect(title).toContain("阿甘正传");
    expect(title).not.toContain("描述");
    expect(title).not.toContain("https://pan.baidu.com");
    expect(title).not.toContain("标签");
    expect(title).not.toContain("版权");
    expect(title).not.toContain("🏷");
    expect(title).not.toContain("📁");
    expect(title.length).toBeLessThan(80);
    expect(title).toMatch(/^\[阿甘正传/); // 应该以 [阿甘正传 开头，紧跟空格
  });

  it("只有「名称」字段无后续字段时也能正确提取", () => {
    const content =
      "名称：[<span class='highlight-keyword'>肖申克的救赎</span>][1994][1080P]";
    const title = extractTitle(content, "肖申克的救赎");
    expect(title).toContain("肖申克的救赎");
    expect(title).not.toContain("描述");
    expect(title.length).toBeLessThan(80);
  });
});
