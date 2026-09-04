/**
 * 将 query 参数解析为去空、去首尾空格的非空字符串数组。
 *
 * 兼容 h3 `getQuery` 的两种输入形态：
 *  - 逗号分隔的字符串：`a=quark,pan123`         -> ["quark","pan123"]
 *  - 重复同名参数（数组）：`a=quark&a=pan123`    -> ["quark","pan123"]
 * 两者也可能混合（如 `a=quark,pan123&a=pan115`），统一按元素再 split 一次。
 */
export function parseList(val: string | string[] | undefined): string[] | undefined {
  if (!val) return undefined;
  const raw = Array.isArray(val) ? val : [val];
  const parts = raw
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}
