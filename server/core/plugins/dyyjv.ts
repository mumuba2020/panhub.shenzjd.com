import { BaseAsyncPlugin } from "./manager";
import type { SearchResult, Link } from "../types/models";
import { ofetch } from "ofetch";
import pLimit from "p-limit";
import { extractLinksFromText, cleanHTML } from "./panLink";

/**
 * dyyjv（电影云集影视网）搜索插件
 *
 * 逆向结论（2026-08-07 实测）：
 *   - 搜索：WordPress REST API `https://dyyjv.com/wp-json/wp/v2/search?search=<kw>&per_page=10`
 *     （匿名可用，返回 [{id,title,url}]；旧域名 dyyjpro.com 已 301 到 dyyjv.com）
 *   - 链接：详情页 `https://dyyjv.com/<id>.html` 内嵌夸克/百度等网盘链接，
 *     百度密码在 URL query `?pwd=xxx` 中（如 ...?pwd=dyyj）
 *   - 两段式：先搜索拿 id，再并发抓详情页提取链接
 */

const BASE = "https://dyyjv.com";
const MAX_DETAILS = 5;
const DETAIL_CONCURRENCY = 3;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface DyyjvItem {
  id: number;
  title: string;
}

/** 解析 wp-json 搜索结果（独立导出，供单测） */
export function parseDyyjvSearch(json: any): DyyjvItem[] {
  if (!Array.isArray(json)) return [];
  const out: DyyjvItem[] = [];
  for (const x of json) {
    if (!x || typeof x.id !== "number" || !x.url) continue;
    out.push({ id: x.id, title: cleanHTML(String(x.title || "")).slice(0, 200) });
  }
  return out;
}

/** 从 URL query 补提取码（百度/夸克等分享链接常带 ?pwd=xxx / ?password=xxx） */
export function enrichPassword(links: Link[]): Link[] {
  return links.map((l) => {
    if (l.password) return l;
    try {
      const u = new URL(l.url);
      const pwd = u.searchParams.get("pwd") || u.searchParams.get("password") || "";
      if (pwd) return { ...l, password: pwd };
    } catch {
      /* 非 URL 跳过 */
    }
    return l;
  });
}

/** 从详情页 HTML 提取网盘链接 + 补密码（独立导出，供单测） */
export function extractDyyjvLinks(html: string): Link[] {
  return enrichPassword(extractLinksFromText(html));
}

export class DyyjvPlugin extends BaseAsyncPlugin {
  constructor() {
    super("dyyjv", 3);
  }

  override async search(
    keyword: string,
    ext?: Record<string, any>
  ): Promise<SearchResult[]> {
    const timeout = Math.max(
      3000,
      Number((ext as any)?.__plugin_timeout_ms) || 12000
    );
    const kw = (keyword || "").trim();
    if (!kw) return [];

    // 第一步：wp-json 搜索
    let items: DyyjvItem[] = [];
    try {
      const json = await ofetch<any>(
        `${BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(kw)}&per_page=10`,
        { headers: { "user-agent": UA, accept: "application/json" }, timeout }
      );
      items = parseDyyjvSearch(json);
    } catch {
      return [];
    }
    if (items.length === 0) return [];

    // 第二步：并发抓详情页提取链接
    const limitFn = pLimit(DETAIL_CONCURRENCY);
    const tasks = items.slice(0, MAX_DETAILS).map((item) =>
      limitFn(async (): Promise<SearchResult | null> => {
        try {
          const html = await ofetch<string>(`${BASE}/${item.id}.html`, {
            headers: { "user-agent": UA },
            timeout,
          });
          const links = extractDyyjvLinks(html);
          if (links.length === 0) return null;
          const title = item.title || `dyyjv-${item.id}`;
          return {
            message_id: "",
            unique_id: `dyyjv-${item.id}-${links[0].url}`,
            channel: "",
            datetime: "",
            title,
            content: title,
            links,
          };
        } catch {
          return null;
        }
      })
    );

    const results = await Promise.all(tasks);
    return results.filter((r): r is SearchResult => r !== null);
  }
}
