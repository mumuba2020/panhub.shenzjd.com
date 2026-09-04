/**
 * 热搜存储共享工具函数
 * 供 TursoHotSearchStore 使用，保证词条规范化、北京时间日期语义一致。
 *
 * 2026-08-22 用户拍板：**不限制用户搜索什么**——敏感词过滤 isForbidden
 * 已移除（此前拦截 政治/色情/赌博/毒品 等词），词条规范化不再拒绝 URL
 * 或限制长度。用户搜什么，词库就记录什么。
 */

/**
 * 词条规范化（2026-08-22 用户拍板：不限制用户搜索什么）：
 * - 去首尾空白，空串丢弃
 * - 不再拒绝 URL、不再限制长度（此前会丢弃 https:// 开头词与 >20 字词）
 * - 全角字符转半角（Ａ-Ｚ → A-Z 等）
 */
export function normalize(term: string): string | null {
  let t = term.trim();
  if (!t) return null;
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
  return t || null;
}

/**
 * 固定北京时间（UTC+8）日期键 YYYY-MM-DD
 * 不依赖宿主时区（Docker/CF 为 UTC 也能对齐用户感知的"今日"）
 */
export function formatDateKey(ts: number): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 北京时间 0 点对应的 epoch ms（入参 YYYY-MM-DD） */
export function beijingDayStart(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
}
