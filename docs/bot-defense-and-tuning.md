# Bot 防御与运维（2026-08-24）

## 背景

2026-08-24 用户报告：数据库出现大量「数字+文字+&+人名」模板型刷词，攻击者用真实 Chrome UA 绕过 UA 校验、用分布式低频（每 IP 不到 60 req/min）绕过限流中间件，词条含中文又过了 `isRejectedTerm`。

为应对这波 + 后续可能的同类攻击，引入四层防御：

| 层 | 文件 | 作用 |
|---|---|---|
| 1. UA 校验 | `server/utils/requireAuth.ts` | bot UA + 无凭证 → 403 |
| 2. IP 限流 | `server/middleware/rateLimiter.ts` | 60 req/IP/min → 429 |
| 3. 词条格式过滤 | `server/utils/recordSearchTerm.ts` | URL/控制字符/纯符号 → 不入库 |
| 4. **IP 黑名单** | `server/core/services/botDefense.ts` | **同一 IP 累计 ≥5 reject / 60s → 自动 24h 拉黑** |

## IP 黑名单机制

### 触发路径

任何一处拦截都会把 IP 推到 `BotDefenseService.recordRejection`：

- **bot_ua**：requireHumanOrCredential 拦截 / requireWxAuth 校验失败
- **rate_limit**：单 IP 触达 60 req/min（429）
- **bad_term**：URL/控制字符/纯符号（脚本探测）

每次记录：
1. 调 `store.recordRejection` 累计 `hit_count` 到 Turso `rejected_ips` 表
2. 滑动窗口（60s 内）≥5 次 → 自动 `store.extendBlock` 拉黑 24h
3. 立即写 pos 内存 cache（5min 复用），下次 `isBlocked` 直接命中放行

### 查询流程

`/api/search`（GET/POST）入口最前：

```
isBlocked(ip)?    ← posCache(5min) → negCache(30s) → Turso
  ↓ 是             命中 → 403 "ip blocked"（连 UA 校验都跳过）
  ↓ 否
requireHumanOrCredential (UA)
  ↓
requireWxAuth (公众号登录态)
  ↓
... 业务
```

### 部署运维

#### Worker（Cloudflare Workers）

环境变量已支持，从 `wrangler secret put` 配置即可。**首次部署会自动建表**（`rejected_ips`，`CREATE TABLE IF NOT EXISTS`）。

```
# 必须保留（防刷基础设施）
wrangler secret put TURSO_URL
wrangler secret put TURSO_AUTH_TOKEN
```

#### Docker

服务器 .env 写入：

