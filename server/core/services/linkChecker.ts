/**
 * 链接有效性检测服务（服务端探活）
 *
 * 完全移植自 pansou (fish2018/pansou) 的 service/check_service.go +
 * check_mobile_crypto.go，不依赖油猴脚本的客户端逻辑（油猴靠浏览器扩展特权
 * GM_xmlhttpRequest 绕过跨域，判定逻辑也较粗糙；本实现为纯服务端 fetch）。
 *
 * 状态机（与 pansou 一致）：
 *   ok          链接有效
 *   bad         已失效 / 被删除 / 过期 / 违规
 *   locked      存活但需要提取码
 *   unsupported 平台不支持（磁力/ed2k/thunder 等无法服务端探活）
 *   uncertain   探活失败 / 无法判断
 *
 * 工程细节（对齐 pansou）：
 *   - normalizeShareLink：URL 归一化后作为缓存键（去 fragment、注入 pwd）
 *   - 分级 TTL：ok 24h / bad 6h / locked 12h / unsupported 24h / uncertain 30min
 *   - inflight 合并：同一缓存键并发只发一次请求
 *   - 并发池限制，避免集中出口打爆网盘 API
 *   - 每个探活 try/catch + 超时，绝不抛错 → 不影响主服务
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

// ========== 类型 ==========

export type LinkCheckStatus =
  | "ok"
  | "bad"
  | "locked"
  | "unsupported"
  | "uncertain";

export type Platform =
  | "aliyun"
  | "quark"
  | "uc"
  | "baidu"
  | "tianyi"
  | "123"
  | "xunlei"
  | "115"
  | "mobile"
  | "others";

export interface CheckItem {
  url: string;
  password?: string;
}

export interface LinkCheckResult {
  url: string;
  platform: Platform;
  status: LinkCheckStatus;
  reason?: string;
  cacheHit?: boolean;
  checkedAt: number;
}

interface CheckOutcome {
  status: LinkCheckStatus;
  reason?: string;
}

// ========== 常量 ==========

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 10000;
const CONCURRENCY = 3;

/** 分级 TTL（对齐 pansou ttlForState） */
function ttlFor(state: LinkCheckStatus): number {
  switch (state) {
    case "ok":
      return 24 * 60 * 60 * 1000;
    case "bad":
      return 6 * 60 * 60 * 1000;
    case "locked":
      return 12 * 60 * 60 * 1000;
    case "unsupported":
      return 24 * 60 * 60 * 1000;
    default:
      return 30 * 60 * 1000;
  }
}

// ========== 网络层 ==========

interface HttpResp {
  status: number;
  text: string;
}

/** 递归提取错误 cause 链（undici fetch 的真实错误在 cause 里） */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: any = err;
  const seen = new Set<object>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const msg =
      typeof cur.message === "string" && cur.message ? cur.message : String(cur);
    const code = typeof cur.code === "string" && cur.code ? ` [${cur.code}]` : "";
    parts.push(msg + code);
    cur = cur.cause ?? (Array.isArray(cur.errors) ? cur.errors[0] : undefined);
    if (parts.length >= 4) break;
  }
  return parts.join(" <- ");
}

async function httpRequest(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<HttpResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    // 网络层失败（DNS/TLS/连接/超时）：把错误 cause 链带出来便于诊断
    return { status: 0, text: errorChain(err) };
  } finally {
    clearTimeout(timer);
  }
}

function jsonBody(resp: HttpResp): any | null {
  if (resp.status === 0) return null;
  try {
    return JSON.parse(resp.text);
  } catch {
    return null;
  }
}

/** 诊断用：把失败响应压缩成一行摘要（HTTP 状态 + 响应片段） */
function respSummary(resp: HttpResp): string {
  if (resp.status === 0) return `请求失败: ${resp.text.slice(0, 120)}`;
  const head = resp.text.replace(/\s+/g, " ").slice(0, 80);
  if (resp.status < 200 || resp.status >= 400) {
    return `HTTP ${resp.status} ${head}`;
  }
  return `响应非 JSON (HTTP ${resp.status}) ${head}`;
}

function h(headers: Record<string, string>): Record<string, string> {
  return { "User-Agent": UA, ...headers };
}

// ========== 工具函数（移植 pansou containsAny / coalesce） ==========

function containsAny(content: string, keywords: string[]): boolean {
  const lower = content.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function coalesce(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return "";
}

// ========== URL 归一化 + share id 提取（移植 pansou extract*） ==========

/** 归一化：去 fragment、host 小写、按盘型注入 pwd（对齐 normalizeShareLink） */
export function normalizeShareLink(
  diskType: string,
  rawURL: string,
  password?: string
): string {
  let base = (rawURL || "").trim();
  if (!base) return "";
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return base;
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (password) {
    if (diskType === "baidu" || diskType === "quark" || diskType === "uc") {
      if (!parsed.searchParams.has("pwd")) {
        parsed.searchParams.set("pwd", password);
      }
    }
  }
  return parsed.toString();
}

export function extractAliyunShareID(rawURL: string): string {
  try {
    const p = new URL(rawURL);
    const parts = p.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "";
  } catch {
    return "";
  }
}

export function extractQuarkShareIDAndPassword(
  rawURL: string
): { id: string; password: string } {
  const m = rawURL.match(/\/s\/([A-Za-z0-9]+)/);
  if (!m) return { id: "", password: "" };
  let pwd = "";
  try {
    pwd = new URL(rawURL).searchParams.get("pwd") || "";
  } catch {
    /* ignore */
  }
  return { id: m[1], password: pwd };
}

export function extractBaiduShareInfo(
  rawURL: string
): { shareID: string; shortURL: string; password: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    return { shareID: "", shortURL: "", password: "" };
  }
  const pwd = parsed.searchParams.get("pwd") || "";
  let shareID = "";
  if (parsed.pathname.startsWith("/s/")) {
    shareID = parsed.pathname.slice("/s/".length);
  } else if (parsed.pathname.startsWith("/share/init")) {
    shareID = parsed.searchParams.get("surl") || "";
  }
  if (!shareID) return { shareID: "", shortURL: "", password: pwd };
  const shortURL = shareID.startsWith("1") && shareID.length > 1 ? shareID.slice(1) : shareID;
  return { shareID, shortURL, password: pwd };
}

