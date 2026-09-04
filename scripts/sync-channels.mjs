#!/usr/bin/env node
/**
 * 频道配置加密入库脚本（2026-08-24）
 *
 * 把 config/channels.json（真实频道清单）用 AES-256-GCM 加密后写入 Turso
 * channel_config 表（version 递增），供 ChannelConfigService 拉取解密。
 *
 * 用法：
 *   CHANNEL_KEY=<64位hex> node scripts/sync-channels.mjs
 *     # 默认读 config/channels.json，加密写入后回读验证
 *
 * 注意：
 *   - 首次使用前先生成密钥：node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
 *   - CHANNEL_KEY 与 server 侧 ChannelConfigService 的 CHANNEL_KEY 必须一致
 *   - 加密格式与 server/core/services/channelConfigService.ts 保持一致（iv.tag.data，base64）
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = join(__dirname, "..", "config", "channels.json");

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const CHANNEL_KEY = process.env.CHANNEL_KEY;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("❌ 缺少 TURSO_URL / TURSO_AUTH_TOKEN（与 .env 一致）");
  process.exit(1);
}
if (!CHANNEL_KEY) {
  console.error(
    "❌ 缺少 CHANNEL_KEY。生成：node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
  );
  process.exit(1);
}
const key = Buffer.from(CHANNEL_KEY, "hex");
if (key.length !== 32) {
  console.error("❌ CHANNEL_KEY 必须是 64 位 hex（32 字节）");
  process.exit(1);
}

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function main() {
  const raw = readFileSync(CHANNELS_PATH, "utf8");
  const config = JSON.parse(raw);
  const payload = JSON.stringify({
    priorityChannels: config.priorityChannels || [],
    defaultChannels: config.defaultChannels || [],
  });
  console.log(`📄 读取 ${CHANNELS_PATH}`);
  console.log(`   频道: priority ${(config.priorityChannels || []).length} 个, default ${(config.defaultChannels || []).length} 个`);

  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  try {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS channel_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    );
    console.log("✅ channel_config 表已就绪");

    const rows = (await client.execute("SELECT COALESCE(MAX(version), 0) as v FROM channel_config")).rows;
    const nextVersion = (Number(rows[0]?.v) || 0) + 1;

    const encrypted = encrypt(payload);
    await client.execute(
      "INSERT INTO channel_config (version, payload, updated_at) VALUES (?, ?, ?)",
      [nextVersion, encrypted, Date.now()]
    );
    console.log(`✅ 已写入版本 v${nextVersion}（加密后 ${encrypted.length} 字符）`);

    // 回读验证：解密并比对
    const back = (await client.execute(
      "SELECT version, payload FROM channel_config ORDER BY version DESC LIMIT 1"
    )).rows[0];
    const plain = decrypt(back.payload);
    const parsed = JSON.parse(plain);
    const ok =
      parsed.priorityChannels.length === (config.priorityChannels || []).length &&
      parsed.defaultChannels.length === (config.defaultChannels || []).length;
    console.log(
      ok
        ? `✅ 回读验证通过（v${back.version}）`
        : `❌ 回读验证失败：数量不一致`
    );
    if (!ok) process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("❌ 同步失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
