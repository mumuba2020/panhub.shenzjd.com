import { BaseAsyncPlugin } from "./manager";
import type { SearchResult, Link } from "../types/models";
import { ofetch } from "ofetch";
import { extractLinksFromText } from "./panLink";

// quark4k 搜索插件（论坛 Flarum 结构，移植自 pansou quark4k.go）
// 注意：当前沙箱环境无法直连 quark4k.com（TLS 握手失败），故未做线上探活。
// 借助 searchService 的三道隔离闸（单插件 try/catch + 熔断 + 注册 try/catch），
// 即使该源在生产环境也失效，也只会被熔断自动跳过，绝不拖垮 pansearch/nyaa/TG。
const BASE = "https://quark4k.com/api/discussions";
const REFERER = "https://quark4k.com/";

type FlarumPost = { id: string; attributes?: { contentHtml?: string } };
type FlarumDiscussion = {
  id: string;
  attributes?: { title?: string; createdAt?: string; contentHtml?: string };
  relationships?: {
    mostRelevantPost?: { data?: { type?: string; id?: string } };
  };
};
type FlarumResponse = {
  data?: FlarumDiscussion[];
  included?: FlarumPost[];
  links?: { next?: string };
};

function cleanHTML(html?: string): string {
  let s = html || "";
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "\n");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function findPasswordNear(lines: string[], linkLineIdx: number): string {
  for (
    let i = Math.max(0, linkLineIdx - 2);
    i <= Math.min(lines.length - 1, linkLineIdx + 2);
    i += 1
  ) {
    const m = /(?:提取码|密码)[:：]\s*([0-9a-zA-Z]{4,12})/.exec(lines[i]);
    if (m) return m[1];
  }
  return "";
}

export class Quark4kPlugin extends BaseAsyncPlugin {
  constructor() {
    super("quark4k", 3);
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

    const url =
      `${BASE}?include=user%2ClastPostedUser%2CmostRelevantPost%2CmostRelevantPost.user%2Ctags%2Ctags.parent%2CfirstPost` +
      `&filter[q]=${encodeURIComponent(kw)}&sort&page[offset]=0&page[limit]=50`;

    const resp = await ofetch<FlarumResponse>(url, {
      headers: {
        Referer: REFERER,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      timeout,
    }).catch(() => undefined);

    const discussions = resp?.data;
    if (!Array.isArray(discussions) || discussions.length === 0) return [];

    const postMap = new Map<string, FlarumPost>();
    for (const p of resp?.included || []) {
      if (p && p.id) postMap.set(p.id, p);
    }

    const out: SearchResult[] = [];
    for (const disc of discussions) {
      const title = (disc.attributes?.title || "").trim();
      if (title && !title.toLowerCase().includes(kw.toLowerCase())) continue;

      const postId = disc.relationships?.mostRelevantPost?.data?.id;
      const post = postId ? postMap.get(postId) : undefined;
      const contentHtml =
        post?.attributes?.contentHtml || disc.attributes?.contentHtml || "";
      if (!contentHtml) continue;

      const cleaned = cleanHTML(contentHtml);
      if (!cleaned) continue;

      const links = extractLinksFromText(cleaned);
      if (links.length === 0) continue;

      const lines = cleaned.split("\n");
      const finalLinks: Link[] = links.map((l) => {
        if (l.type !== "quark") return l;
        const idx = lines.findIndex((ln) => ln.includes(l.url));
        const pwd = idx >= 0 ? findPasswordNear(lines, idx) : "";
        return pwd ? { ...l, password: pwd } : l;
      });

      const dt = disc.attributes?.createdAt;
      const datetime = dt ? new Date(dt).toISOString() : "";
      out.push({
        message_id: "",
        unique_id: `quark4k-${disc.id}`,
        channel: "",
        datetime,
        title: title || kw,
        content: cleaned,
        links: finalLinks,
      });
    }
    return out;
  }
}
