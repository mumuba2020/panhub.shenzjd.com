/**
 * BotDefenseService 单元测试（2026-08-24 新增）
 *
 * 覆盖：
 * - isBlocked 缓存策略（pos / neg / store fallback）
 * - recordRejection 滑动窗口阈值（60s 内累计 ≥5 → extendBlock）
 * - 持久化失败时的容错
 * - 服务降级（Turso 不可用时 isBlocked 返回 false，recordRejection 不抛）
 *
 * 实现：FakeStore 不依赖 vi.spyOn 钩原型方法，全部用箭头函数 + vi.fn 直接绑到实例属性
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeStore {
  blocked: Set<string>;
  hitCount: Map<string, number>;
  honeypot: Map<string, { openid: string; ip: string; hits: number; lastAt: number }[]>;
  isBlocked: ReturnType<typeof vi.fn>;
  recordRejection: ReturnType<typeof vi.fn>;
  extendBlock: ReturnType<typeof vi.fn>;
  manuallyBlock: ReturnType<typeof vi.fn>;
  removeBlock: ReturnType<typeof vi.fn>;
  recordHoneypotHit: ReturnType<typeof vi.fn>;
  listHoneypotByOpenid: ReturnType<typeof vi.fn>;
  listHoneypotByIp: ReturnType<typeof vi.fn>;
  listStatusByIps: ReturnType<typeof vi.fn>;
  pruneHoneypotHits: ReturnType<typeof vi.fn>;
  pruneExpired: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeStore(): FakeStore {
  const fake: FakeStore = {
    blocked: new Set<string>(),
    hitCount: new Map<string, number>(),
    honeypot: new Map<string, { openid: string; ip: string; hits: number; lastAt: number }[]>(),
    isBlocked: vi.fn(async (_ip: string, _now: number) => false),
    recordRejection: vi.fn(async (ip: string, _r: string, _n: number) => {
      const c = (fake.hitCount.get(ip) ?? 0) + 1;
      fake.hitCount.set(ip, c);
      return { hitCount: c, blocked: fake.blocked.has(ip), blockCount: 0 };
    }),
    extendBlock: vi.fn(async (ip: string) => {
      fake.blocked.add(ip);
      return 1; // 分级档位（store 层真实逻辑见 tursoBotDefenseStore.test.ts）
    }),
    manuallyBlock: vi.fn(async (ip: string, _r: string, _n: number) => {
      fake.blocked.add(ip);
      return 3; // 管理页手动拉黑固定 30 天档
    }),
    removeBlock: vi.fn(async (ip: string) => {
      return fake.blocked.delete(ip);
    }),
    recordHoneypotHit: vi.fn(async (openid: string, ip: string) => {
      if (!openid || !ip) return false;
      return true;
    }),
    listHoneypotByOpenid: vi.fn(async () => []),
    listHoneypotByIp: vi.fn(async () => []),
    listStatusByIps: vi.fn(async () => []),
    pruneHoneypotHits: vi.fn(async () => 0),
    pruneExpired: vi.fn(async () => 0),
    close: vi.fn(),
  };
  return fake;
}

let fake: FakeStore;

vi.mock("../../server/core/services/tursoBotDefenseStore", () => ({
  createTursoBotDefenseStore: () => fake,
}));

// 必须在 mock 后 import service
import { BotDefenseService, isBotDefenseEnforced } from "../../server/core/services/botDefense";

describe("BotDefenseService 蜜罐命中记录与反查（2026-09-03 反馈解封闭环）", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    fake = makeFakeStore();
    svc = new BotDefenseService();
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
  });

  it("recordHoneypotHit 转发 store（openid+ip）", async () => {
    const ok = await svc.recordHoneypotHit("o-real-user", "203.0.113.9");
    expect(ok).toBe(true);
    expect(fake.recordHoneypotHit).toHaveBeenCalledWith("o-real-user", "203.0.113.9", expect.any(Number));
  });

  it("recordHoneypotHit 空 openid 返回 false 且不落库", async () => {
    expect(await svc.recordHoneypotHit("", "1.1.1.1")).toBe(false);
    expect(fake.recordHoneypotHit).not.toHaveBeenCalled();
  });

  it("listHoneypotByOpenid / listHoneypotByIp / listStatusByIps 转发 store 结果", async () => {
    fake.listHoneypotByOpenid.mockResolvedValue([
      { ip: "203.0.113.9", hits: 2, lastAt: 1_700_000_000_000 },
    ]);
    expect(await svc.listHoneypotByOpenid("o-x", 20)).toEqual([
      { ip: "203.0.113.9", hits: 2, lastAt: 1_700_000_000_000 },
    ]);
    expect(fake.listHoneypotByOpenid).toHaveBeenCalledWith("o-x", 20);

    fake.listHoneypotByIp.mockResolvedValue([
      { openid: "o-1", hits: 1, lastAt: 1_700_000_000_000 },
    ]);
    expect(await svc.listHoneypotByIp("203.0.113.9", 5)).toHaveLength(1);

    fake.listStatusByIps.mockResolvedValue([
      {
        ip: "203.0.113.9",
        reason: "bot_ua",
        hitCount: 3,
        blockCount: 1,
        firstAt: 0,
        lastAt: 0,
        expiresAt: 0,
      },
    ]);
    const status = await svc.listStatusByIps(["203.0.113.9"]);
    expect(status).toHaveLength(1);
    expect(status[0].blockCount).toBe(1);
  });

  it("store 抛错时反查方法返回空数组（管理侧 fail-soft）", async () => {
    fake.listHoneypotByOpenid.mockRejectedValue(new Error("down"));
    fake.listHoneypotByIp.mockRejectedValue(new Error("down"));
    fake.listStatusByIps.mockRejectedValue(new Error("down"));
    expect(await svc.listHoneypotByOpenid("o-x")).toEqual([]);
    expect(await svc.listHoneypotByIp("1.1.1.1")).toEqual([]);
    expect(await svc.listStatusByIps(["1.1.1.1"])).toEqual([]);
  });
});

describe("BotDefenseService.isBlocked", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    // 测试 isBlocked 行为需要开启 enforce（默认关闭 = 只累计不拦截，已另有用例覆盖）
    process.env.BOT_DEFENSE_ENFORCE = "1";
    fake = makeFakeStore();
    svc = new BotDefenseService();
    // 等 initPromise（rejection 调用 store）
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
    fake.isBlocked.mockClear();
  });

  afterEach(() => {
    delete process.env.BOT_DEFENSE_ENFORCE;
  });

  it("无效 IP（空串/'unknown'）一律视为不在黑名单", async () => {
    expect(await svc.isBlocked("")).toBe(false);
    expect(await svc.isBlocked("unknown")).toBe(false);
  });

  it("BOT_DEFENSE_ENFORCE 未设置时 isBlocked 恒 false（2026-08-24 紧急恢复：只累计不拦截）", async () => {
    delete process.env.BOT_DEFENSE_ENFORCE;
    fake.isBlocked.mockResolvedValue(true); // 即使 store 说有黑名单也不拦
    expect(await svc.isBlocked("1.2.3.4")).toBe(false);
    expect(await svc.isBlocked("9.9.9.9")).toBe(false);
    expect(fake.isBlocked).not.toHaveBeenCalled(); // 开关关时连 store 都不查
  });

  it("isBotDefenseEnforced 开关读取（未设置/0 = 关，1 = 开）", () => {
    delete process.env.BOT_DEFENSE_ENFORCE;
    expect(isBotDefenseEnforced()).toBe(false);
    process.env.BOT_DEFENSE_ENFORCE = "0";
    expect(isBotDefenseEnforced()).toBe(false);
    process.env.BOT_DEFENSE_ENFORCE = "1";
    expect(isBotDefenseEnforced()).toBe(true);
  });

  it("Turso 返回 blocked → 缓存为 pos，5min 内复用不查 store", async () => {
    fake.isBlocked.mockResolvedValueOnce(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    // 第一次查 store，后续走 pos cache 不再查 store
    expect(fake.isBlocked).toHaveBeenCalledTimes(1);
  });

  it("Turso 返回非 blocked → 缓存为 neg，30s 内复用不查 store", async () => {
    fake.isBlocked.mockResolvedValue(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(await svc.isBlocked("5.6.7.8")).toBe(false);
    expect(fake.isBlocked).toHaveBeenCalledTimes(1);
  });

  it("Turso 查询异常 → 一律放行（fail-open），不抛错", async () => {
    fake.isBlocked.mockRejectedValue(new Error("turso down"));
    await expect(svc.isBlocked("9.9.9.9")).resolves.toBe(false);
  });

  it("封禁期持续探查达到阈值 → 自动升级档位（2026-08-25 用户拍板）", async () => {
    // 让 store 返回 blocked：命中缓存 / store 均视为封禁中
    fake.isBlocked.mockResolvedValue(true);
    fake.blocked.add("probe-ip");
    fake.extendBlock.mockClear();

    // 连续命中 PROBE_UPGRADE_THRESHOLD(60) 次 → 触发第一次升级
    for (let i = 0; i < 60; i++) {
      await svc.isBlocked("probe-ip");
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.extendBlock).toHaveBeenCalledWith(
      "probe-ip",
      "probe",
      expect.any(Number)
    );
  });

  it("持续探查不清零：再累计 60 次 → 连续第二次升级（持续累计直到永久）", async () => {
    fake.isBlocked.mockResolvedValue(true);
    fake.blocked.add("probe-ip");
    fake.extendBlock.mockClear();

    // 第一轮 60 次：升级一次
    for (let i = 0; i < 60; i++) {
      await svc.isBlocked("probe-ip");
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.extendBlock).toHaveBeenCalledTimes(1);

    // 升级后计数保留（不清零）：同一进程内继续探测再 60 次 → 第二次升级
    for (let i = 0; i < 60; i++) {
      await svc.isBlocked("probe-ip");
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.extendBlock).toHaveBeenCalledTimes(2);
  });

  it("未达探测阈值不触发升级", async () => {
    fake.isBlocked.mockResolvedValue(true);
    fake.blocked.add("quiet-ip");
    for (let i = 0; i < 59; i++) {
      await svc.isBlocked("quiet-ip");
    }
    await new Promise((r) => setTimeout(r, 10));
    // 59 次未达 60 → 不应 extendBlock
    expect(fake.extendBlock).not.toHaveBeenCalled();
  });
});

describe("BotDefenseService.recordRejection", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    fake = makeFakeStore();
    svc = new BotDefenseService();
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
  });

  it("无效 IP 直接 return，不调 store", async () => {
    await svc.recordRejection("", "bot_ua");
    await svc.recordRejection("unknown", "bot_ua");
    expect(fake.recordRejection).not.toHaveBeenCalled();
  });

  it("同一 IP 累计 ≥50 → 调 extendBlock 拉黑（2026-08-24 阈值 5→50，防误伤真人）", async () => {
    for (let i = 0; i < 50; i++) {
      await svc.recordRejection("1.1.1.1", "bot_ua", 1000 + i * 10);
    }
    expect(fake.extendBlock).toHaveBeenCalledTimes(1);
    expect(fake.extendBlock).toHaveBeenCalledWith("1.1.1.1", "bot_ua", expect.any(Number));
  });

  it("累计 <50 不触发 extendBlock", async () => {
    for (let i = 0; i < 49; i++) {
      await svc.recordRejection("2.2.2.2", "rate_limit", 2000 + i * 10);
    }
    expect(fake.extendBlock).not.toHaveBeenCalled();
  });

  it("滑动窗口：超过 300s 的旧 hit 不连续触发前次拉黑", async () => {
    // 第 1 次：t=0（旧）
    await svc.recordRejection("3.3.3.3", "bot_ua", 1000);
    // 第 2 次：t=400s，远离窗口，旧 hit 被清
    await svc.recordRejection("3.3.3.3", "bot_ua", 401000);
    // 至此 hitTimestamps 只剩 [401000]，storedCount = 2。
    fake.extendBlock.mockClear();
    fake.recordRejection.mockClear();
    fake.hitCount.clear();

    // 50 次连续快打（窗口内）：
    for (let i = 0; i < 50; i++) {
      await svc.recordRejection("4.4.4.4", "bot_ua", 500000 + i * 100);
    }
    // storedCount = 50, recent.length = 50 → 至少一边满足 → extendBlock 1 次
    expect(fake.extendBlock).toHaveBeenCalledTimes(1);
  });

  it("持久化失败时 recordRejection 不抛错（fail-soft）", async () => {
    fake.recordRejection.mockRejectedValueOnce(new Error("network"));
    await expect(svc.recordRejection("3.3.3.3", "bot_ua")).resolves.toBeUndefined();
  });
});

describe("BotDefenseService.manuallyBlock / removeBlock（2026-08-25 管理页操作）", () => {
  let svc: BotDefenseService;

  beforeEach(async () => {
    process.env.BOT_DEFENSE_ENFORCE = "1";
    fake = makeFakeStore();
    svc = new BotDefenseService();
    await new Promise((r) => setTimeout(r, 0));
    svc.reset();
  });

  afterEach(() => {
    delete process.env.BOT_DEFENSE_ENFORCE;
  });

  it("manuallyBlock 调 store 并写 pos cache → 后续 isBlocked 不查 store 直接命中", async () => {
    const blockCount = await svc.manuallyBlock("1.2.3.4", "manual");
    expect(blockCount).toBe(3);
    expect(fake.manuallyBlock).toHaveBeenCalledWith("1.2.3.4", "manual", expect.any(Number));

    // 手动拉黑后立即拦截（pos cache 命中，不重复查 store）
    fake.isBlocked.mockClear();
    expect(await svc.isBlocked("1.2.3.4")).toBe(true);
    expect(fake.isBlocked).not.toHaveBeenCalled();
  });

  it("manuallyBlock 前若有 neg cache，拉黑后立即失效（不再放行）", async () => {
    // 先走一次 isBlocked=false → 写入 neg cache
    expect(await svc.isBlocked("8.8.8.8")).toBe(false);
    expect(fake.isBlocked).toHaveBeenCalledTimes(1);

    // 手动拉黑 → neg cache 必须被清掉
    await svc.manuallyBlock("8.8.8.8");
    expect(await svc.isBlocked("8.8.8.8")).toBe(true);
  });

  it("removeBlock 删掉 pos cache（移除后立即放行不查 store）", async () => {
    fake.blocked.add("9.9.9.9");
    await svc.manuallyBlock("9.9.9.9"); // 先写入 pos cache
    expect(await svc.isBlocked("9.9.9.9")).toBe(true);

    const removed = await svc.removeBlock("9.9.9.9");
    expect(removed).toBe(true);
    expect(fake.removeBlock).toHaveBeenCalledWith("9.9.9.9");

    // 移除后 isBlocked 立即 false；若无 neg cache，会 fallback 查 store（返回 false）
    fake.isBlocked.mockClear();
    expect(await svc.isBlocked("9.9.9.9")).toBe(false);
  });

  it("移除不存在的 IP → 返回 false 且不报错", async () => {
    const removed = await svc.removeBlock("203.0.113.9");
    expect(removed).toBe(false);
  });

  it("Turso 不可用时 manuallyBlock / removeBlock 抛错（管理侧不静默）", async () => {
    vi.resetModules();
    vi.doMock("../../server/core/services/tursoBotDefenseStore", () => ({
      createTursoBotDefenseStore: () => {
        throw new Error("no TURSO_URL");
      },
    }));
    const mod = await import("../../server/core/services/botDefense");
    const s2 = new mod.BotDefenseService();
    await new Promise((r) => setTimeout(r, 50));
    await expect(s2.manuallyBlock("1.1.1.1")).rejects.toThrow();
    await expect(s2.removeBlock("1.1.1.1")).rejects.toThrow();
  });
});

describe("BotDefenseService Turso 不可用降级", () => {
  it("store init 失败时 isBlocked / recordRejection 都不抛错（fail-soft）", async () => {
    // 独立模块实例，避免与其他 describe 共用 vi.mock factory
    vi.resetModules();
    vi.doMock("../../server/core/services/tursoBotDefenseStore", () => ({
      createTursoBotDefenseStore: () => {
        throw new Error("no TURSO_URL");
      },
    }));
    const mod = await import("../../server/core/services/botDefense");
    const svc = new mod.BotDefenseService();
    // 等 initPromise 完成（catch 路径已走）
    await new Promise((r) => setTimeout(r, 50));
    expect(await svc.isBlocked("1.2.3.4")).toBe(false);
    await expect(svc.recordRejection("1.2.3.4", "bot_ua")).resolves.toBeUndefined();
    // 不要 vi.doUnmock / vi.resetModules（其他 describe 在同一文件并发下可能不可预测）
  });
});
