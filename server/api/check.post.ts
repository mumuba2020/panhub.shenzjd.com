import { defineEventHandler, readBody, sendError, createError } from "h3";
import { checkLinks } from "../core/services/linkChecker";
import type { CheckItem, LinkCheckResult } from "../core/services/linkChecker";

const MAX_LINKS = 50;
const MAX_URL_LENGTH = 500;

/**
 * 链接有效性检测（服务端探活，对齐 pansou check_service）
 * POST /api/check
 * body: { items: [{ url: string, password?: string }] }  推荐（带提取码）
 *   或  { links: string[] }                              兼容（无提取码）
 * -> { code: 0, message: "success", data: { results: LinkCheckResult[] } }
 */
export default defineEventHandler(async (event) => {
  let body: any = null;
  try {
    body = await readBody(event);
  } catch {
    // body 解析失败按空处理
  }

  let items: CheckItem[] = [];

  if (Array.isArray(body?.items)) {
    items = body.items
      .filter((x: any): x is CheckItem => x && typeof x.url === "string")
      .map((x: any) => ({
        url: x.url.trim(),
        password: typeof x.password === "string" ? x.password : undefined,
      }))
      .filter((x) => x.url.length > 0 && x.url.length <= MAX_URL_LENGTH)
      .slice(0, MAX_LINKS);
  } else if (Array.isArray(body?.links)) {
    items = body.links
      .filter((x: unknown): x is string => typeof x === "string")
      .map((s) => ({ url: s.trim() }))
      .filter((x) => x.url.length > 0 && x.url.length <= MAX_URL_LENGTH)
      .slice(0, MAX_LINKS);
  }

  if (items.length === 0) {
    return sendError(
      event,
      createError({
        statusCode: 400,
        statusMessage:
          "items array [{url, password?}] or links array (non-empty strings) required",
      })
    );
  }

  const results: LinkCheckResult[] = await checkLinks(items);

  return { code: 0, message: "success", data: { results } };
});
