import { BaseAsyncPlugin } from "./manager";
import type { SearchResult } from "../types/models";
import { fetchWithRetry } from "../utils/fetch";

// 轻量版：直接请求 pansearch 的 _next data 接口

type Item = { id: number; content: string; pan: string; time?: string };
type Resp = { pageProps: { data: { total: number; data: Item[] } } };

const WEBSITE = "https://www.pansearch.me/search";
const DATA = (buildId: string) =>
  `https://www.pansearch.me/_next/data/${buildId}/search.json`;

export class PansearchPlugin extends BaseAsyncPlugin {
  constructor() {
    super("pansearch", 3);
  }
  override async search(keyword: string): Promise<SearchResult[]> {
    const buildId = await getBuildId().catch(() => "");
    if (!buildId) return [];
    const url = `${DATA(buildId)}?keyword=${encodeURIComponent(
      keyword
    )}&offset=0`;
    const resp = await fetchWithRetry<Resp>(
      url,
      {
        headers: { "user-agent": "Mozilla/5.0" },
      },
      {
        maxRetries: 2,
        timeout: 8000,
        logWarnings: false,
      }
    ).catch(() => undefined);
    const items = resp?.pageProps?.data?.data || [];
    const out: SearchResult[] = [];
    for (const it of items) {
      const link = extractLink(it.content);
      if (!link.url) continue;
      out.push({
        message_id: "",
        unique_id: `pansearch-${it.id}`,
        channel: "",
        datetime: it.time || "",
        title: extractTitle(it.content, keyword),
        content: cleanHTML(it.content),
        links: [
          { type: mapType(link.url), url: link.url, password: link.password },
        ],
      });
    }
    return out;
  }
}

// buildId 是 Next.js 构建产物 ID，变化频率以天/部署计，缓存 1 小时避免每次搜索都重抓首页
let cachedBuildId: { value: string; expires: number } | null = null;
const BUILD_ID_TTL = 3600_000; // 1 小时

async function getBuildId(): Promise<string> {
  if (cachedBuildId && Date.now() < cachedBuildId.expires) {
    return cachedBuildId.value;
  }

  const html = await fetchWithRetry<string>(
    WEBSITE,
    {
      headers: { "user-agent": "Mozilla/5.0" },
    },
    {
      maxRetries: 2,
      timeout: 8000,
      logWarnings: false,
    }
  );
  const m = /"buildId":"([^"]+)"/.exec(html);
  if (m) {
    cachedBuildId = { value: m[1], expires: Date.now() + BUILD_ID_TTL };
    return m[1];
  }
  const m2 =
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(
      html
    );
  if (m2) {
    try {
      const data = JSON.parse(m2[1]);
      if (data?.buildId) {
        cachedBuildId = { value: data.buildId, expires: Date.now() + BUILD_ID_TTL };
        return data.buildId;
      }
    } catch {}
  }
  throw new Error("no buildId");
}

function extractLink(content: string): { url: string; password: string } {
  // 简单从 a 标签与 pwd 参数提取
  const mHref = /href=\"([^\"]+)\"/.exec(content);
  const url = mHref ? mHref[1] : "";
  let password = "";
  const mPwd = /[?&]pwd=([^"&#]+)/.exec(content);
  if (mPwd) password = mPwd[1];
  return { url, password };
}
export function extractTitle(content: string, keyword: string): string {
  // 2026-08-26 两次修复：
  // ①上游把命中关键词包在 <span class='highlight-keyword'> 里，直接对原始
  //   HTML 用 /名称：([^<\n]+)/ 提取会被 < 截断成孤立 "["（用户首次截图：
  //   百度网盘结果 note 是 "["/"《"）。先 cleanHTML 剥标签再提取。
  // ②pansearch 上游把所有字段（名称/描述/链接/📁大小/🏷标签/⚠版权/
  //   📢频道…）挤在一行里没有 \n，原来的 [^\n]+ 会贪婪到行尾把整段
  //   当 title，UI 直接爆炸（用户二次截图：note 5 行铺满含描述/标签/
  //   版权等）。改用惰性 + lookahead：截到下个字段标签
  //   （描述/链接/📁/🏷/⚠️/📢/👥/🔍）前即停。
  const cleaned = cleanHTML(content);
  const m = /名称[：:]\s*([\s\S]+?)(?=\s*(?:描述[：:]|链接[：:]|📁|🏷|⚠️|📢|👥|🔍|$))/u.exec(
    cleaned
  );
  if (m) {
    const t = m[1].trim();
    if (t) return t;
  }
  return keyword;
}
function cleanHTML(html: string): string {
  return html
    .replace(/<span class='highlight-keyword'>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function mapType(url: string): string {
  const u = url.toLowerCase();
  if (u.startsWith("magnet:")) return "magnet";
  if (u.startsWith("ed2k:")) return "ed2k";
  if (u.includes("pan.baidu.com")) return "baidu";
  if (u.includes("alipan.com") || u.includes("aliyundrive.com"))
    return "aliyun";
  if (u.includes("pan.quark.cn")) return "quark";
  if (u.includes("cloud.189.cn")) return "tianyi";
  if (u.includes("pan.xunlei.com")) return "xunlei";
  if (u.includes("caiyun") || u.includes("yun.139.com")) return "mobile";
  if (u.includes("115.com")) return "115";
  if (u.includes("123pan.com")) return "123";
  if (u.includes("drive.uc.cn")) return "uc";
  if (u.includes("mypikpak.com")) return "pikpak";
  if (u.includes("lanzou")) return "lanzou";
  return "others";
}

