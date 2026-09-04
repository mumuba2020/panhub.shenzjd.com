/**
 * PanHub 流量调度器（免费替代 Load Balancer）
 *
 * 职责：作为 panhub.shenzjd.com 的入口（边缘层），按 Docker 健康状态分流：
 * - Docker 健康 → 回源 Docker（43.128.70.75:80，保留 Host 头，与现状一致）
 * - Docker 异常 → 转发到现有完整应用 Worker（panhub-shenzjd-com，数据共享 D1，无缝接管）
 *
 * 健康状态由 Cron Trigger 每 1 分钟探测 Docker 的 /api/health 写入 KV：
 * - KV 无值（首次/冷启动）→ 乐观认为 Docker up（回源失败会 try/catch 兜底 fallback）
 * - KV 为 "down" → 直接走 fallback，避免无谓的失败回源
 */

// 回源目标：zone 内灰云（DNS-only）A 记录子域（本站命名为 <站名>1.shenzjd.com），
// 指向源站 IP。Workers 子请求禁止 fetch 裸 IP（error 1003）；也禁止 fetch 橙云域名。
// 灰云子域直连源站 IP:80，配合 Host 头让 OpenResty 按 server_name 分发。
const DOCKER_ORIGIN = "http://panhub1.shenzjd.com";
const DOCKER_HOST = "panhub.shenzjd.com";
const FALLBACK_WORKER = "https://panhub-shenzjd-com.shenzjd.workers.dev";
const HEALTH_KEY = "docker_health";
// TTL 必须大于 Cron 间隔（60s）：等于间隔会因调度抖动导致 KV 长期处于"刚过期"竞态
const HEALTH_TTL_SEC = 120;
const HEALTH_TIMEOUT_MS = 5000;

/** 构造子请求：基于原始请求复制 headers，并强制覆写 Host（避免回环） */
function buildUpstreamRequest(request, targetUrl, host) {
  const headers = new Headers(request.headers);
  if (host) headers.set("Host", host);
  headers.set("X-Forwarded-Proto", "https");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
  return new Request(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

export default {
  /** Cron 心跳：探测 Docker 健康并写 KV */
  async scheduled(_event, env) {
    console.log("[router] cron 触发");
    await checkDockerHealth(env);
  },

  /** 流量入口：按健康状态回源 Docker 或 fallback 到现有 Worker */
  async fetch(request, env) {
    // 1) 读健康状态（无值视为 up，由下方 try/catch 兜底）
    let dockerUp = true;
    try {
      const status = await env.ROUTER_STATE.get(HEALTH_KEY);
      dockerUp = status !== "down";
    } catch {
      // KV 异常时乐观回源
    }

    // 2) 回源 Docker（灰云子域直连源站，规避 Direct IP Access 拦截）
    if (dockerUp) {
      try {
        const target = new URL(request.url);
        target.protocol = "http:";
        target.hostname = new URL(DOCKER_ORIGIN).hostname;
        target.port = "80";
        // request.clone()：body 流只能消费一次，回源与 fallback 各持一份
        const upstream = await fetch(buildUpstreamRequest(request.clone(), target.toString(), DOCKER_HOST));
        console.log("[router] 回源响应:", upstream.status, "URL:", target.toString());
        // 4xx 视为 Docker 正常响应；5xx 视为异常（不立刻改 KV，交给 Cron 判定）
        if (upstream.status < 500) return upstream;
        console.log("[router] Docker 5xx", upstream.status);
      } catch (e) {
        console.log("[router] 回源 Docker 失败:", e && e.message ? e.message : String(e));
      }
    }

    // 3) fallback：Service Binding 直调备用 Worker
    //    （同 zone Worker 间用 fetch 会报 1042，Service Binding 是官方正解；
    //     必须 request.clone()，避免与回源共用已消费的 body）
    try {
      if (env.FALLBACK) {
        return await env.FALLBACK.fetch(request.clone());
      }
      console.log("[router] 未配置 FALLBACK service binding");
    } catch (e) {
      console.log("[router] fallback 失败:", e && e.message ? e.message : String(e));
    }
    return new Response("router unavailable", { status: 502 });
  },
};

/** 探测 Docker /api/health，结果写 KV */
async function checkDockerHealth(env) {
  let up = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const resp = await fetch(`${DOCKER_ORIGIN}/api/health`, {
      headers: { Host: DOCKER_HOST },
      signal: controller.signal,
    });
    clearTimeout(timer);
    up = resp.ok;
  } catch (e) {
    console.log("[router] cron 探测异常:", e && e.message ? e.message : String(e));
    up = false;
  }
  try {
    await env.ROUTER_STATE.put(HEALTH_KEY, up ? "up" : "down", {
      expirationTtl: HEALTH_TTL_SEC,
    });
  } catch (e) {
    console.log("[router] cron 写 KV 失败:", e && e.message ? e.message : String(e));
  }
}
