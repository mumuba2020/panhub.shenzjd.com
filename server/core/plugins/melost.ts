import { BaseAsyncPlugin } from "./manager";
import type { SearchResult, Link } from "../types/models";
import { ofetch } from "ofetch";
import { getLinkType } from "./panLink";

// 影盘社（melost）搜索插件
// 接口已实测可用（HTTP 200，返回夸克/阿里/百度等网盘直链）。
// 请求字段为 `q`（非 kw），详见 docs/pansou-reference.md。
const MELOST_API = "https://www.melost.cn/v1/search/disk";
const REFERER = "https://www.melost.cn/search";
const PAGE_SIZE = 30;
const MAX_PAGES = 3;

type MelostItem = {
  disk_id: string;
  disk_name: string;
  disk_pass: string;
  disk_type: string;
  files: string;
  share_user: string;
  shared_time: string;
  tags?: unknown;
  link: string;
};

type MelostResponse = {
  code: number;
  msg: string;
  data?: { list?: MelostItem[]; total?: number };
};

function convertDiskType(diskType: string, url: string): string {
  switch ((diskType || "").toUpperCase().trim()) {
    case "BDY":
    case "BAIDU":
      return "baidu";
    case "ALY":
    case "ALIYUN":
      return "aliyun";
    case "QUARK":
      return "quark";
    case "TIANYI":
      return "tianyi";
    case "UC":
      return "uc";
    case "CAIYUN":
    case "MOBILE":
      return "mobile";
    case "115":
      return "115";
    case "XUNLEI":
      return "xunlei";
    case "123":
    case "123PAN":
      return "123";
    case "PIKPAK":
      return "pikpak";
    case "LANZOU":
      return "lanzou";
    default:
      return getLinkType(url);
  }
}

function toISO(datetime?: string): string {
  if (!datetime) return "";
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(
    (datetime || "").trim()
  );
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}`);
    return Number.isFinite(d.getTime()) ? d.toISOString() : "";
  }
  const d = new Date(datetime);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

function processTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags.map((t) => String(t).trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function cleanText(v: string): string {
  return (v || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class MelostPlugin extends BaseAsyncPlugin {
  constructor() {
    super("melost", 3);
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

    const out: SearchResult[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = {
        page,
        q: kw,
        user: "",
        exact: false,
        user_distinct: false,
        format: [] as string[],
        share_time: "",
        share_year: "",
        size: PAGE_SIZE,
        order: "",
        type: "",
        search_ticket: "",
        exclude_user: [] as string[],
        adv_params: {
          wechat_pwd: "",
          search_code: "",
          platform: "pc",
          fp_data: "",
          automated: "0",
        },
      };

      const resp = await ofetch<MelostResponse>(MELOST_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.melost.cn",
          Referer: REFERER,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        },
        body,
        timeout,
      }).catch(() => undefined);

      const list = resp?.data?.list;
      if (!list || list.length === 0) break; // 无更多页

      for (const it of list) {
        const url = (it.link || "").trim();
        if (!url) continue;
        const type = convertDiskType(it.disk_type, url);
        const password = (it.disk_pass || "").trim();
        const tags = processTags(it.tags);
        const title = cleanText(it.disk_name) || kw;
        const contentParts = [
          cleanText(it.files) || "",
          it.share_user ? `分享用户: ${it.share_user}` : "",
          tags && tags.length ? `标签: ${tags.join("、")}` : "",
        ].filter(Boolean);
        const links: Link[] = [{ type, url, password }];
        out.push({
          message_id: "",
          unique_id: it.disk_id
            ? `melost-${it.disk_id}`
            : `melost-${Date.now()}-${out.length}`,
          channel: "",
          datetime: toISO(it.shared_time),
          title,
          content: contentParts.join("\n"),
          links,
          tags,
        });
      }
      if (list.length < PAGE_SIZE) break;
    }
    return out;
  }
}
