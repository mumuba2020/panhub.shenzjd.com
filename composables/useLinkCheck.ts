/**
 * 链接有效性检测（前端异步懒查）
 *
 * 搜索结果正常渲染后，单独调 POST /api/check 探活当前可见链接，
 * 结果回来再画角标 —— 不阻塞搜索返回。
 * 服务端已有分级 TTL 缓存 + inflight 合并，同一链接不会重复探活。
 */

export type LinkCheckStatus =
  | "ok"
  | "bad"
  | "locked"
  | "unsupported"
  | "uncertain";

export interface CheckStatus {
  url: string;
  status: LinkCheckStatus;
  reason?: string;
}

interface CheckResponse {
  code: number;
  message: string;
  data: { results: CheckStatus[] };
}

/** 单次探活请求的最大链接数（与后端一致） */
const MAX_LINKS_PER_REQUEST = 50;

let _instance: ReturnType<typeof createStore> | null = null;

/** 模块级单例（跨组件共享状态，避免重复请求） */
function createStore() {
  const statusMap = ref<Record<string, CheckStatus>>({});
  // 请求中的 url 集合，防止同批次重复入队
  const inFlight = new Set<string>();
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingQueue: Array<{ url: string; password?: string }> = [];

  function flush() {
    queueTimer = null;
    const batch = pendingQueue;
    pendingQueue = [];
    if (batch.length === 0) return;

    const items = batch.slice(0, MAX_LINKS_PER_REQUEST);
    // 标记在途（即使失败也不再重复入队，避免连环重试打爆接口）
    for (const it of items) inFlight.add(it.url);

    $fetch<CheckResponse>("/api/check", {
      method: "POST",
      body: { items },
    })
      .then((res) => {
        const results = res?.data?.results || [];
        if (results.length === 0) return;
        const next = { ...statusMap.value };
        for (const r of results) {
          next[r.url] = { url: r.url, status: r.status, reason: r.reason };
        }
        statusMap.value = next;
      })
      .catch(() => {
        // 静默失败：角标不显示，不影响搜索体验
      })
      .finally(() => {
        for (const it of items) inFlight.delete(it.url);
      });
  }

  function enqueue(links: Array<{ url: string; password?: string }>) {
    for (const l of links) {
      if (!l.url) continue;
      if (statusMap.value[l.url] || inFlight.has(l.url)) continue;
      pendingQueue.push(l);
    }
    if (pendingQueue.length > 0 && !queueTimer) {
      // 微批量合并：同一帧内的多次调用合并为一次请求
      queueTimer = setTimeout(flush, 50);
    }
  }

  function statusOf(url: string): CheckStatus | undefined {
    return statusMap.value[url];
  }

  return { statusMap, enqueue, statusOf };
}

export function useLinkCheck() {
  if (typeof window === "undefined") {
    // SSR 侧返回空实现，避免污染
    return {
      statusMap: ref<Record<string, CheckStatus>>({}),
      enqueue: () => {},
      statusOf: () => undefined,
    };
  }
  if (!_instance) _instance = createStore();
  return _instance;
}