```bash
TURSO_URL=libsql://xxx.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

容器启动时同样会建表。

#### 查询当前黑名单

本地脚本（参考 `scripts/diag-bot-spam.mjs` 模式）：

```sql
SELECT ip, hit_count, reason, first_at, last_at, expires_at
FROM rejected_ips
WHERE expires_at > strftime('%s','now') * 1000
ORDER BY last_at DESC;
```

#### 手工解封某个 IP

```sql
DELETE FROM rejected_ips WHERE ip = '1.2.3.4';
```

24h 自动过期也可不管。

#### 用户反馈"看到蜜罐数据" → openid 解封闭环（2026-09-03）

**问题**：黑名单只按 IP 记。蜜罐拦截（`isBlocked`）发生在 `requireWxAuth` **之前**，被蜜罐的
真人请求解不出 openid，且 `search_log` 只记成功放行的搜索——用户拿 openid 反馈时，
后台没有任何 "该 openid 正在被哪个被封 IP 蜜罐" 的记录，无法定位也无法解封。

**方案**（最小闭环 + 不增加热路径 DB 读）：
1. 蜜罐命中时若请求带凭证，`maybeRecordHoneypotOpenid`（见 `server/utils/recordHoneypotOpenid.ts`）
   fire-and-forget 解析 openid（复用 wx-auth 10min 内存缓存），把 `(openid, ip)` upsert 进
   `honeypot_hits` 表（纯 DB **写**，只有被误伤的真人触发，量小）。
   - 无凭证爬虫 → 同步短路，零远程零 DB
2. 管理端黑名单面板「蜜罐反馈解封」：
   - 按 openid 查 → `GET /api/blacklist-lookup?openid=xxx`（honeypot_hits 一次 +
     rejected_ips 一次 IN 批量）→ 该 openid 最近命中过蜜罐的 IP + 各 IP 封禁状态
   - 一键解封复用现有 `removeIp`（DELETE /api/blacklist?ip=）
   - 按 IP 查 → `?ip=xxx` 可看该 IP 影响了哪些 openid

**维护**：`honeypot_hits` 记录仅用于近期反馈，随 botDefense 周期 prune 清理（默认 90 天）。

#### prune 策略

`BotDefenseService.startMaintenance()` 周期清理（2026-09-03 起为降 Turso 读量拆成三档定时器）：
- 黑名单表 `pruneExpired`：每 **1h** 一次（原 5min），自动清理 `expires_at <= now` 且 `block_count = 0`
  的计数短记录；`block_count > 0` 的惯犯档案保留。删除延迟一档不影响任何判定（`isBlocked`
  只看 `block_count > 0`）。
- 内存 pos/neg 缓存清扫：每 5min 一次，纯本地无 DB。
- `honeypot_hits` 蜜罐命中清理：每 24h 一次（保留 90 天，低频即可）。

## 公众号登录强制认证（写死强制，无开关）

第三个加固方案：所有 `POST /api/search` / `GET /api/search` 都必须带 `wxauth-token` cookie，未带 → 401 "wx auth required"。

代码位置：`server/utils/wxAuthCheck.ts`（校验实现）+ `server/utils/requireAuth.ts`（`requireWxAuth` 入口拦截）。

**2026-08-26 起写死强制**：不再有 `WX_AUTH_ENFORCE` 环境变量，所有部署（主站 + fork 站）生产环境恒强制；本地 `npm run dev`（import.meta.dev）自动放行。前端 `useWxAuth.ts` 同步恒 `required`（弹窗不可关闭）——前端拦截 + 后端 401 双保险，无需任何部署配置。

### 副作用预警

- 未关注公众号的真人用户直接 401，体验影响大（这是产品设计，不是 bug）
- fork 站在自己域名完成一次关注+验证码后，cookie 写在自己域名（1 年有效），后续搜索静默放行、不再弹
- 小程序与网页端统一走 wx-auth 认证（见下方"小程序登录"章节）：小程序带 `Authorization: Bearer <wx-auth token>`，`requireWxAuth` 转发 wx-auth `/api/auth/check` 校验，有效放行、无效 401
- **wx-auth 服务故障 → fail-closed（拒绝）**：宁可误伤，不裸奔（2026-08-26 用户拍板，之前是降级放行）

## 小程序登录（2026-08-28 起统一走 wx-auth）

### 背景

公众号 openid 与小程序 openid 不是同一个（个人订阅号未认证，拿不到 unionid），无法打通。最初 panhub 自建了一套小程序登录（`/api/mp/login` code2session 换 openid + 本地 `mp_token` 表签发 Bearer token），2026-08-28 下线，登录统一收敛到 wx-auth 服务（全站唯一登录通道），panhub 不再持有微信密钥、不再自签 token。

### 流程

```
小程序 wx.login() → code
  ↓ POST https://wx-auth.shenzjd.com/api/auth/mp-login { code }
wx-auth 用小程序 appid+secret 调微信 code2session → openid
  ↓ wx-auth 签发 token（身份 mp:<openid>，active=true）
返回 { token, openid }
  ↓
小程序后续请求带 Authorization: Bearer <token>
  ↓ requireWxAuth → wxAuthCheck 转发 wx-auth /api/auth/check（10min 缓存）
