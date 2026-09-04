import { defineEventHandler, sendRedirect } from "h3";

/**
 * /s/** 已废弃独立搜索页：统一 301 到首页 /?q=xxx，复用首页搜索体验并把 SEO 权重回流到 /。
 *
 * 为何手写而不走 routeRules 字符串重定向：
 * - Nitro 运行时的通配符拼接（redirect: "/?q=/**"）经 joinURL 会产生 "/?q=/xxx"，
 *   搜索词带前导斜杠导致搜错词；
 * - "$1" 语法仅在 Vercel/Netlify 等平台预设转换时生效，node-server 本地运行时无效。
 *
 * 本 handler 精确控制 URL 编码与解码，server 端直接 301；
 * 客户端导航兜底由 pages/s/[term].vue 的 definePageMeta redirect 处理。
 */
export default defineEventHandler((event) => {
  const raw = String((event.context.params?.slug as string) || "");
  let term = raw;
  try {
    // 兼容已编码/未编码两种形式，避免双重编码
    term = decodeURIComponent(raw);
  } catch {}
  term = term.trim().slice(0, 50);
  if (!term) return sendRedirect(event, "/", 301);
  return sendRedirect(event, `/?q=${encodeURIComponent(term)}`, 301);
});
