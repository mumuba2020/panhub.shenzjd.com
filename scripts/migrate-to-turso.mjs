#!/usr/bin/env node
/**
 * 热搜数据迁移脚本：本地 sqlite → Turso（libSQL）
 *
 * 用法（需先注册 turso.tech 并创建数据库，拿到 URL 和 token）：
 *   TURSO_URL=libsql://<db>-<org>.turso.io TURSO_AUTH_TOKEN=<token> \
 *     node scripts/migrate-to-turso.mjs                    # 默认读 ./data/hot-searches.db
 *   node scripts/migrate-to-turso.mjs --db <path>          # 指定源 db
 *
 * 说明：libSQL 与 SQLite 同语法，INSERT OR IGNORE 幂等，可重复执行（已存在的数据不会重复插入）。
 * 与 scripts/export-hot-searches.mjs（导出到 D1）对称。
 */
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const sqliteModule = () => require("node:" + "sqlite");

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL) {
  console.error("❌ 缺少 TURSO_URL 环境变量（如 libsql://xxx.turso.io）");
  process.exit(1);
}
if (!TURSO_TOKEN) {
  console.error("❌ 缺少 TURSO_AUTH_TOKEN 环境变量（Turso 控制台 → Database → 生成 token）");
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const DB_PATH = getArg("--db", process.env.HOT_SEARCH_DB_PATH || "./data/hot-searches.db");

if (!existsSync(DB_PATH)) {
  console.error(`❌ 源数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

const { DatabaseSync } = sqliteModule();
const src = new DatabaseSync(DB_PATH);
const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

const BATCH_SIZE = 200;

async function importTable(table, columns, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const stmts = chunk.map((row) => ({
      sql: `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      args: columns.map((c) => row[c]),
    }));
    const results = await client.batch(stmts);
    for (const r of results) inserted += r.rowsAffected ?? 0;
  }
  return inserted;
}

async function main() {
  // 1. 建表（与 TursoHotSearchStore 保持一致；
  //    hot_searches 表已废弃（2026-08-18），只迁 search_terms）
  await client.batch([
    `CREATE TABLE IF NOT EXISTS search_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      count INTEGER NOT NULL DEFAULT 1,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_search_terms_last ON search_terms(last_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_search_terms_count ON search_terms(count DESC)",
  ]);
  console.log("✅ 表结构已就绪");

  // 2. 读取源数据（只读 search_terms）
  const termRows = src
    .prepare("SELECT term, count, first_at, last_at FROM search_terms")
    .all();
  console.log(`   源数据: search_terms ${termRows.length} 条`);

  // 3. 批量导入（幂等）
  const termsInserted = await importTable(
    "search_terms",
    ["term", "count", "first_at", "last_at"],
    termRows
  );

  console.log("✅ 迁移完成");
  console.log(`   search_terms: ${termRows.length} 条（新插入 ${termsInserted}）`);
  console.log("");
  console.log("下一步：配置 TURSO_URL / TURSO_AUTH_TOKEN 到服务器 .env 与 Worker 环境变量，重启服务。");

  client.close();
  src.close();
}

main().catch((err) => {
  console.error("❌ 迁移失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
