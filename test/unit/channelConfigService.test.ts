/**
 * ChannelConfigService 单元测试
 *
 * 验证：
 *   - AES-256-GCM 加解密 roundtrip（与 sync-channels.mjs 同格式 iv.tag.data）
 *   - 从 Turso（本地 file: 临时库）拉取加密配置并解密
 *   - CHANNELS_JSON 兜底与未加载时的空快照
 * 不依赖线上 Turso（无网络、无凭据）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelConfigService,
  encryptChannelConfig,
  decryptChannelConfig,
} from "../../server/core/services/channelConfigService";

const KEY = "a".repeat(64); // 32 字节
const SAMPLE = {
  version: 1,
  priorityChannels: ["pri1", "pri2"],
  defaultChannels: ["ch1", "ch2", "ch3"],
};

describe("channelConfig 加解密", () => {
  it("AES-256-GCM roundtrip 还原明文", () => {
    const plain = JSON.stringify(SAMPLE);
    const encrypted = encryptChannelConfig(plain, KEY);
    expect(encrypted.split(".").length).toBe(3);
    expect(decryptChannelConfig(encrypted, KEY)).toBe(plain);
  });

  it("错误密钥解密失败（GCM 认证失败）", () => {
    const encrypted = encryptChannelConfig(JSON.stringify(SAMPLE), KEY);
    expect(() => decryptChannelConfig(encrypted, "b".repeat(64))).toThrow();
  });

  it("非法密钥长度抛错", () => {
    expect(() => encryptChannelConfig("x", "not-hex")).toThrow();
    expect(() => decryptChannelConfig("a.b.c", "not-hex")).toThrow();
  });

  it("非法密文格式抛错", () => {
    expect(() => decryptChannelConfig("bad-format", KEY)).toThrow();
  });
});

describe("ChannelConfigService", () => {
  let dbPath: string;
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `channel-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    client = createClient({ url: `file:${dbPath}` });
    await client.execute(
      `CREATE TABLE channel_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
  });

  afterEach(() => {
    client.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("从 Turso 拉取加密配置并解密（优先级/默认频道）", async () => {
    const encrypted = encryptChannelConfig(JSON.stringify(SAMPLE), KEY);
    await client.execute(
      "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
      [1, encrypted, Date.now()]
    );

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    const snap = service.getSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.priorityChannels).toEqual(["pri1", "pri2"]);
    expect(snap.defaultChannels).toEqual(["ch1", "ch2", "ch3"]);
  });

  it("多版本时取最新版", async () => {
    const insert = async (version: number, channels: string[]) => {
      const encrypted = encryptChannelConfig(
        JSON.stringify({ version, priorityChannels: [], defaultChannels: channels }),
        KEY
      );
      await client.execute(
        "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
        [version, encrypted, Date.now()]
      );
    };
    await insert(1, ["old"]);
    await insert(2, ["new1", "new2"]);

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(2);
    expect(service.getSnapshot().defaultChannels).toEqual(["new1", "new2"]);
  });

  it("reload 忽略缓存、强制重载最新配置", async () => {
    const insert = async (version: number, channels: string[]) => {
      const encrypted = encryptChannelConfig(
        JSON.stringify({ version, priorityChannels: [], defaultChannels: channels }),
        KEY,
      );
      await client.execute(
        "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
        [version, encrypted, Date.now()]
      );
    };
    await insert(1, ["v1"]);

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(1);

    // 数据源更新后，reload 应拿到新版本（ensureLoaded 因缓存不会）
    await insert(2, ["v2"]);
    await service.reload();
    expect(service.getSnapshot().version).toBe(2);
    expect(service.getSnapshot().defaultChannels).toEqual(["v2"]);
  });

  it("未加载且无兜底时返回空快照", () => {
    const service = new ChannelConfigService({});
    const snap = service.getSnapshot();
    expect(snap.version).toBe(0);
    expect(snap.priorityChannels).toEqual([]);
    expect(snap.defaultChannels).toEqual([]);
  });

  it("save 保留 channelNames（仅存在的频道、去空白、剔除不存在的 id）", async () => {
    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: ["pri1"],
        defaultChannels: ["a", "b"],
      }),
    });
    await service.ensureLoaded();

    const saved = await service.save({
      priorityChannels: ["pri1"],
      defaultChannels: ["a", "b"],
      channelNames: {
        pri1: " 优先频道备注 ",
        a: "A频道",
        ghost: "不存在的id",   // 应被剔除
        "": "空key被剔除",
      },
    });

    expect(saved.channelNames).toEqual({ pri1: "优先频道备注", a: "A频道" });

    // 落库可读回：新 service 拉到 v2 也带 channelNames
    const fresh = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await fresh.ensureLoaded();
    expect(fresh.getSnapshot().channelNames).toEqual({ pri1: "优先频道备注", a: "A频道" });
  });

  it("save 写入新版本并使内存缓存立即生效（priority 与 default 互斥去重）", async () => {
    // 初始：v1（pri1 + default a/b/c）
    const encrypted = encryptChannelConfig(
      JSON.stringify({ priorityChannels: ["pri1"], defaultChannels: ["a", "b", "c"] }),
      KEY
    );
    await client.execute(
      "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
      [1, encrypted, Date.now()]
    );

    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(1);

    // save：新增 d、把 a 升为 priority（同时出现在 default 应被剔除）
    const saved = await service.save({
      priorityChannels: ["pri1", "a", "pri1"],   // 重复 pri1 应去重
      defaultChannels: ["a", "b", "c", "d"],     // a 与 priority 重复应被剔除
    });

    expect(saved.version).toBe(2);
    expect(saved.priorityChannels).toEqual(["pri1", "a"]);
    expect(saved.defaultChannels).toEqual(["b", "c", "d"]);

    // 内存缓存立即生效（无需 reload）
    const snap = service.getSnapshot();
    expect(snap.version).toBe(2);
    expect(snap.priorityChannels).toEqual(["pri1", "a"]);

    // 落库可读回：新 service 从 Turso 拉到 v2
    const fresh = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
    });
    await fresh.ensureLoaded();
    expect(fresh.getSnapshot().version).toBe(2);
    expect(fresh.getSnapshot().priorityChannels).toEqual(["pri1", "a"]);
    expect(fresh.getSnapshot().defaultChannels).toEqual(["b", "c", "d"]);
  });

  it("save: 不允许把两份都清空（空配置保护）", async () => {
    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
      envJson: JSON.stringify({ version: 1, priorityChannels: ["p"], defaultChannels: ["d"] }),
    });
    await service.ensureLoaded();
    await expect(
      service.save({ priorityChannels: [], defaultChannels: [] })
    ).rejects.toThrow("不能为空");
  });

  it("save: 未配置 Turso / CHANNEL_KEY 时拒绝持久化", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({ version: 1, priorityChannels: [], defaultChannels: ["d"] }),
    });
    await expect(
      service.save({ priorityChannels: [], defaultChannels: ["d"] })
    ).rejects.toThrow("不可用");
  });

  it("CHANNELS_JSON 兜底（无 Turso）", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({ ...SAMPLE, version: 7 }),
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(7);
    expect(service.getSnapshot().defaultChannels).toEqual(SAMPLE.defaultChannels);
  });

  it("Turso 无配置时降级到 CHANNELS_JSON 兜底", async () => {
    const service = new ChannelConfigService({
      tursoUrl: `file:${dbPath}`,
      channelKey: KEY,
      envJson: JSON.stringify({ ...SAMPLE, version: 3 }),
    });
    await service.ensureLoaded();
    expect(service.getSnapshot().version).toBe(3);
  });

  it("远程频道源兜底（无本地配置时拉取）", async () => {
    // 用本地 HTTP server 模拟官方 /api/channels 响应
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          code: 0,
          data: { version: 2, channels: ["remote1", "remote2", "remote3"] },
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address() as any;
    const url = `http://127.0.0.1:${address.port}/api/channels`;

    const service = new ChannelConfigService({ remoteUrl: url });
    await service.ensureLoaded();
    const snap = service.getSnapshot();
    expect(snap.version).toBe(2);
    expect(snap.defaultChannels).toEqual(["remote1", "remote2", "remote3"]);
    expect(snap.priorityChannels).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("远程频道源 500 时静默降级（不抛错）", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as any;
    const url = `http://127.0.0.1:${address.port}/api/channels`;

    const service = new ChannelConfigService({ remoteUrl: url });
    await service.ensureLoaded();
    expect(service.getSnapshot().defaultChannels).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("ChannelConfigService 频道下发", () => {
  it("getGrantedChannels 只取 defaultChannels 前 N 个、不含 priority", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: ["pri1", "pri2"],
        defaultChannels: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
      }),
    });
    const granted = service.getGrantedChannels(10);
    expect(granted.version).toBe(1);
    expect(granted.channels).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(granted.channels).not.toContain("pri1");
  });

  it("getGrantedChannels 数量超界按实际返回、非法 limit 兜底 0", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: [],
        defaultChannels: ["a", "b"],
      }),
    });
    expect(service.getGrantedChannels(100).channels).toEqual(["a", "b"]);
    expect(service.getGrantedChannels(-1).channels).toEqual([]);
  });

  it("getGrantedChannels：priority 频道即使同时出现在 default 也被剔除", async () => {
    const service = new ChannelConfigService({
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: ["pri1", "pri2"],
        defaultChannels: ["pri1", "a", "pri2", "b", "c"],
      }),
    });
    // 剔除 pri1/pri2 后剩 a/b/c，取前 10 → a/b/c
    expect(service.getGrantedChannels(10).channels).toEqual(["a", "b", "c"]);
    // 取 2 → 剔除后取前 2
    expect(service.getGrantedChannels(2).channels).toEqual(["a", "b"]);
  });

  it("resolveChannelGrant：无 key / 未注册 key 回落默认值", async () => {
    const service = new ChannelConfigService({
      channelsKeys: "keyA:15|keyB:all",
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: [],
        defaultChannels: Array.from({ length: 40 }, (_, i) => `ch${i}`),
      }),
    });
    expect(service.resolveChannelGrant(null, 10)).toBe(10);
    expect(service.resolveChannelGrant("unknown", 10)).toBe(10);
  });

  it("resolveChannelGrant：已注册 key 返回配置数量、all 返回全部 default", async () => {
    const service = new ChannelConfigService({
      channelsKeys: "keyA:15|keyB:all",
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: ["pri"],
        defaultChannels: Array.from({ length: 40 }, (_, i) => `ch${i}`),
      }),
    });
    expect(service.resolveChannelGrant("keyA", 10)).toBe(15);
    expect(service.resolveChannelGrant("keyB", 10)).toBe(40); // 全部 default（不含 priority）
  });

  it("resolveChannelGrant：兼容 JSON 格式与非法配置回落默认", async () => {
    const service = new ChannelConfigService({
      channelsKeys: JSON.stringify({ keyA: "15", keyB: "all" }),
      envJson: JSON.stringify({
        version: 1,
        priorityChannels: [],
        defaultChannels: Array.from({ length: 40 }, (_, i) => `ch${i}`),
      }),
    });
    expect(service.resolveChannelGrant("keyA", 10)).toBe(15);
    const bad = new ChannelConfigService({ channelsKeys: "not-a-format" });
    expect(bad.resolveChannelGrant("keyA", 10)).toBe(10);
  });
});
