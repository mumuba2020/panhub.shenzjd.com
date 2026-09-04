// 本地 mock wx-auth 服务（仅用于本地验证搜索鉴权流程）
//
// 用法：
//   node scripts/mock-wx-auth.mjs &
//
// 然后启动 dev：
//   WX_AUTH_API_BASE=http://localhost:8899 npm run dev
//
// 本服务会根据 mock-tokens.json 里的配置回复 authenticated：
//   - 白名单内的 token / openid → authenticated: true（放行）
//   - 其他 → authenticated: false（拒绝）
//
// 真实生产验证应改用真实已登录 cookie（浏览器 DevTools 复制），
// 配合默认 WX_AUTH_API_BASE=https://wx-auth.shenzjd.com 走真实远端。

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PORT = Number(process.env.WX_AUTH_MOCK_PORT || 8899);
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_FILE = resolve(__dirname, ".wx-auth-mock.json");

function loadMock() {
  if (!existsSync(MOCK_FILE)) {
    return { tokens: ["test-fake-token"], openids: ["test-fake-openid"] };
  }
  try {
    return JSON.parse(readFileSync(MOCK_FILE, "utf-8"));
  } catch {
    return { tokens: [], openids: [] };
  }
}

const mock = loadMock();

const server = http.createServer((req, res) => {
  // CORS（开发环境可能被前端 dev server 探测）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("content-type", "application/json");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (!req.url || !req.url.startsWith("/api/auth/check")) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get("token");
  const openid = url.searchParams.get("openid");

  let authenticated = false;
  if (token && mock.tokens.includes(token)) authenticated = true;
  else if (openid && mock.openids.includes(openid)) authenticated = true;

  console.log(
    `[mock-wx-auth] ${token ? "token" : "openid"}=${token || openid} → authenticated=${authenticated}`
  );

  res.end(JSON.stringify({ authenticated }));
});

server.listen(PORT, () => {
  console.log(`[mock-wx-auth] listening on http://localhost:${PORT}`);
  console.log(
    `[mock-wx-auth] 白名单 token: ${mock.tokens.join(", ")}  openid: ${mock.openids.join(", ")}`
  );
  if (existsSync(MOCK_FILE)) {
    console.log(`[mock-wx-auth] 配置来源: ${MOCK_FILE}`);
  } else {
    console.log(`[mock-wx-auth] 使用默认配置；可在 ${MOCK_FILE} 自定义`);
  }
});
