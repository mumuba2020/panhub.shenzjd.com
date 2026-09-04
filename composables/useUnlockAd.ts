/**
 * floating-unlock 广告解锁 composable（2026-09-04）
 *
 * 业务链路（配合 searchQuotaService / unlockVerify）：
 * 1. 页面端登录用户免费搜 FREE_SEARCH_LIMIT 次（服务端 search.stream 内存计数）
 * 2. 超限后 search.stream 返回 402，useSearch 回调 onQuotaExceeded → 本模块
 * 3. requireUnlockAd() 调 <floating-unlock> WC 的 unlock()：弹窗展示小程序码，
 *    用户扫码看完激励视频广告后 resolve { ticket, grant }
 * 4. useSearch 自动重试搜索并带上 X-Unlock-Ticket / X-Unlock-Grant 头，
 *    服务端调 wx-auth mp-reward/verify 验票核销（grant 一次性）后清零放行
 *
 * 组件加载方式：layouts/default.vue 以 UMD 脚本引入 floating-unlock.wc.js，
 * 并在模板放置 <floating-unlock> 标签（本模块 querySelector 查找）。
 * 组件"不自动弹出"，unlock() 由业务方触发；弹窗强制不可关，看完才能继续。
 */

/** unlock() 成功返回的一次性票据（grant 交给后端验票核销） */
export interface UnlockTicket {
  ticket: string;
  grant: string;
}

/** floating-unlock Web Component 暴露的实例方法（对齐官方 dist/index.d.ts） */
interface FloatingUnlockElement extends HTMLElement {
  unlock(): Promise<{ ok: boolean; ticket: string | null; grant: string | null }>;
  close(): void;
}

const WC_TAG = "floating-unlock";

let resolveElPromise: Promise<FloatingUnlockElement> | null = null;

/**
 * 等待布局里的 <floating-unlock> 元素就绪（UMD 脚本注册 WC + ClientOnly 挂载）。
 * 轮询直到 querySelector 命中且 unlock 方法可用；超时 reject（调用方降级）。
 */
export function resolveFloatingUnlock(timeoutMs = 10000): Promise<FloatingUnlockElement> {
  if (resolveElPromise) return resolveElPromise;
  resolveElPromise = new Promise<FloatingUnlockElement>((resolve, reject) => {
    if (typeof window === "undefined") {
      resolveElPromise = null;
      return reject(new Error("floating-unlock 仅客户端可用"));
    }
    const startedAt = Date.now();
    const poll = () => {
      const el = document.querySelector(WC_TAG) as FloatingUnlockElement | null;
      if (el && typeof el.unlock === "function") return resolve(el);
      if (Date.now() - startedAt >= timeoutMs) {
        resolveElPromise = null; // 允许下次调用重试
        return reject(new Error("floating-unlock 元素加载超时"));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
  return resolveElPromise;
}

/**
 * 弹出广告解锁弹窗，等待用户看完激励视频广告。
 * - 成功：返回 { ticket, grant }（调用方把票据带给后端验票放行）
 * - 失败/过期/取消/组件不可用：返回 null（调用方终止本次搜索并提示）
 */
export async function requireUnlockAd(): Promise<UnlockTicket | null> {
  try {
    const el = await resolveFloatingUnlock();
    const result = await el.unlock();
    if (result?.ok && result.ticket && result.grant) {
      return { ticket: result.ticket, grant: result.grant };
    }
    return null;
  } catch (e) {
    console.error("[floating-unlock] 解锁弹窗不可用", e);
    return null;
  }
}
