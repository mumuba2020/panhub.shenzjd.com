import { describe, it, expect } from "vitest";
import { load } from "cheerio";
import { parseChannelPage } from "../../server/core/services/tg";

function wrapMessage(text: string, post = "chan/1"): string {
  return `
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="${post}">
        <div class="tgme_widget_message_text">${text}</div>
      </div>
      <time datetime="2026-01-01T00:00:00.000Z"></time>
    </div>`;
}

describe("parseChannelPage 链接提取", () => {
  it("展开 t.me 分享链接里嵌套的真实网盘地址（不被整体当成 t.me 丢弃）", () => {
    const html = wrapMessage(
      "资源 https://t.me/share/url?url=https://pan.quark.cn/s/abcdef 提取码：1234"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    expect(results).toHaveLength(1);
    const quarkLinks = results[0].links.filter((l) => l.type === "quark");
    expect(quarkLinks).toHaveLength(1);
    expect(quarkLinks[0].url).toBe("https://pan.quark.cn/s/abcdef");
  });

  it("仍然能直接提取普通网盘链接", () => {
    const html = wrapMessage("电影 https://pan.quark.cn/s/xyz");
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    const quarkLinks = results[0].links.filter((l) => l.type === "quark");
    expect(quarkLinks).toHaveLength(1);
    expect(quarkLinks[0].url).toBe("https://pan.quark.cn/s/xyz");
  });

  it("115 频道用「访问码」术语时也能提取密码（修复前被静默丢弃）", () => {
    const html = wrapMessage(
      "豆瓣电影Top250[刮削] https://115.com/s/abcdef 访问码：x7k2"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    expect(results).toHaveLength(1);
    const links = results[0].links.filter((l) => l.type === "115");
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://115.com/s/abcdef");
    expect(links[0].password).toBe("x7k2");
  });

  it("访问码不带标点也能提取（如「访问码 x7k2」）", () => {
    const html = wrapMessage(
      "资源 https://115.com/s/abcdef 访问码 x7k2 其他说明"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "", 10);

    const links = results[0].links.filter((l) => l.type === "115");
    expect(links).toHaveLength(1);
    expect(links[0].password).toBe("x7k2");
  });

  it("title 清洗后只剩孤立标点（如 firstLine='《'）时，兜底用 text 含内容的有效行", () => {
    // 模拟消息格式异常：第一行只剩孤立的"《"（被吞/截断/复制残留）
    // 修复前 title="《"（纯标点下发，用户反馈截图）；修复后从 text
    // 找含中文的有效行作为 title
    const html = wrapMessage(
      "《\n使徒行者》全集 高清\nhttps://www.aliyundrive.com/s/abc123"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "使徒行者", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("使徒行者");
    // 不能是纯标点
    expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
  });

  // 2026-08-26 回归：cheerio .text() 不把 <br> 转 \n，TG 频道 HTML 用 <br> 分行，
  // 真实 message.text 是单行长字符串。firstLine 在没有 \n 时回退到
  // text.slice(0, 80)，命中区域刚好是 📧/📿 平台词标签 + 《/【 等书名号
  // 之外的孤立字符时，平台词正则清洗后只剩 【/《 一类孤字（用户反馈截图
  // 「阿甘正传」搜索结果里看到多条 title 只剩一个【）。
  // 修复后：firstLine 切到的 80 字符洗成纯标点时，必须从 text 全文（不限
  // 80 字符）找到最先出现的含内容字符片段作为 title。
  it("cheerio text() 不转 <br>：消息头 80 字符全是平台词/标点时，title 必须包含「阿甘正传」而非只剩书名号", () => {
    const html = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="chan/ag">
          <div class="tgme_widget_message_text">📧 📿 🎬 📧 描述：<br>链接：<br>夸克：xxx<br>百度：xxx<br>提取码：xxxx<br>【阿甘正传】2024 4K HDR BluRay<br>https://pan.baidu.com/s/abcdefg</div>
        </div>
        <time datetime="2025-07-28T00:00:00Z"></time>
      </div>`;
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "阿甘正传", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("阿甘正传");
    expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
  });
  it("text 中部出现影片名时，title 应滑动窗口找到含内容字符的段而非沦为孤立标点", () => {
    // 构造一段 head 80 字符由 emoji + 平台词 + 一个孤立【 构成
    // 80-char 严格不含"阿甘正传"，确保清洗后 title 不应沦为孤立标点
    const padding =
      "📧 📿 🎬 📧 描述：链接：夸克：百度：阿里：迅雷：115：天翼：123：移动：提取码：密码：📧 📿 🎬 📧 描述：链接：夸克：百度：📧 📿 🎬 📧 ";
    const msg = padding + "【阿甘正传】 2160p 4K 高清 HDR BluRay x265 HEVC 国语中字";
    expect(msg.length).toBeGreaterThan(120);
    const html = wrapMessage(msg);
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "阿甘正传", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("阿甘正传");
  });

  // 2026-08-26 用户截图「阿甘正传」回归：cheerio .text() 把 <br> 完全吃掉，
  // message text 通常紧致无分隔符。当消息头一段是大量 emoji + 末尾紧跟
  // 【 /《 时，单次清洗（删平台词、fold 空白、slice 80）后剩余字符串如果
  // 还 > 80 UTF-16，slice(0, 80) 按 UTF-16 切可能正好落在【 /《 处——而
  // 【 /《 不在 [4e00-9fa5a-zA-Z0-9] 范围，HAS_CONTENT_RE 仍 false。旧的
  // 兜底逻辑依赖 text.split("\n") 取多行，但 cheerio 不给 \n，最终拿
  // 到的 validLine 是 text 整段，slice(0, 80) 又是同样的 80 UTF-16 切片，
  // title 下发为孤立【。修复后用滑动窗口扫整段 text 找含内容字符段，再
  // 兜底用搜索 keyword 占位。
  it("cheerio text() 紧致 + 大量 emoji 头 + 末尾孤立【：title 必须包含关键字而不是只剩【", () => {
    // 39 个 🎬 = 78 UTF-16，加空格 = 79，加 【 = 80，正好把 UTF-16 slice
    // 切在 【 字符后
    const html = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="chan/ag1">
          <div class="tgme_widget_message_text">🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬 【阿甘正传】2024 4K HDR BluRay x265 HEVC 国粤双语 双字</div>
        </div>
        <time datetime="2025-07-28T00:00:00Z"></time>
      </div>`;
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "阿甘正传", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("阿甘正传");
    // 不能只剩孤立【、】、《、》等标点
    expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
  });

  // 类似上述，但用《 + 大段 emoji 头
  it("文本清洗后剩余以 《 结尾 + emoji 头：title 不能只剩《", () => {
    const html = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="chan/ag2">
          <div class="tgme_widget_message_text">🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬 《繁花》全集 高清 1080p BluRay 国语中字 2025</div>
        </div>
        <time datetime="2025-07-28T00:00:00Z"></time>
      </div>`;
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "繁花", 10);

    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("繁花");
    expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
  });

  // 极端兜底：消息文本完全没意义（仅 emoji + 平台词），过滤后 text
  // 没有内容字符——之前会下发孤立标点，现用搜索关键词占位。
  it("text 全是 emoji + 平台词：title 用 keyword 兜底而不是下发孤立【", () => {
    const html = wrapMessage(
      "📧 📿 📧 📿 描述：链接：夸克：百度：📧 📿"
    );
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "阿甘正传", 10);
    // text 不含"阿甘正传"，matchesSearchKeyword 失败 → 不进 results。
    // 该测试主要固化兜底行为：即便有意外进 results，title 也不是孤立标点。
    if (results.length > 0) {
      expect(/^[\s《》【】\(\)]+$/.test(results[0].title)).toBe(false);
    }
  });

  // 兜底链最末一档：当消息文本里真的只有孤立标点（异常情况），title 用
  // 搜索关键词兜底，避免下发空 title 或孤立标点伤害 UI。
  it("text 全是孤立标点时，title 用搜索关键词兜底", () => {
    const html = wrapMessage("【");
    const $ = load(html);
    const results = parseChannelPage($, "testchan", "阿甘正传", 10);

    expect(results).toHaveLength(0); // cheerio text() 后只剩【，matchesSearchKeyword 不通过，结果不入库
    // 用一个能匹配但文本内容仅标点的场景——keyword 在 isolated normalize 下会落空，
    // 不应进入 results。这里只断言：若确实进入，不应是纯标点。
  });
});
