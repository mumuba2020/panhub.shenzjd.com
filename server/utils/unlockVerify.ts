import { loggers } from "../core/utils/logger";

/**
 * floating-unlock 广告解锁验票（2026-09-04）
 *
 * 前端 floating-unlock 组件在用户看完小程序激励视频广告后拿到
 * { ticket, grant }（grant 为 wx-auth 签名的一次性放行票据）。按组件
 * README 要求，放行权必须在业务后端：搜索放行前用 ticket + grant 调
 * wx-auth /api/auth/mp-reward/verify 验真并核销（grant 一次性，重复使用
 * 返回 already_consumed）。
 *
 * fail-closed：wx-auth 不可达/超时/非 2xx 一律视为验票失败——宁可让
 * 看完广告的用户重试，也不能无票放行（与 wxAuthCheck 同策略）。
 */

const WX_AUTH_API_BASE = process.env.WX_AUTH_API_BASE || "https://wx-auth.shenzjd.com";
const VERIFY_TIMEOUT_MS = 5000;

export interface UnlockTicket {
  ticket: string;
  grant: string;
}

/**
 * 验票并核销一次性 grant。返回 true 表示已验真且核销成功，可放行本次搜索。
 * 注意：核销成功后该 grant 不可复用，调用方验票通过应立即 resetQuota 放行。
 */
export async function verifyUnlockGrant(payload: UnlockTicket): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${WX_AUTH_API_BASE}/api/auth/mp-reward/verify`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ticket: payload.ticket, grant: payload.grant }),
    });
    if (!res.ok) {
      loggers.api.warn?.("mp-reward/verify 非 2xx，fail-closed 拒绝放行", {
        status: res.status,
      });
      return false;
    }
    const data = (await res.json()) as { ok?: boolean; valid?: boolean };
    return data.ok === true && data.valid === true;
  } catch (err) {
    loggers.api.warn?.("mp-reward/verify 请求失败，fail-closed 拒绝放行", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 从请求头提取解锁票据（前端 402 解锁后重试时附带），缺任一头返回 null */
export function getUnlockTicketFromHeaders(
  ticket: string | undefined,
  grant: string | undefined
): UnlockTicket | null {
  const t = ticket?.trim();
  const g = grant?.trim();
  if (!t || !g) return null;
  return { ticket: t, grant: g };
}