authenticated=true → 放行（user 带 openid / mpOpenid 身份）
authenticated=false → 401（小程序端清 token 重新走 mp-login）
```

### 环境变量

```bash
# wx-auth 认证服务地址（小程序 Bearer 与网页端 cookie 均转发该校验）
WX_AUTH_API_BASE=https://wx-auth.shenzjd.com
```

（小程序的 MP_APPID / MP_SECRET 已迁到 wx-auth 项目配置，panhub 不再需要。）

### 安全设计

- **登录权威在 wx-auth**：token 由 wx-auth 签发/吊销，panhub 只做转发校验，无本地凭证存储（原 `mp_token` 表已废弃，可择期清理）
- **fail-closed**：wx-auth 不可达/超时/非 2xx → 拒绝，不降级放行
- **10min 跨请求缓存**：同一 token 短 TTL 内不重复打远程（含 false 结果；缓存条目带 user 身份）
- 用户资料（昵称/头像）已收编 wx-auth 账号系统（2026-08-29，user_avatars / nickname），本项目不再存储；原 `mp_user` 表已废弃删除

### ⚠️ 上线前必做：本地验证手册

本地 dev（import.meta.dev）自动放行强制校验，要完整验证鉴权链路需让 dev server 走校验分支——用本地 mock wx-auth 服务配合：

#### 步骤 1：启动本地 mock wx-auth 服务

```bash
node scripts/mock-wx-auth.mjs &
# [mock-wx-auth] listening on http://localhost:8899
# [mock-wx-auth] 白名单 token: test-fake-token  openid: test-fake-openid
```

默认会接受 `Cookie: wxauth-token=test-fake-token` 当作"已登录真人"。要扩展白名单，创建 `scripts/.wx-auth-mock.json`：

```json
{
  "tokens": ["test-fake-token", "browser-copied-real-token"],
  "openids": ["test-fake-openid"]
}
```

#### 步骤 2：启动 dev server（指向 mock）

```bash
WX_AUTH_API_BASE=http://localhost:8899 npm run dev
```

#### 步骤 3：本地 curl 验证四种场景

```bash
# A. 已登录 token → 应 200 + 搜索结果
curl -i -H "Cookie: wxauth-token=test-fake-token" \
  'http://localhost:4000/api/search?kw=凡人修仙传'

# B. 无 cookie → 应 401 wx auth required
curl -i 'http://localhost:4000/api/search?kw=凡人修仙传'

# C. 错误 token → 应 401 + 累积 IP bad_term
curl -i -H "Cookie: wxauth-token=garbage" \
  'http://localhost:4000/api/search?kw=凡人修仙传'

# D. Bearer 凭证（小程序，wx-auth /api/auth/mp-login 签发）→ 需有效 token 才 200
curl -i -H 'Authorization: Bearer <有效token>' \
  'http://localhost:4000/api/search?kw=凡人修仙传'
#    无效 token → 401（不再像以前随便填就放行）
```

**预期**：A=D=200 且有搜索结果，B=C=401。如果 A 失败 → 调 mock 白名单 + 确认 `WX_AUTH_API_BASE` 指向 mock，调查通过路径。

#### 步骤 4：试产前再用真实 cookie 测一次

复制浏览器真实登录态的 `wxauth-token`，修改 `scripts/.wx-auth-mock.json` 加上这个 token，重启 mock 服务，然后 curl 复测。验证走真实 `https://wx-auth.shenzjd.com` 时也没问题（默认 `WX_AUTH_API_BASE` 不设也能跑）。

### 部署

写死强制后无需任何额外配置：

- **Worker**：旧 `wrangler secret put WX_AUTH_ENFORCE=1` 已无作用，可直接忽略/删除（代码不再读该变量）
- **Docker**：服务器 .env 里的 `WX_AUTH_ENFORCE=1` 同样无作用，无感
- 新代码部署后即全部强制生效

### 性能开销

每次搜索多 1 次 `https://wx-auth.shenzjd.com/api/auth/check` 调用（5s timeout），但同一 token 10min 内第二次起走内存缓存（`verifyWxAuthOnceCached`），不再打远程；wx-auth 服务故障 → fail-closed 拒绝（2026-08-26 用户拍板）。

## 测试

```bash
npx vitest run test/unit/botDefense.test.ts
```

10 用例覆盖 isBlocked 缓存、recordRejection 阈值、滑动窗口、Turso 不可用降级。
