// 集中网盘链接识别（移植自 pansou util/regex_util.go 的 AllPanLinksPattern / GetLinkType）
// 统一识别夸克/阿里/百度/UC/天翼/115/迅雷/123/移动等网盘与磁力链接，
// 供各插件复用，避免每个插件各自维护一份类型映射导致遗漏或写错。
import type { Link } from "../types/models";

// 域名 → 类型（顺序无关，第一个命中为准）
const PAN_URL_PATTERNS: Array<[RegExp, string]> = [
  [/pan\.quark\.cn/i, "quark"],
  [/drive\.uc\.cn/i, "uc"],
  [/pan\.baidu\.com/i, "baidu"],
  [/aliyundrive\.com|alipan\.com/i, "aliyun"],
  [/pan\.xunlei\.com/i, "xunlei"],
  [/cloud\.189\.cn/i, "tianyi"],
  [/115\.com/i, "115"],
  [/123pan\.com/i, "123"],
  [/yun\.139\.com|feixin\.10086\.cn|caiyun/i, "mobile"],
  [/share\.weiyun\.com/i, "weiyun"],
  [/lanzou|lanzo/i, "lanzou"],
  [/jianguoyun\.com/i, "jianguoyun"],
  [/mypikpak\.com/i, "pikpak"],
];

/**
 * 根据 URL 判断网盘类型。
 * 支持 magnet / ed2k / thunder 协议，以及常见网盘域名；
 * 无法识别时返回 "others"。
 */
export function getLinkType(url: string): string {
  const u = (url || "").toLowerCase();
  if (u.startsWith("magnet:")) return "magnet";
  if (u.startsWith("ed2k://")) return "ed2k";
  if (u.startsWith("thunder://")) return "thunder";
  for (const [re, type] of PAN_URL_PATTERNS) {
    if (re.test(u)) return type;
  }
  return "others";
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const MAGNET_RE = /magnet:\?xt=urn:btih:[^\s"'<>)\]]+/gi;

/**
 * 从一段文本中提取所有网盘链接与磁力链接。
 * 会先把 JSON 转义的反斜杠还原（应对 `https:\/\/pan.quark.cn\/s\/xxx` 这种返回）。
 * 非网盘/非磁力的普通 URL 会被过滤掉。
 */
export function extractLinksFromText(text: string): Link[] {
  const raw = text || "";
  // 还原 JSON 转义：`https:\/\/x` -> `https://x`
  const normalized = raw.replace(/\\\/+/g, "/");
  const found = new Map<string, Link>();

  const collect = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      const url = m[0];
      const type = getLinkType(url);
      const isPan =
        type !== "others" ||
        url.startsWith("magnet:") ||
        url.startsWith("ed2k://");
      if (!isPan) continue; // 跳过普通网页链接
      if (!found.has(url)) found.set(url, { type, url, password: "" });
    }
  };

  collect(URL_RE);
  collect(MAGNET_RE);
  return Array.from(found.values());
}

/**
 * 把 HTML 片段转成纯文本（去标签 + 还原常见 HTML 实体）。
 * 供各 HTML 解析类插件（quark4k 等）复用，避免每个插件各写一份。
 */
export function cleanHTML(html?: string): string {
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
