/**
 * 页面端搜索配额（内存计数，2026-09-04 用户拍板：存内存即可，不落数据库）
 *
 * 业务规则：页面端已登录用户每点一次「搜索」/「继续」（= 一次 search.stream
 * 建流）计 1 次；免费额度 FREE_SEARCH_LIMIT 次用完后，第 4 次建流返回 402，
 * 前端弹出 floating-unlock 引导看激励视频广告；看完广告后端验票核销
 * （server/utils/unlockVerify.ts）成功即 resetQuota 清零重新计数。
 *
 * 豁免（不计数不拦截，见 search.stream.get.ts 配额段）：
 * - Bearer 请求（微信小程序端凭证走 Authorization 头，页面端限制不适用于它）
 * - 管理员（isAdminUser）
 *
 * 已知取舍（用户拍板接受）：内存 Map 在 CF Workers 上随 isolate 重建/漂移
 * 清零，多实例间计数不共享——定位是"引导看广告"而非硬性防刷，够用。
 *
 * 防膨胀：Map 按 openid 增长，超 MAX_ENTRIES 时先清过期（见 STALE_AFTER_MS），
 * 仍超则清空（极端情况宁可重置计数，也不能让 Map 无限涨爆内存）。
 */

/** 免费搜索次数：用完后需要看广告解锁（看完重置，再来 3 次） */
export const FREE_SEARCH_LIMIT = 3;

/** 记录多久没活跃后视为可回收（防 Map 膨胀的惰性过期） */
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Map 条目上限，超过触发过期清理，清完仍超则整体重置 */
const MAX_ENTRIES = 10_000;

interface QuotaEntry {
  used: number;
  /** 最近一次计数/重置时间（惰性过期用） */
  updatedAt: number;
}

const quotaMap = new Map<string, QuotaEntry>();

/** 测试用：清空全部计数 */
export function resetAllQuotas(): void {
  quotaMap.clear();
}

function evictStaleIfNeeded(now: number): void {
  if (quotaMap.size < MAX_ENTRIES) return;
  for (const [k, v] of quotaMap) {
    if (now - v.updatedAt > STALE_AFTER_MS) quotaMap.delete(k);
  }
  // 极端兜底：全活跃（如攻击）时整体重置，保内存不保计数
  if (quotaMap.size >= MAX_ENTRIES) quotaMap.clear();
}

/**
 * 消耗 1 次搜索配额，返回累计已用次数（1 起）。
 * 调用方判断 used > FREE_SEARCH_LIMIT 即超限返回 402。
 */
export function consumeQuota(openid: string): number {
  const now = Date.now();
  evictStaleIfNeeded(now);
  const entry = quotaMap.get(openid);
  const used = (entry?.used ?? 0) + 1;
  quotaMap.set(openid, { used, updatedAt: now });
  return used;
}

/** 广告验票通过后清零，重新开始计数 */
export function resetQuota(openid: string): void {
  quotaMap.delete(openid);
}

/** 查询当前累计次数（不清零），无记录返回 0 */
export function getQuotaUsed(openid: string): number {
  return quotaMap.get(openid)?.used ?? 0;
}
