// 清理 bot 模板型刷词脏数据（2026-08-24）
//
// 脏数据特征（用户截图确认）：数字开头 + 中文标题 + &（或全角＆）+ 两个名字
//   例：55夜半来入切勿开门张亚迪&杨曦颜 / 05『某某』女之女寻母业许祎靖&白野
//
// 安全匹配规则（避免误删正常词）：
//   - term 以 2 位数字开头（GLOB '[0-9][0-9]*'）
//   - 且含 & 或 ＆
//   正常搜索词（如"50度灰""2001太空漫游"）不含 &，不会被删
//
// 流程：统计 → 备份（data/backup-bot-spam-*.json）→ 删除 → 确认
//
// 注意：本机需绕过透明代理直连 Turso，运行前 unset 代理：
//   env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy node scripts/clean-bot-spam.mjs
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TURSO_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("缺 TURSO_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const c = createClient({ url, authToken: token });

function fmtTs(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MATCH_SQL = `
  SELECT term, count, first_at, last_at FROM search_terms
  WHERE term GLOB '[0-9][0-9]*' AND (term LIKE '%&%' OR term LIKE '%＆%')
`;

async function main() {
  // 1. 总览
  const total = (await c.execute("SELECT COUNT(*) as n FROM search_terms")).rows[0].n;
  console.log(`==== 清理前 ====`);
  console.log(`总词条: ${total}`);

  // 2. 统计脏数据
  const dirty = (await c.execute(MATCH_SQL)).rows;
  console.log(`\n命中「数字开头 + 含 &/＆」词条: ${dirty.length}`);

  if (dirty.length === 0) {
    console.log("没有需要清理的脏数据 ✅");
    process.exit(0);
  }

  // 3. 展示样本
  console.log(`\n样本（前 20 条）:`);
  for (const r of dirty.slice(0, 20)) {
    console.log(
      `  [count=${r.count}] "${r.term}"  first=${fmtTs(r.first_at)}  last=${fmtTs(r.last_at)}`
    );
  }

  // 按日期分布
  const byDay = new Map();
  for (const r of dirty) {
    const d = new Date(Number(r.last_at)).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log(`\n按 last_at 日期分布:`);
  for (const [d, n] of [...byDay.entries()].sort().reverse()) {
    console.log(`  ${d}: ${n} 条`);
  }

  // 4. 备份（本地 JSON，可恢复）
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = resolve(__dirname, "..", "data");
  mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDir, `backup-bot-spam-${ts}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      dirty.map((r) => ({
        term: r.term,
        count: r.count,
        first_at: r.first_at,
        last_at: r.last_at,
      })),
      null,
      2
    )
  );
  console.log(`\n✅ 备份已写入: ${backupPath}`);

  // 5. 删除
  const del = await c.execute(MATCH_SQL.replace("SELECT term, count, first_at, last_at", "DELETE"));
  console.log(`\n✅ 已删除: ${del.rowsAffected} 条`);

  // 6. 确认
  const remain = (await c.execute("SELECT COUNT(*) as n FROM search_terms")).rows[0].n;
  console.log(`清理后总词条: ${remain}`);
}

main()
  .catch((err) => {
    console.error("执行失败:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => c.close());
