import type { GenericResponse, MergedLinks, SearchResponse } from "../types/models";

/**
 * 黑名单 IP 蜜罐假数据（2026-08-27 用户拍板）
 *
 * 背景：黑名单 IP（爬虫/聚合采集/持续探测）收到 403 后并不会停止请求，
 * 拒绝是"正确但无收益"——服务器照样扛拦截开销，爬虫照搜不误。
 *
 * 策略：命中黑名单的搜索请求不再 403 拒绝，而是返回一份**纯静态**的
 * 标准搜索结果数据（结构 100% 与正常响应一致），内容是公众号宣传。
 * - 无论搜什么关键词，返回的都是同一份假数据（纯静态，不带关键词）
 * - 不触发任何真实搜索（TG 抓取/插件请求零消耗）
 * - 聚合站/采集方抓到后把宣传内容当"资源"使用 = 让爬虫帮我们传播
 *
 * 格式约定：与 /api/search 正常响应完全一致
 *   GenericResponse<SearchResponse>，merged_by_type 按盘型分组。
 *   SSE 端点（/api/search.stream）则 push 一次 chunk（含 merged）+
 *   done（含 total），协议对齐正常流。
 */

/** 假数据宣传文案（纯静态，所有黑名单 IP 通用） */
const FAKE_NOTE =
  "资源已被保护，请关注公众号【神族九帝】 https://panhub.shenzjd.com/";

/** 假数据跳转目标：指向本站官网（页面带公众号二维码引导关注） */
const FAKE_URL = "https://panhub.shenzjd.com/";

/** 假数据 datetime：近几日固定值，让数据看起来正常 */
function fakeDatetime(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 3600 * 1000).toISOString();
}

/**
 * 构建蜜罐假数据的 merged_by_type 分组。
 * 纯静态：不分盘型按需返回，爬虫拿到的是"看起来正常"的多盘聚合。
 */
export function buildBlockedFakeMerged(): MergedLinks {
  return {
    baidu: [
      {
        url: FAKE_URL,
        password: "",
        note: FAKE_NOTE,
        datetime: fakeDatetime(1),
      },
    ],
    quark: [
      {
        url: FAKE_URL,
        password: "",
        note: FAKE_NOTE,
        datetime: fakeDatetime(2),
      },
    ],
    aliyun: [
      {
        url: FAKE_URL,
        password: "",
        note: FAKE_NOTE,
        datetime: fakeDatetime(3),
      },
    ],
    xunlei: [
      {
        url: FAKE_URL,
        password: "",
        note: FAKE_NOTE,
        datetime: fakeDatetime(4),
      },
    ],
  };
}

/** 构建蜜罐假 SearchResponse（total + merged_by_type） */
export function buildBlockedFakeResponse(): SearchResponse {
  const merged = buildBlockedFakeMerged();
  const total = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);
  return { total, merged_by_type: merged };
}

/** 构建蜜罐假 GenericResponse（/api/search GET/POST 用） */
export function buildBlockedFakeGenericResponse(): GenericResponse<SearchResponse> {
  return {
    code: 0,
    message: "success",
    data: buildBlockedFakeResponse(),
  };
}
