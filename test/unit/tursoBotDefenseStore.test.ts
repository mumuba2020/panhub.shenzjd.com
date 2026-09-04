/**
 * TursoBotDefenseStore 单元测试（2026-08-25 新增）
 *
 * 用 @libsql/client 的 file: 本地内存库（file::memory:）跑真实 SQL，
 * 验证 IP 黑名单分级封禁逻辑（2026-08-25 用户拍板）：
 * - block_count 1 → 24h，2 → 7 天，>=3 → 30 天
 * - block_count 跨周期保留：prune 只删"从未被正式拉黑过（block_count=0）"的
 *   过期条目，惯犯档案永久保留，解封后再刷从上一档继续升级
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TursoBotDefenseStore } from "../../server/core/services/tursoBotDefenseStore";
import { formatDateKey, beijingDayStart } from "../../server/core/services/hotSearchUtils";

describe("TursoBotDefenseStore 分级封禁", () => {
  let store: TursoBotDefenseStore;

  beforeEach(async () => {
    store = new TursoBotDefenseStore("file::memory:");
    await (store as any).waitForInit();
  });

  afterEach(() => {
    store.close();
  });

  /** 直接查表拿 expires_at / block_count（绕过 isBlocked 的 >now 判断，精确验档位） */
  async function rowOf(ip: string) {
    const r = (
      await (store as any).client.execute(
        "SELECT expires_at, block_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    return r
      ? { expiresAt: r.expires_at as number, blockCount: r.block_count as number }
      : null;
  }

  it("首次拉黑：block_count=1，封禁 24h", async () => {
    const now = 1_700_000_000_000;
    const bc = await store.extendBlock("1.1.1.1", "bot_ua", now);
    expect(bc).toBe(1);

    const row = await rowOf("1.1.1.1");
    expect(row?.blockCount).toBe(1);
    expect(row?.expiresAt).toBe(now + 24 * 60 * 60_000);
  });

  it("再次拉黑升级：block_count=2，封禁 7 天", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("2.2.2.2", "bot_ua", now);
    const bc = await store.extendBlock("2.2.2.2", "bot_ua", now + 8 * 24 * 60 * 60_000);
    expect(bc).toBe(2);

    const row = await rowOf("2.2.2.2");
    expect(row?.blockCount).toBe(2);
    expect(row?.expiresAt).toBe(now + 8 * 24 * 60 * 60_000 + 7 * 24 * 60 * 60_000);
  });

  it("三次及以上：block_count>=3，封禁 30 天封顶", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    await store.extendBlock("3.3.3.3", "bot_ua", now);
    await store.extendBlock("3.3.3.3", "bot_ua", now + 30 * day);
    const bc = await store.extendBlock("3.3.3.3", "bot_ua", now + 60 * day);
    expect(bc).toBe(3);

    const row = await rowOf("3.3.3.3");
    expect(row?.blockCount).toBe(3);
    expect(row?.expiresAt).toBe(now + 60 * day + 30 * day);
  });

  it("recordRejection 返回历史 block_count（惯犯识别）", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("4.4.4.4", "bot_ua", now);
    const r = await store.recordRejection("4.4.4.4", "bot_ua", now + 25 * 60 * 60_000);
    expect(r.blockCount).toBe(1);
    expect(r.hitCount).toBe(1);
  });

  // 2026-08-27 用户实测回归：自己 IP 被假拉黑（block_count=0 / hit_count=1 /
  // expires_at=1h 短标记）却命中蜜罐。根因 isBlocked 只看 expires_at > now，
  // 把 recordRejection 的"累计期短过期标记"误判成封禁。正式拉黑才有
  // block_count > 0（extendBlock / manuallyBlock），计数记录不应算封禁。
  it("isBlocked：仅 recordRejection 计数（block_count=0）不算封禁", async () => {
    const now = 1_700_000_000_000;
    await store.recordRejection("counter-only", "bot_ua", now);
    // 1h 短标记未过期，但从未正式拉黑 → 不算封禁
    expect(await store.isBlocked("counter-only", now + 30 * 60_000)).toBe(false);
    expect(await store.isBlocked("counter-only", now + 59 * 60_000)).toBe(false);
  });

  it("isBlocked：正式拉黑（block_count>0 且未过期）才算封禁", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("really-blocked", "bot_ua", now);
    expect(await store.isBlocked("really-blocked", now + 60_000)).toBe(true);
    // 过期后放行
    expect(await store.isBlocked("really-blocked", now + 25 * 60 * 60_000)).toBe(false);
  });

  it("isBlocked：从未有任何记录的 IP 返回 false", async () => {
    expect(await store.isBlocked("no-record", 1_700_000_000_000)).toBe(false);
  });

  it("prune 只删从未拉黑过的过期条目，惯犯档案保留（跨周期继续升级）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;

    // 惯犯：被拉黑过（block_count=1），expires 已过（40 天后）
    await store.extendBlock("recidivist", "bot_ua", now);
    // 非惯犯：只累计拒绝、从未达阈值（expires = now+1h 短过期，已过）
    await store.recordRejection("cleanup-me", "bot_ua", now - 2 * 60 * 60_000);

    const pruned = await store.pruneExpired(now + 40 * day);
    // 只清掉非惯犯
    expect(pruned).toBe(1);
    expect(await rowOf("recidivist")).not.toBeNull();
    expect(await rowOf("cleanup-me")).toBeNull();

    // 惯犯 40 天后再次达阈值：从第 2 档（7 天）继续，而不是从 1 重新来
    const bc = await store.extendBlock("recidivist", "bot_ua", now + 40 * day);
    expect(bc).toBe(2);
  });

  it("listEntries：返回条目含档位/时间字段，按最近活动倒序", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 封禁中的惯犯（block_count=2）
    await store.extendBlock("ban-a", "bot_ua", now - 1000);
    await store.extendBlock("ban-a", "bot_ua", now - 1000);
    // 短计数记录（未达阈值，block_count=0）
    await store.recordRejection("hit-b", "bad_term", now - 2000);

    const { items, total } = await store.listEntries(now, 100);
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    // 最近活动倒序：ban-a(last_at=now-1000) 在 hit-b(last_at=now-2000) 前
    expect(items[0].ip).toBe("ban-a");
    expect(items[0].blockCount).toBe(2);
    expect(items[0].expiresAt).toBe(now - 1000 + 7 * day);
    expect(items[0].hitCount).toBe(0);
    expect(items[1].ip).toBe("hit-b");
    expect(items[1].blockCount).toBe(0);
  });

  it("listEntries：IP 模糊搜索 + 状态筛选 + offset 分页", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 封禁中（block_count=1，24h 未过期）
    await store.extendBlock("203.0.113.1", "bot_ua", now - 1000);
    // 已解封（7 天前拉黑 24h，已过期）
    await store.extendBlock("203.0.113.2", "rate_limit", now - 7 * day);
    // 未拉黑计数记录（block_count=0）
    await store.recordRejection("9.9.9.9", "bad_term", now - 500);

    // 1. IP 模糊搜索（匹配两个 203.0.113.x）
    const fuzzy = await store.listEntries(now, 100, { ipFilter: "203.0.113" });
    expect(fuzzy.total).toBe(2);
    expect(fuzzy.items.map((i) => i.ip).sort()).toEqual(["203.0.113.1", "203.0.113.2"]);

    // 2. 状态筛选：封禁中
    const blocked = await store.listEntries(now, 100, { status: "blocked" });
    expect(blocked.total).toBe(1);
    expect(blocked.items[0].ip).toBe("203.0.113.1");

    // 3. 状态筛选：已解封（含从未拉黑的计数记录）
    const free = await store.listEntries(now, 100, { status: "free" });
    expect(free.total).toBe(2);
    expect(free.items.map((i) => i.ip).sort()).toEqual(["203.0.113.2", "9.9.9.9"]);

    // 4. 分页：limit=1 offset=1 → 返回第 2 条
    const page2 = await store.listEntries(now, 1, { offset: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it("manuallyBlock：管理页手动拉黑直接 30 天（block_count 从 0 跳到 3）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    const bc = await store.manuallyBlock("5.5.5.5", "manual", now);

    expect(bc).toBe(3); // 手动拉黑固定取最长档
    const row = await rowOf("5.5.5.5");
    expect(row?.blockCount).toBe(3);
    expect(row?.expiresAt).toBe(now + 30 * day);
  });

  it("manuallyBlock：已有惯犯档案时在历史档位基础上 +1 且至少 3 档", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 先自动拉黑过一次（block_count=2，7 天档）
    await store.extendBlock("recidivist-m", "bot_ua", now);
    await store.extendBlock("recidivist-m", "bot_ua", now + 8 * day);

    const bc = await store.manuallyBlock("recidivist-m", "manual", now + 9 * day);
    expect(bc).toBe(3); // 2+1 → 3 档（30 天）
    const row = await rowOf("recidivist-m");
    expect(row?.expiresAt).toBe(now + 9 * day + 30 * day);
  });

  it("removeBlock：删除整行（含惯犯档案），返回是否删除", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("doomed", "bot_ua", now);
    expect(await rowOf("doomed")).not.toBeNull();

    expect(await store.removeBlock("doomed")).toBe(true);
    expect(await rowOf("doomed")).toBeNull();
    // 已删除再删 → false
    expect(await store.removeBlock("doomed")).toBe(false);
  });

  it("removeBlock：删除从未拉黑的计数记录同样生效", async () => {
    const now = 1_700_000_000_000;
    await store.recordRejection("soft-rm", "rate_limit", now);
    expect(await store.removeBlock("soft-rm")).toBe(true);
    expect(await rowOf("soft-rm")).toBeNull();
  });

  it("第四次升级 → block_count=4，封禁时长变为永久（2026-08-25 用户拍板）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 前三次按 24h/7d/30d 递增
    await store.extendBlock("perm-a", "bot_ua", now);
    await store.extendBlock("perm-a", "bot_ua", now + 1 * day);
    await store.extendBlock("perm-a", "bot_ua", now + 8 * day);
    const bc = await store.extendBlock("perm-a", "bot_ua", now + 38 * day);
    expect(bc).toBe(4);

    const row = await rowOf("perm-a");
    expect(row?.blockCount).toBe(4);
    // 永久 = far-future 时间戳（2100 年）
    expect(row?.expiresAt).toBe(4_100_000_000_000);
  });

  it("manuallyBlock 已查封 >=4 次历史 → 永久（2026-08-25）", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    // 先自动升级到 block_count=4（永久档）
    await store.extendBlock("manual-perm", "bot_ua", now);
    await store.extendBlock("manual-perm", "bot_ua", now + 1 * day);
    await store.extendBlock("manual-perm", "bot_ua", now + 8 * day);
    await store.extendBlock("manual-perm", "bot_ua", now + 38 * day);
    // 管理员再手动拉黑 → 仍是永久
    const bc = await store.manuallyBlock("manual-perm", "manual", now + 39 * day);
    expect(bc).toBeGreaterThanOrEqual(4);
    const row = await rowOf("manual-perm");
    expect(row?.expiresAt).toBe(4_100_000_000_000);
  });

  it("并发 recordRejection 不撞 UNIQUE 且 hit_count 正确累加（2026-08-26 修复回归）", async () => {
    // 复现线上 bug：同一 IP 短时间内多次频控命中，每次异步调 recordRejection
    // 原两段式 SELECT-then-INSERT 在并发下 TOCTOU，多个请求各自 SELECT 都没查到
    // 后都 INSERT，撞 PRIMARY KEY UNIQUE。原子 upsert 后应安全。
    const now = 1_700_000_000_000;
    const ip = "203.0.113.7";
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.recordRejection(ip, "rate_limit", now + i)
      )
    );
    // 无一抛 UNIQUE 错（到这步说明全成功）
    const hitCounts = results.map((r) => r.hitCount).sort((a, b) => a - b);
    expect(hitCounts).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // 最终 hit_count == N
    const row = await rowOf(ip);
    expect(row?.blockCount).toBe(0); // 仅累计，未达拉黑阈值不会被 extendBlock
    const r2 = (
      await (store as any).client.execute(
        "SELECT hit_count FROM rejected_ips WHERE ip = ?",
        [ip]
      )
    ).rows[0];
    expect(r2?.hit_count as number).toBe(N);
  });

  it("recordRejection 对已拉黑条目：hit_count 在 extendBlock 的 0 基础上累加，block_count 不被覆盖", async () => {
    // extendBlock 插入时 hit_count=0, block_count=1；后续 recordRejection 走
    // ON CONFLICT 更新分支：hit_count=0+1=1，block_count 保留=1
    const now = 1_700_000_000_000;
    await store.extendBlock("9.9.9.9", "bot_ua", now);
    const r = await store.recordRejection("9.9.9.9", "bot_ua", now + 25 * 60 * 60_000);
    expect(r.hitCount).toBe(1);
    expect(r.blockCount).toBe(1);
    // 仍未被 extendBlock 改过 expires_at（保留拉黑时的 now+24h，已过期）
    expect(r.blocked).toBe(false); // block_count>0 但 expires_at(now+24h) <= now+25h
  });

  it("getOverviewStats：总条目/封禁中/今日活跃 + TOP 被拒 IP", async () => {
    // 以真实"今天"（北京 0 点）为基准
    const todayStart = beijingDayStart(formatDateKey(Date.now()));
    const dayMs = 86400000;
    const diag = todayStart + 3600_000; // 今天内
    // 惯犯 A：拉黑（block_count=1，封禁中）+ 今天还有活动
    await store.extendBlock("1.1.1.1", "bot_ua", diag - 1000);
    await store.recordRejection("1.1.1.1", "bot_ua", diag);
    // 惯犯 B：已解封（7 天前拉黑 24h，早过期），但今天仍被拒（应计入 todayActive 不计 blocked）
    await store.extendBlock("2.2.2.2", "rate_limit", diag - 7 * dayMs);
    await store.recordRejection("2.2.2.2", "rate_limit", diag);
    // 计数记录 C：从未拉黑（block_count=0），今天被拒
    await store.recordRejection("3.3.3.3", "bad_term", diag);
    // 老记录 D：8 天前拉黑 24h（当前在封禁期内？8 天 > 24h 已过期；不在近 7 天窗口）
    await store.extendBlock("4.4.4.4", "bot_ua", diag - 8 * dayMs);

    const stats = await store.getOverviewStats(7, 10, diag);
    expect(stats.total).toBe(4); // A/B/C/D 都有条目
    expect(stats.blocked).toBe(1); // 仅 A 封禁中（D 的 24h 在 8 天前早已过期）
    expect(stats.todayActive).toBe(3); // A/B/C 今日都有活动
    // TOP IP（近 7 天活跃，按 hit_count 降序）：A、B 各 2 次，C 1 次
    expect(stats.topIps).toHaveLength(3);
    expect(stats.topIps.map((i) => i.ip)).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
  });

  // ===== 蜜罐命中记录 honeypot_hits（2026-09-03 用户反馈解封闭环）=====

  it("recordHoneypotHit：记录 openid↔ip，重复命中 hits 累加 last_at 刷新", async () => {
    const now = 1_700_000_000_000;
    expect(await store.recordHoneypotHit("o-real-user", "203.0.113.9", now)).toBe(true);
    expect(await store.recordHoneypotHit("o-real-user", "203.0.113.9", now + 60_000)).toBe(true);
    // 同一 openid 命中不同 IP → 新行
    expect(await store.recordHoneypotHit("o-real-user", "198.51.100.7", now + 120_000)).toBe(true);

    const rows = (
      await (store as any).client.execute(
        "SELECT openid, ip, hits, last_at FROM honeypot_hits ORDER BY last_at"
      )
    ).rows;
    expect(rows).toHaveLength(2);
    // 同 ip 的命中 hits=2、last_at 刷新为第二次
    expect(rows[0].hits).toBe(2);
    expect(rows[0].last_at).toBe(now + 60_000);
    expect(rows[1].ip).toBe("198.51.100.7");
    expect(rows[1].hits).toBe(1);
  });

  it("recordHoneypotHit：空 openid/ip 忽略（返回 false）", async () => {
    const now = 1_700_000_000_000;
    expect(await store.recordHoneypotHit("", "1.1.1.1", now)).toBe(false);
    expect(await store.recordHoneypotHit("o-x", "  ", now)).toBe(false);
    const rows = (
      await (store as any).client.execute("SELECT COUNT(*) AS c FROM honeypot_hits")
    ).rows;
    expect(rows[0].c).toBe(0);
  });

  it("listHoneypotByOpenid：按最近命中倒序返回该 openid 的 IP", async () => {
    const now = 1_700_000_000_000;
    await store.recordHoneypotHit("o-abc", "1.1.1.1", now + 1000);
    await store.recordHoneypotHit("o-abc", "2.2.2.2", now + 3000);
    await store.recordHoneypotHit("o-abc", "1.1.1.1", now + 5000);
    await store.recordHoneypotHit("o-xyz", "9.9.9.9", now + 2000); // 别人的不影响

    const hits = await store.listHoneypotByOpenid("o-abc", 20);
    expect(hits).toHaveLength(2);
    // 时间倒序：1.1.1.1（now+5000）在前，2.2.2.2（now+3000）在后
    expect(hits[0]).toEqual({ ip: "1.1.1.1", hits: 2, lastAt: now + 5000 });
    expect(hits[1]).toEqual({ ip: "2.2.2.2", hits: 1, lastAt: now + 3000 });
    // 空 openid / 无记录
    expect(await store.listHoneypotByOpenid("", 20)).toEqual([]);
    expect(await store.listHoneypotByOpenid("no-such", 20)).toEqual([]);
  });

  it("listHoneypotByIp：返回某 IP 最近影响了哪些 openid", async () => {
    const now = 1_700_000_000_000;
    await store.recordHoneypotHit("o-1", "5.5.5.5", now + 1000);
    await store.recordHoneypotHit("o-2", "5.5.5.5", now + 2000);
    await store.recordHoneypotHit("o-3", "6.6.6.6", now + 3000);

    const hits = await store.listHoneypotByIp("5.5.5.5", 20);
    expect(hits).toHaveLength(2);
    // 时间倒序
    expect(hits[0].openid).toBe("o-2");
    expect(hits[1].openid).toBe("o-1");
  });

  it("listStatusByIps：IN 批量查黑名单状态，仅返回有记录的 IP", async () => {
    const now = 1_700_000_000_000;
    await store.extendBlock("203.0.113.50", "bot_ua", now);
    await store.recordRejection("203.0.113.51", "rate_limit", now);
    // 无记录 IP + 空输入
    expect(await store.listStatusByIps(["203.0.113.99"], now)).toEqual([]);
    expect(await store.listStatusByIps([], now)).toEqual([]);

    const rows = await store.listStatusByIps(["203.0.113.50", "203.0.113.51", "203.0.113.99"], now);
    expect(rows).toHaveLength(2);
    const map = new Map(rows.map((r) => [r.ip, r]));
    expect(map.get("203.0.113.50")?.blockCount).toBe(1);
    expect(map.get("203.0.113.51")?.blockCount).toBe(0);
    expect(map.has("203.0.113.99")).toBe(false);
  });

  it("pruneHoneypotHits：只清超过保留期的命中记录", async () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60_000;
    await store.recordHoneypotHit("o-old", "1.1.1.1", now - 200 * day); // 超期
    await store.recordHoneypotHit("o-new", "2.2.2.2", now); // 近期

    const pruned = await store.pruneHoneypotHits(now, 90 * day);
    expect(pruned).toBe(1);
    const remain = (
      await (store as any).client.execute("SELECT openid FROM honeypot_hits")
    ).rows;
    expect(remain).toHaveLength(1);
    expect(remain[0].openid).toBe("o-new");
  });
});
