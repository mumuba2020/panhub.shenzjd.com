import { describe, expect, it, vi, beforeAll } from "vitest";
import { createApp, toNodeListener, eventHandler, type H3Event } from "h3";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * SSE 蜜罐分支回归测试（2026-08-27 线上事故）
 *
 * 事故：黑名单 IP 打 /api/search.stream 一直 pending（TLS 握手后 0 字节）。
 * 根因：h3 的 createEventStream 是惰性的，push() 必须在 send() 之后才会
 * 真正写入流；蜜罐分支在 send() 前 await push() → promise 永不 resolve →
 * handler 卡死 → CF 等源站直到超时。
 *
 * 修复：蜜罐分支改为与正常分支同构——后台任务里 push，主 handler 立即
 * return send()。
 *
 * 本测试直接装配真实的 search.stream.get.ts handler，mock 黑名单命中，
 * 验证：收到 SSE chunk + done 事件、连接正常关闭、整体在超时内完成。
 */

// mock 黑名单命中（蜜罐分支入口）
vi.mock("../../server/core/services/botDefense", () => ({
  getOrCreateBotDefenseService: () => ({
    isBlocked: vi.fn(async () => true),
  }),
}));

// mock 鉴权：requireHumanOrCredential / requireWxAuth
// 在测试环境直接放行（真实 handler 内部 useRuntimeConfig 依赖 Nitro 运行时）
vi.mock("../../server/utils/requireAuth", () => ({
  requireHumanOrCredential: () => {},
  requireWxAuth: async () => {},
}));

import searchStreamHandler from "../../server/api/search.stream.get";
import { buildBlockedFakeMerged } from "../../server/core/utils/blockedFakeData";

// 关键：必须 mock 后再 import，且确保 getOrCreateBotDefenseService 已被替换。
// 为绕过 useRuntimeConfig 对 handler 其他分支的影响，直接在这里构建 app。

let server: ReturnType<typeof createServer>;
let baseUrl = "";

beforeAll(async () => {
  const app = createApp();
  // search.stream.get.ts 导出的是 defineEventHandler 包装的 handler
  app.use("/api/search.stream", searchStreamHandler);
  server = createServer(toNodeListener(app));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

describe("SSE 蜜罐分支（黑名单 IP 命中）", () => {
  it("黑名单 IP 打 SSE 端点：收到 chunk + done 事件且连接正常关闭（修复前卡死）", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await fetch(`${baseUrl}/api/search.stream?kw=test`, {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/151",
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });

      expect(resp.ok).toBe(true);
      expect(resp.headers.get("content-type") || "").toContain("text/event-stream");

      // 读取 SSE 流，直到 done 事件或超时
      const text = await resp.text();
      expect(text).toContain("event: chunk");
      expect(text).toContain("event: done");
      expect(text).toContain("神族九帝");
    } finally {
      clearTimeout(timeout);
    }
  }, 10000);

  it("蜜罐数据内容为纯静态公众号宣传（与正常响应同结构）", () => {
    const merged = buildBlockedFakeMerged();
    const total = Object.values(merged).reduce((s, a) => s + a.length, 0);
    expect(total).toBeGreaterThan(0);
    for (const items of Object.values(merged)) {
      for (const item of items) {
        expect(item.note).toContain("神族九帝");
        expect(item.url).toContain("panhub.shenzjd.com");
      }
    }
  });
});
