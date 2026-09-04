import { defineEventHandler, sendRedirect } from "h3";

/**
 * 兜底：裸 /s 与 /s/ 无搜索词，直接 301 到首页。
 * （/s/xxx 由 s/[...slug].ts 处理；此处仅覆盖 catch-all 无法匹配的空路径）
 */
export default defineEventHandler((event) => sendRedirect(event, "/", 301));