export function extractTianyiShareInfo(
  rawURL: string,
  fallbackPassword?: string
): { shareCode: string; password: string; referer: string } {
  let shareCode = "";
  try {
    const parsed = new URL(rawURL);
    shareCode = parsed.searchParams.get("code") || "";
  } catch {
    /* fallthrough */
  }
  if (!shareCode) {
    // 用原始字符串正则提取，避免全角（访问码：xxx）被 URL 编码混入 pathname
    const m = rawURL.match(/cloud\.189\.cn\/t\/([^/?#（\s]+)/);
    if (m) shareCode = m[1];
  }
  if (!shareCode) {
    const fm = rawURL.match(/#\/t\/([^/?#（\s]+)/);
    if (fm) shareCode = fm[1];
  }
  // 兜底截断：去掉尾部残留的访问码段与多余路径
  shareCode = shareCode.split(/[（(]/)[0].split("/")[0];

  let password = fallbackPassword || "";
  const m2 = rawURL.match(/[（(]\s*访问码[：:]\s*([a-zA-Z0-9]+)\s*[）)]/);
  if (m2 && m2[1]) password = m2[1];

  return { shareCode, password, referer: rawURL };
}

export function extract123ShareKey(rawURL: string): string {
  const patterns = [
    /https?:\/\/(?:www\.)?(?:123684|123685|123912|123pan|123592|123865)\.com\/s\/([a-zA-Z0-9-]+)/,
    /https?:\/\/(?:www\.)?123pan\.cn\/s\/([a-zA-Z0-9-]+)/,
  ];
  for (const re of patterns) {
    const m = rawURL.match(re);
    if (m && m[1]) return m[1];
  }
  try {
    const p = new URL(rawURL);
    const parts = p.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "";
  } catch {
    return "";
  }
}

export function extractXunleiShareInfo(
  rawURL: string
): { id: string; password: string } {
  const m = rawURL.match(/pan\.xunlei\.com\/s\/([^?/#]+)/);
  if (!m) return { id: "", password: "" };
  let pwd = "";
  try {
    pwd = new URL(rawURL).searchParams.get("pwd") || "";
  } catch {
    /* ignore */
  }
  return { id: m[1], password: pwd };
}

export function extract115ShareInfo(
  rawURL: string,
  fallbackPassword?: string
): { shareCode: string; password: string } {
  try {
    const p = new URL(rawURL);
    const parts = p.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return { shareCode: "", password: fallbackPassword || "" };
    const shareCode = parts[parts.length - 1];
    let password = p.searchParams.get("password") || "";
    if (!password) password = fallbackPassword || "";
    if (!password && p.hash.includes("password=")) {
      const q = new URLSearchParams(p.hash.replace(/^#/, ""));
      password = q.get("password") || "";
    }
    return { shareCode, password };
  } catch {
    return { shareCode: "", password: fallbackPassword || "" };
  }
}

export function extractMobileShareID(rawURL: string): string {
  const patterns = [
    /https?:\/\/(?:www\.)?yun\.139\.com\/shareweb\/#\/w\/i\/([^&/?#]+)/,
    /https?:\/\/(?:www\.)?caiyun\.139\.com\/w\/i\/([^&/?#]+)/,
    /https?:\/\/(?:www\.)?caiyun\.139\.com\/m\/i\?([^&/?#]+)/,
    /https?:\/\/caiyun\.feixin\.10086\.cn\/([^&/?#]+)/,
  ];
  for (const re of patterns) {
    const m = rawURL.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}

// ========== 平台识别 ==========

const PLATFORM_MATCH: Array<[Platform, RegExp]> = [
  ["aliyun", /(?:alipan|aliyundrive)\.com/],
  ["quark", /pan\.quark\.cn/],
  ["uc", /drive\.uc\.cn/],
  ["baidu", /pan\.baidu\.com/],
  ["tianyi", /cloud\.189\.cn/],
  ["123", /(?:123pan|123865|123684|123912|123592|123pan\.cn)\.?/],
  ["xunlei", /pan\.xunlei\.com/],
  ["115", /(?:115|115cdn|anxia)\.com/],
  ["mobile", /(?:yun\.139\.com|caiyun\.139\.com|caiyun\.feixin\.10086\.cn)/],
];

export function detectPlatform(url: string): Platform {
  if (/^magnet:|^ed2k:|^thunder:/.test(url)) return "others";
  for (const [platform, re] of PLATFORM_MATCH) {
    if (re.test(url)) return platform;
  }
  return "others";
}

// ========== 各平台状态判定（纯函数，可单测） ==========

// ---- 阿里（code 细分 + share_status + file_count=0） ----
export function classifyAliyun(rsp: any, statusCode: number): CheckOutcome {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  const code = (rsp.code || "").toString().toLowerCase();
  if (code) {
    const message = coalesce(rsp.message, rsp.code);
    if (code.includes("sharelink")) return { status: "bad", reason: message };
    if (containsAny(code, ["notfound", "cancelled", "canceled", "forbidden", "expired"])) {
      return { status: "bad", reason: message };
    }
    if (containsAny(code, ["exceed", "frequency", "limit"])) {
      return { status: "uncertain", reason: message };
    }
    return { status: "uncertain", reason: message };
  }
  if (rsp.file_count === 0 && !rsp.share_name) {
    return { status: "bad", reason: "分享内容为空" };
  }
  const shareStatus = (rsp.share_status || "").toString().toLowerCase();
  if (shareStatus && shareStatus !== "enabled" && shareStatus !== "normal") {
    if (containsAny(shareStatus, ["forbidden", "cancel", "expired", "illegal", "invalid", "disabled"])) {
      return { status: "bad", reason: coalesce(rsp.message, "链接失效") };
    }
  }
  if (
    statusCode === 200 &&
    (rsp.share_name || rsp.share_title || (rsp.file_count && rsp.file_count > 0))
  ) {
    return { status: "ok", reason: "链接有效" };
  }
  if (statusCode !== 200) {
    return { status: "uncertain", reason: coalesce(rsp.message, `HTTP状态码: ${statusCode}`) };
  }
  return { status: "uncertain", reason: rsp.message || "无法确认链接状态" };
}

// ---- 夸克（token code 枚举 + detail 文件列表判空） ----
export function classifyQuarkToken(rsp: any): CheckOutcome & { stoken?: string } {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  const code = Number(rsp.code);
  const msg = rsp.message || "";
  switch (code) {
    case 0:
      break;
    case 41008:
      return { status: "locked", reason: "需要提取码" };
    case 41004:
    case 41010:
    case 41011:
      return { status: "bad", reason: "链接失效" };
    default:
      if (containsAny(msg, ["不存在", "失效", "违规", "过期", "取消"])) {
        return { status: "bad", reason: msg };
      }
      if (containsAny(msg, ["提取码", "密码"])) {
        return { status: "locked", reason: msg };
      }
      return { status: "uncertain", reason: msg };
  }
  const st = Number(rsp.status || 0);
  if (st !== 0 && st !== 200) {
    return { status: "bad", reason: coalesce(msg, "分享链接失效或不存在") };
  }
  const stoken = rsp.data?.stoken || "";
  if (!stoken) return { status: "uncertain", reason: "访问令牌缺失" };
  return { status: "ok", reason: "链接有效", stoken };
}

export function classifyQuarkDetail(rsp: any): CheckOutcome {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  const code = rsp.code ?? 0;
  if (code !== 0) {
    const message = coalesce(rsp.message, "无法确认链接状态");
    if (containsAny(message, ["提取码", "密码", "passcode"])) {
      return { status: "locked", reason: message };
    }
    if (containsAny(message, ["不存在", "失效", "违规", "过期", "取消"])) {
      return { status: "bad", reason: message };
    }
    return { status: "uncertain", reason: message };
  }
  const share = rsp.data?.share || {};
  const list = rsp.data?.list || [];
  if (list.length === 0) {
    if (share.status > 1 && share.partial_violation) {
      return { status: "bad", reason: `分享链接部分违规已失效(share_status=${share.status})` };
    }
    if (share.status > 1) {
      return { status: "bad", reason: `分享链接已失效(share_status=${share.status})` };
    }
    if (rsp.data?.is_expire) return { status: "bad", reason: "分享链接已过期" };
    return { status: "bad", reason: "分享链接无效：文件列表为空" };
  }
  if (share.status === 1 && share.partial_violation) {
    return { status: "ok", reason: "链接有效但部分文件违规" };
  }
  if (share.status === 1) return { status: "ok", reason: "链接有效" };
  if (share.status === 3 && share.partial_violation) {
    return { status: "bad", reason: "分享链接因违规已失效" };
  }
  if (share.status === 3) return { status: "ok", reason: "链接有效" };
  if (share.status > 1) {
    return { status: "bad", reason: `分享链接已失效(share_status=${share.status})` };
  }
  if (share.partial_violation) return { status: "ok", reason: "链接有效但部分文件违规" };
  return { status: "ok", reason: "链接有效" };
}

// ---- UC（页面关键词） ----
export function classifyUCPage(body: string, statusCode: number): CheckOutcome {
  if (statusCode === 404) return { status: "bad", reason: "链接失效" };
  const text = body.toLowerCase();
  if (containsAny(text, ["失效", "不存在", "违规", "删除", "已过期", "被取消"])) {
    return { status: "bad", reason: "链接失效" };
  }
  if (containsAny(text, ["提取码", "访问码", "请输入密码"])) {
    return { status: "locked", reason: "需要提取码" };
  }
  if (containsAny(text, ["文件", "分享", "drive.uc.cn"])) {
    return { status: "ok", reason: "链接有效" };
  }
  return { status: "uncertain", reason: "无法确认链接状态" };
}

// ---- 百度（verify + list，errno 枚举） ----
export function classifyBaiduVerify(rsp: any): CheckOutcome & { bdclnd?: string } {
  if (!rsp) return { status: "uncertain", reason: "验证失败" };
  switch (rsp.errno) {
    case 0:
      return { status: "ok", reason: "验证通过", bdclnd: rsp.randsk || "" };
    case -9:
    case -12:
      return { status: "locked", reason: "提取码错误或缺失" };
    default:
      return { status: "uncertain", reason: rsp.errmsg || "验证失败" };
  }
}

export function classifyBaiduList(rsp: any): CheckOutcome {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  switch (rsp.errno) {
    case 0:
      if (Array.isArray(rsp.list) && rsp.list.length > 0) {
        return { status: "ok", reason: "链接有效" };
      }
      return { status: "bad", reason: "链接失效" };
    case -9:
    case -12:
      return { status: "locked", reason: "需要提取码" };
    case -7:
    case 105:
    case 115:
    case 117:
    case 145:
      return { status: "bad", reason: "链接失效" };
    default:
      return { status: "uncertain", reason: rsp.errmsg || "无法确认链接状态" };
  }
}

// ---- 天翼（XML/JSON/错误码扫描） ----
const TIANYI_KNOWN_CODES = [
  "ShareInfoNotFound",
  "ShareNotFound",
  "FileNotFound",
  "ShareExpiredError",
  "ShareAuditNotPass",
  "FolderNotFound",
];

function mapTianyiError(code: string, fallback: string): string {
  switch ((code || "").trim()) {
    case "ShareInfoNotFound":
      return "分享信息不存在";
    case "ShareNotFound":
      return "分享链接不存在";
    case "FileNotFound":
      return "分享文件不存在";
    case "ShareExpiredError":
      return "分享链接已过期";
    case "ShareAuditNotPass":
      return "分享因审核未通过已失效";
    case "FolderNotFound":
      return "分享文件夹不存在";
    default:
      return coalesce(fallback, code);
  }
}

function scanTianyiKnownErrorCode(content: string): string {
  for (const code of TIANYI_KNOWN_CODES) {
    if (content.includes(code)) return code;
  }
  return "";
}

export function classifyTianyi(bodyText: string, statusCode: number): CheckOutcome {
  const text = bodyText.trim();
  // XML shareVO 分支
  if (text.startsWith("<shareVO") || text.includes("<shareVO>")) {
    const shareIdMatch = text.match(/<shareId>\s*(\d+)\s*<\/shareId>/);
    const hasFileName = /<fileName>\s*\S+/.test(text);
    if ((shareIdMatch && shareIdMatch[1] !== "0") || hasFileName) {
      return { status: "ok", reason: "链接有效" };
    }
    if (/<needAccessCode>\s*1\s*<\/needAccessCode>/.test(text)) {
      return { status: "ok", reason: "链接有效" };
    }
    return { status: "uncertain", reason: "无法确认链接状态" };
  }

  // 错误码扫描（XML error / JSON 通用）
  const known = scanTianyiKnownErrorCode(text);
  if (known) {
    return { status: "bad", reason: mapTianyiError(known, "") };
  }

  const lower = text.toLowerCase();
  if (containsAny(lower, ["erroraccesscode", "needaccesscode", "访问码", "提取码", "密码"])) {
    return { status: "locked", reason: "需要访问码" };
  }
  if (
    containsAny(lower, [
      "shareinfonotfound",
      "sharenotfound",
      "filenotfound",
      "shareexpirederror",
      "shareauditnotpass",
      "foldernotfound",
      "不存在",
      "失效",
      "取消",
      "过期",
    ])
  ) {
    return { status: "bad", reason: "链接失效" };
  }
  if (statusCode === 200 && text.length > 0) {
    return { status: "ok", reason: "链接有效" };
  }
  return { status: "uncertain", reason: "无法确认链接状态" };
}

// ---- 123（403 视为有效 + code/HasPwd） ----
export function classify123(rsp: any, statusCode: number): CheckOutcome {
  if (statusCode === 403) return { status: "ok", reason: "链接有效" };
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  if (rsp.code === 0 && rsp.data?.HasPwd) {
    return { status: "locked", reason: "需要提取码" };
  }
  if (rsp.code === 0) return { status: "ok", reason: "链接有效" };
  if (rsp.data?.HasPwd) return { status: "locked", reason: "需要提取码" };
  if (rsp.message) return { status: "bad", reason: rsp.message };
  return { status: "bad", reason: "链接失效" };
}

// ---- 迅雷（share_status 判定） ----
export function classifyXunlei(rsp: any): CheckOutcome {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  if (rsp.share_status === "OK") return { status: "ok", reason: "链接有效" };
  if (rsp.share_id || rsp.share_name || rsp.file_count > 0) {
    return { status: "ok", reason: "链接有效" };
  }
  if (
    containsAny(rsp.error || "", ["pass_code"]) ||
    containsAny(rsp.error_description || "", ["pass_code", "提取码", "密码"])
  ) {
    return { status: "locked", reason: coalesce(rsp.error_description, "需要提取码") };
  }
  if (rsp.share_status && rsp.share_status !== "OK") {
    const summary = coalesce(rsp.share_status_text, `分享状态: ${rsp.share_status}`);
    return { status: "bad", reason: summary };
  }
  if (rsp.error_code !== 0 || rsp.error || rsp.error_description) {
    if (containsAny(rsp.error_description || "", ["参数错误", "share_status", "不存在", "失效", "过期", "not found"])) {
      return { status: "bad", reason: coalesce(rsp.error_description, "链接失效") };
    }
    if (containsAny(rsp.error || "", ["参数错误", "share_status", "不存在", "失效", "过期", "not found"])) {
      return { status: "bad", reason: coalesce(rsp.error_description, rsp.error) };
    }
    return { status: "uncertain", reason: coalesce(rsp.error_description, rsp.error) };
  }
  return { status: "uncertain", reason: "无法确认链接状态" };
}

// ---- 115（share_state + forbid_reason） ----
export function classify115(rsp: any): CheckOutcome {
  if (!rsp) return { status: "uncertain", reason: "响应解析失败" };
  if (rsp.state && rsp.errno === 0) {
    const data = rsp.data || {};
    if (Array.isArray(data.list) && data.list.length > 0) {
      return { status: "ok", reason: "链接有效" };
    }
    if (data.count > 0) return { status: "ok", reason: "链接有效" };
    if (data.shareinfo?.snap_id || data.shareinfo?.share_title) {
      return { status: "ok", reason: "链接有效" };
    }
    let shareState = data.share_state;
    if (shareState === 0) shareState = data.shareinfo?.share_state;
    if (shareState === 1) return { status: "ok", reason: "链接有效" };
    // share_state=2 表示分享需要访问码/密码，直接判 locked（不依赖 forbid_reason
    // 关键词），避免 115 返回空 forbid_reason 时把"需密码"误判为"已失效"
    if (shareState === 2) {
      return { status: "locked", reason: data.shareinfo?.forbid_reason?.trim() || "需要访问码" };
    }
    const reason = (data.shareinfo?.forbid_reason || "").trim() || `链接状态异常(share_state=${shareState})`;
    if (containsAny(reason, ["密码", "提取码"])) {
      return { status: "locked", reason };
    }
    return { status: "bad", reason };
  }
  const err = rsp.error || "";
  if (containsAny(err, ["密码", "提取码", "receive_code"])) {
    return { status: "locked", reason: coalesce(err, "需要提取码") };
  }
  if (containsAny(err, ["参数错误", "不存在", "失效", "share_code", "forbid", "forbidden", "违规", "删除", "取消"])) {
    return { status: "bad", reason: coalesce(err, "链接失效") };
  }
  if (!err) return { status: "uncertain", reason: "无法确认链接状态" };
  return { status: "bad", reason: err };
}

// ---- 移动云盘（AES 解密后判定） ----
export function classifyMobile(decrypted: string): CheckOutcome {
  let rsp: any = null;
  try {
    rsp = JSON.parse(decrypted);
  } catch {
    return { status: "uncertain", reason: "响应解析失败" };
  }
  const resultCode = String(rsp.resultCode || "");
  const desc = rsp.desc || "";
  if (resultCode === "0" && rsp.data != null) {
    return { status: "ok", reason: "链接有效" };
  }
  if (containsAny(desc, ["提取码", "密码", "访问码"])) {
    return { status: "locked", reason: coalesce(desc, "需要提取码") };
  }
  if (desc) {
    if (containsAny(desc, ["失效", "不存在", "过期", "取消"])) {
      return { status: "bad", reason: desc };
    }
    return { status: "uncertain", reason: desc };
  }
  if (resultCode) return { status: "bad", reason: `错误码: ${resultCode}` };
  return { status: "uncertain", reason: "无法确认链接状态" };
}

// ========== 移动云盘 AES（移植 check_mobile_crypto.go） ==========

const MOBILE_KEY = Buffer.from("PVGDwmcvfs1uV3d1", "utf8");

export function encryptMobilePayload(payload: any): string {
  const iv = randomBytes(16);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const padLen = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv("aes-128-cbc", MOBILE_KEY, iv);
  cipher.setAutoPadding(false); // 已手动 PKCS7 padding，避免 final() 再补一轮
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

export function decryptMobilePayload(cipherText: string): string {
  const encrypted = Buffer.from(cipherText, "base64");
  if (encrypted.length < 16) throw new Error("响应长度异常");
  const iv = encrypted.subarray(0, 16);
  const body = encrypted.subarray(16);
  const decipher = createDecipheriv("aes-128-cbc", MOBILE_KEY, iv);
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(body), decipher.final()]);
  const padLen = plain[plain.length - 1];
  if (padLen <= 0 || padLen > plain.length) throw new Error("填充长度非法");
  plain = plain.subarray(0, plain.length - padLen);
  return plain.toString("utf8");
}

// ========== 迅雷 captcha 签名（移植 buildXunleiCaptchaSignature） ==========

const XUNLEI_SALT_PARTS = [
  "uWRwO7gPfdPB/0NfPtfQO+71",
  "F93x+qPluYy6jdgNpq+lwdH1ap6WOM+nfz8/V",
  "0HbpxvpXFsBK5CoTKam",
  "dQhzbhzFRcawnsZqRETT9AuPAJ+wTQso82mRv",
  "SAH98AmLZLRa6DB2u68sGhyiDh15guJpXhBzI",
  "unqfo7Z64Rie9RNHMOB",
  "7yxUdFADp3DOBvXdz0DPuKNVT35wqa5z0DEyEvf",
  "RBG",
  "ThTWPG5eC0UBqlbQ+04nZAptqGCdpv9o55A",
];

export function buildXunleiCaptchaSignature(
  clientID: string,
  clientVersion: string,
  packageName: string,
  deviceID: string
): { timestamp: string; signature: string } {
  const timestamp = String(Date.now());
  let content = `${clientID}${clientVersion}${packageName}${deviceID}${timestamp}`;
  for (const part of XUNLEI_SALT_PARTS) {
    content = createHash("md5").update(content + part).digest("hex");
  }
  return { timestamp, signature: "1." + content };
}

// ========== 各平台探活（真实网络，pansou 逻辑） ==========

async function checkAliyun(
  shareID: string
): Promise<CheckOutcome> {
  const resp = await httpRequest(
    `https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous?share_id=${encodeURIComponent(shareID)}`,
    {
      method: "POST",
      headers: h({
        "content-type": "application/json",
        origin: "https://www.alipan.com",
        referer: "https://www.alipan.com/",
        "x-canary": "client=web,app=share,version=v2.3.1",
      }),
      body: JSON.stringify({ share_id: shareID }),
    }
  );
  const rsp = jsonBody(resp);
  if (!rsp) return { status: "uncertain", reason: respSummary(resp) };
  return classifyAliyun(rsp, resp.status);
}

async function checkQuark(
  id: string,
  password: string
): Promise<CheckOutcome> {
  const tokenResp = await httpRequest(
    "https://drive-h.quark.cn/1/clouddrive/share/sharepage/token",
    {
      method: "POST",
      headers: h({
        "content-type": "application/json",
        origin: "https://pan.quark.cn",
        referer: "https://pan.quark.cn/",
      }),
      body: JSON.stringify({
        pwd_id: id,
        passcode: password,
        support_visit_limit_private_share: true,
      }),
    }
  );
  const tokenRsp = jsonBody(tokenResp);
  if (!tokenRsp) return { status: "uncertain", reason: respSummary(tokenResp) };
  const tokenOutcome = classifyQuarkToken(tokenRsp);
  if (tokenOutcome.status !== "ok") return tokenOutcome;
  const stoken = tokenOutcome.stoken || "";
  if (!stoken) return { status: "uncertain", reason: "访问令牌缺失" };

  const detailResp = await httpRequest(
    `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pwd_id=${encodeURIComponent(id)}&stoken=${encodeURIComponent(stoken)}&ver=2&pr=ucpro`,
    {
      headers: h({
        accept: "application/json, text/plain, */*",
        origin: "https://pan.quark.cn",
        referer: "https://pan.quark.cn/",
        "cache-control": "no-cache",
      }),
    }
  );
  const detailRsp = jsonBody(detailResp);
  if (!detailRsp) return { status: "uncertain", reason: respSummary(detailResp) };
  return classifyQuarkDetail(detailRsp);
}

async function checkUC(url: string): Promise<CheckOutcome> {
  const resp = await httpRequest(url, {
    headers: h({
      "user-agent":
        "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    }),
  });
  if (resp.status === 0) return { status: "uncertain", reason: respSummary(resp) };
  return classifyUCPage(resp.text, resp.status);
}

async function checkBaidu(
  shareID: string,
  shortURL: string,
  password: string,
  referer: string
): Promise<CheckOutcome> {
  let bdclnd = "";
  if (password) {
    const verifyURL = `https://pan.baidu.com/share/verify?surl=${encodeURIComponent(shortURL)}&pwd=${encodeURIComponent(password)}`;
    const verifyResp = await httpRequest(verifyURL, {
      method: "POST",
      headers: h({
        referer,
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: new URLSearchParams({ pwd: password, vcode: "", vcode_str: "" }).toString(),
    });
    const verifyOutcome = classifyBaiduVerify(jsonBody(verifyResp));
    if (verifyOutcome.status !== "ok") return verifyOutcome;
    bdclnd = verifyOutcome.bdclnd || "";
  }

  const listURL = `https://pan.baidu.com/share/list?web=1&page=1&num=20&order=time&desc=1&showempty=0&shorturl=${encodeURIComponent(shortURL)}&root=1&clienttype=0`;
  const headers: Record<string, string> = h({
    accept: "application/json, text/plain, */*",
    referer,
  });
  if (bdclnd) headers.cookie = `BDCLND=${bdclnd}`;
  const listResp = await httpRequest(listURL, { headers });
  const listRsp = jsonBody(listResp);
  if (!listRsp) return { status: "uncertain", reason: respSummary(listResp) };
  return classifyBaiduList(listRsp);
}

async function checkTianyi(
  shareCode: string,
  password: string,
  referer: string
): Promise<CheckOutcome> {
  const noCache = String(Math.random());
  const shareCodeParam = password
    ? `${shareCode}（访问码：${password}）`
    : shareCode;
  const url = `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?noCache=${noCache}&shareCode=${encodeURIComponent(shareCodeParam)}`;
  const resp = await httpRequest(url, {
    headers: h({ referer, "sign-type": "1" }),
  });
  if (resp.status === 0) return { status: "uncertain", reason: respSummary(resp) };
  return classifyTianyi(resp.text, resp.status);
}

async function check123(shareKey: string): Promise<CheckOutcome> {
  const resp = await httpRequest(
    `https://www.123pan.com/api/share/info?shareKey=${encodeURIComponent(shareKey)}`
  );
  const rsp = jsonBody(resp);
  if (!rsp) return { status: "uncertain", reason: respSummary(resp) };
  return classify123(rsp, resp.status);
}

async function checkXunlei(
  id: string,
  password: string
): Promise<CheckOutcome> {
  const deviceID = "5505bd0cab8c9469b98e5891d9fb3e0d";
  const clientID = "ZUBzD9J_XPXfn7f7";
  const clientVersion = "1.10.0.2633";
  const packageName = "com.xunlei.browser";
  const { timestamp, signature } = buildXunleiCaptchaSignature(
    clientID,
    clientVersion,
    packageName,
    deviceID
  );

  const tokenResp = await httpRequest(
    "https://xluser-ssl.xunlei.com/v1/shield/captcha/init",
    {
      method: "POST",
      headers: h({
        accept: "application/json;charset=UTF-8",
        "content-type": "application/json",
        "x-device-id": deviceID,
        "x-client-id": clientID,
        "x-client-version": clientVersion,
      }),
      body: JSON.stringify({
        action: "get:/drive/v1/share",
        captcha_token: "",
        client_id: clientID,
        device_id: deviceID,
        meta: {
          timestamp,
          captcha_sign: signature,
          client_version: clientVersion,
          package_name: packageName,
        },
        redirect_uri: "xlaccsdk01://xunlei.com/callback?state=harbor",
      }),
    }
  );
  const tokenRsp = jsonBody(tokenResp);
  const captchaToken = tokenRsp?.captcha_token;
  if (!captchaToken) return { status: "uncertain", reason: respSummary(tokenResp) };

  const apiURL = `https://api-pan.xunlei.com/drive/v1/share?share_id=${encodeURIComponent(id)}&pass_code=${encodeURIComponent(password)}&limit=100&pass_code_token=&page_token=&thumbnail_size=SIZE_SMALL`;
  const resp = await httpRequest(apiURL, {
    headers: h({
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://pan.xunlei.com",
      referer: "https://pan.xunlei.com/",
      "accept-encoding": "gzip, deflate",
      "x-client-id": clientID,
      "x-device-id": deviceID,
      "x-captcha-token": captchaToken,
    }),
  });
  if (resp.status === 0) return { status: "uncertain", reason: respSummary(resp) };
  if (resp.status === 404 || resp.status === 403) {
    return { status: "bad", reason: "链接失效" };
  }
  const rsp = jsonBody(resp);
  if (!rsp) return { status: "uncertain", reason: respSummary(resp) };
  return classifyXunlei(rsp);
}

async function check115(
  shareCode: string,
  password: string
): Promise<CheckOutcome> {
  if (!password) {
    return { status: "locked", reason: "115 需要提取码" };
  }
  const apiURL = `https://115cdn.com/webapi/share/snap?share_code=${encodeURIComponent(shareCode)}&offset=0&limit=20&receive_code=${encodeURIComponent(password)}&cid=`;
  const resp = await httpRequest(apiURL, {
    headers: h({
      priority: "u=1, i",
      referer: `https://115cdn.com/s/${shareCode}?password=${password}&`,
      "x-requested-with": "XMLHttpRequest",
      "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    }),
  });
  if (resp.status === 0) return { status: "uncertain", reason: respSummary(resp) };
  const rsp = jsonBody(resp);
  if (!rsp) return { status: "uncertain", reason: respSummary(resp) };
  return classify115(rsp);
}

async function checkMobile(
  shareID: string,
  password: string
): Promise<CheckOutcome> {
  const payload = {
    getOutLinkInfoReq: {
      account: "",
      linkID: shareID,
      passwd: password || "",
      caSrt: 1,
      coSrt: 1,
      srtDr: 0,
      bNum: 1,
      pCaID: "root",
      eNum: 200,
    },
    commonAccountInfo: { account: "", accountType: 1 },
  };
  let encrypted: string;
  try {
    encrypted = encryptMobilePayload(payload);
  } catch {
    return { status: "uncertain", reason: "请求加密失败" };
  }
  const resp = await httpRequest(
    "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6",
    {
      method: "POST",
      headers: h({
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "hcy-cool-flag": "1",
        "x-deviceinfo":
          "||3|12.27.0|chrome|131.0.0.0|5c7c68368f048245e1ce47f1c0f8f2d0||windows 10|1536X695|zh-CN|||",
      }),
      body: JSON.stringify({ data: encrypted }),
    }
  );
  if (resp.status === 0) return { status: "uncertain", reason: respSummary(resp) };
  let decrypted: string;
  try {
    decrypted = decryptMobilePayload(resp.text);
  } catch {
    return { status: "uncertain", reason: "响应解密失败" };
  }
  return classifyMobile(decrypted);
}

// ========== 主入口 ==========

const inflight = new Map<string, Promise<LinkCheckResult>>();
const cache = new Map<string, { result: LinkCheckResult; expiresAt: number }>();

// ========== 平台级熔断（防已断平台反复打满超时） ==========

const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const circuit = new Map<Platform, { failures: number; until: number }>();

/** 熔断是否开启（内部使用，导出供测试） */
export function isCircuitOpen(platform: Platform): boolean {
  const c = circuit.get(platform);
  if (!c) return false;
  // until=0 表示"计数中但未熔断"，不清除条目、不视为熔断
  if (c.until > 0) {
    if (Date.now() < c.until) return true;
    circuit.delete(platform); // 熔断到期自动半开
  }
  return false;
}

/** 记录一次网络失败（内部使用，导出供测试） */
export function recordCircuitFailure(platform: Platform): void {
  const c = circuit.get(platform) || { failures: 0, until: 0 };
  c.failures++;
  if (c.failures >= CIRCUIT_FAIL_THRESHOLD) {
    c.until = Date.now() + CIRCUIT_OPEN_MS;
    c.failures = 0;
  }
  circuit.set(platform, c);
}

/** 记录一次成功（内部使用，导出供测试） */
export function recordCircuitSuccess(platform: Platform): void {
  circuit.delete(platform);
}

async function doCheck(item: CheckItem): Promise<LinkCheckResult> {
  const platform = detectPlatform(item.url);
  const base: LinkCheckResult = {
    url: item.url,
    platform,
    status: "unsupported",
    checkedAt: Date.now(),
  };

  if (platform === "others") {
    return { ...base, reason: "unsupported link type" };
  }

  // 平台熔断中：直接返回 unknown，不发无意义的超时请求
  if (isCircuitOpen(platform)) {
    return { ...base, status: "uncertain", reason: "平台探活熔断中（5 分钟后自动重试）" };
  }

  try {
    let outcome: CheckOutcome;
    switch (platform) {
      case "aliyun": {
        const shareID = extractAliyunShareID(item.url);
        if (!shareID) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await checkAliyun(shareID);
        break;
      }
      case "quark": {
        const { id, password } = extractQuarkShareIDAndPassword(item.url);
        if (!id) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await checkQuark(id, password || item.password || "");
        break;
      }
      case "uc": {
        outcome = await checkUC(item.url);
        break;
      }
      case "baidu": {
        const { shareID, shortURL, password } = extractBaiduShareInfo(item.url);
        if (!shareID || !shortURL) {
          return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        }
        outcome = await checkBaidu(shareID, shortURL, password || item.password || "", item.url);
        break;
      }
      case "tianyi": {
        const { shareCode, password } = extractTianyiShareInfo(item.url, item.password);
        if (!shareCode) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await checkTianyi(shareCode, password, item.url);
        break;
      }
      case "123": {
        const shareKey = extract123ShareKey(item.url);
        if (!shareKey) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await check123(shareKey);
        break;
      }
      case "xunlei": {
        const { id, password } = extractXunleiShareInfo(item.url);
        if (!id) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await checkXunlei(id, password || item.password || "");
        break;
      }
      case "115": {
        const { shareCode, password } = extract115ShareInfo(item.url, item.password);
        if (!shareCode) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await check115(shareCode, password);
        break;
      }
      case "mobile": {
        const shareID = extractMobileShareID(item.url);
        if (!shareID) return { ...base, status: "uncertain", reason: "无法解析分享地址" };
        outcome = await checkMobile(shareID, item.password || "");
        break;
      }
      default:
        outcome = { status: "unsupported" };
    }
    // 网络层失败（respSummary 生成的"请求失败:..."）触发熔断计数；业务判定（locked/bad/ok）不算
    if (/^请求失败/.test(outcome.reason || "")) {
      recordCircuitFailure(platform);
    } else {
      recordCircuitSuccess(platform);
    }
    return { ...base, status: outcome.status, reason: outcome.reason };
  } catch (err) {
    recordCircuitFailure(platform);
    return {
      ...base,
      status: "uncertain",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 检查单个链接（缓存 + inflight 合并）。
 * 缓存键 = 归一化后的 URL（含密码注入），同一链接并发只发一次探活。
 */
export async function checkLink(item: CheckItem): Promise<LinkCheckResult> {
  const platform = detectPlatform(item.url);
  const normalized = normalizeShareLink(platform, item.url, item.password);
  const cacheKey = `${platform}:${normalized}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cacheHit: true };
  }
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const p = doCheck(item)
    .then((result) => {
      cache.set(cacheKey, { result, expiresAt: Date.now() + ttlFor(result.status) });
      inflight.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      inflight.delete(cacheKey);
      return {
        url: item.url,
        platform,
        status: "uncertain" as const,
        reason: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    });
  inflight.set(cacheKey, p);
  return p;
}

/** 简易并发池 */
function createPool(limit: number) {
  let active = 0;
  const queue: Array<{ fn: () => Promise<LinkCheckResult>; resolve: (v: LinkCheckResult) => void }> = [];
  function next() {
    if (queue.length === 0 || active >= limit) return;
    active++;
    const { fn, resolve } = queue.shift()!;
    fn().then(resolve).finally(() => {
      active--;
      next();
    });
  }
  return function run(fn: () => Promise<LinkCheckResult>): Promise<LinkCheckResult> {
    return new Promise((resolve) => {
      queue.push({ fn, resolve });
      next();
    });
  };
}

/** 批量检查链接（并发上限 CONCURRENCY，已缓存直接返回） */
export async function checkLinks(items: CheckItem[]): Promise<LinkCheckResult[]> {
  const pool = createPool(CONCURRENCY);
  const tasks = items.map((item) => pool(() => checkLink(item)));
  return Promise.all(tasks);
}

/** 仅测试用：清空缓存 */
export function _clearLinkCheckCache(): void {
  cache.clear();
  inflight.clear();
}

/** 仅测试用：重置熔断状态 */
export function _resetCircuits(): void {
  circuit.clear();
}

// ========== 缓存定期清理（防止长期运行内存增长） ==========

const CACHE_CLEAN_INTERVAL_MS = 60 * 60 * 1000;

function pruneExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

// unref：不让定时器阻止进程退出（vitest / CLI 场景）
const cacheTimer = setInterval(pruneExpiredCache, CACHE_CLEAN_INTERVAL_MS);
cacheTimer.unref?.();
