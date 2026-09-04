# PanSou (fish2018/pansou) 借鉴分析

> 分析日期：2026-08-04 · 对标仓库：https://github.com/fish2018/pansou (Go)
> 本项目：panhub.shenzjd.com (Nuxt 4 + TypeScript)

---

## 一、现状对比

| 维度 | PanSou | 本项目 | 差距 |
|---|---|---|---|
| 插件数量 | 89 个目录 | 19 个文件，**仅注册 2 个** | 严重 |
| 插件基类能力 | 双 client / 异步补偿 / 缓存注入 / 关键词过滤 | 仅 name/priority/search 空壳 | 大 |
| 排序 | 时间+关键词+插件等级 三维打分 | 仅 `sortResultsByTimeDesc` | 大 |
| 网盘类型识别 | 集中在 `util/regex_util.go` | 每个插件各写一份（重复 8+ 处） | 中 |
| 链接有效性检测 | 8 种网盘真实探活 API | 无 | 无此功能 |
| 缓存 | 分片内存+分片磁盘、延迟批量写 | UnifiedCache 单层内存 | 中 |
| 多域名容灾 | 单插件多 API 端点轮询 | 单域名硬编码 | 中 |

---

## 二、插件源实测存活情况（2026-08-04，香港 IP）

> 测试方法：真实发起搜索请求（关键词「流浪地球」，部分换「庆余年」或空查询复测），
> 在响应体中匹配网盘链接正则。**注意响应中链接常为 JSON 转义形式 `https:\/\/pan.quark.cn\/s\/xxx`，
> 匹配时必须处理 `\/`，否则会误判为「无链接」。**

### 2.1 已验证「真实产出网盘链接」——建议接入（11 个）

| 插件 | 端点 | 实测产出 | 盘型 |
|---|---|---|---|
| **melost**（影盘社） | POST `www.melost.cn/v1/search/disk` | **total=2172，单页 30 条** | 夸克 |
| **quark4k** | `quark4k.com/api/discussions`（Flarum） | **38 条** | 夸克 |
| ~~u3c3~~（2026-08-27 移除） | `u3c3u3c3.u3c3u3c3u3c3.com/?search=` | 62 条纯磁力 | 磁力 |
| ~~yunso~~（2026-08-27 移除） | POST `www.yunso.net/api/Core/search2` | 19 条但全无关（wd 参数失效） | 夸克+天翼 |
| **ouge / wanou** | `woog.nxog.eu.org/api.php/provide/vod?ac=detail&wd=` | 3 条 | UC |
| **quarktv** | `www.quarktv.com/?s=` | 有 | 夸克 |
| **dyyjpro** | `dyyjpro.com/?s=` | 有 | 夸克 |
| **jsnoteclub** | `jsnoteclub.com/?s=` | 有 | 夸克 |
| **panlian** | `pinglian.lol/?s=` | 有 | 123网盘 |
| pansearch | — | 已在用 | 多种 |
| nyaa | — | 已在用 | 磁力 |

**melost 请求样例**（关键词字段名是 `q` 不是 `kw`，写错会返回 `code:421`）：
```
POST https://www.melost.cn/v1/search/disk
Content-Type: application/json
Origin: https://www.melost.cn
Referer: https://www.melost.cn/search
{"page":1,"q":"关键词","user":"","exact":false,"user_distinct":false,
 "format":[],"share_time":"","share_year":"","size":30,"order":"","type":"",
 "search_ticket":"","exclude_user":[],
 "adv_params":{"wechat_pwd":"","search_code":"","platform":"pc","fp_data":"","automated":"0"}}
```

> ⚠️ **quark4k 的教训**：用「流浪地球」查返回 0 条，一度判为死源；换「庆余年」得 2 条、空查询得 38 条。
> **判定插件死活时必须用多个关键词交叉验证，否则会误杀。**

### 2.2 被 Cloudflare / WAF 拦截（站点活着，需绕过，12 个）

响应固定为 5700-5800 字节的 `Just a moment...` 挑战页：

`susu`、`ahhhhfs`、`alupan`、`kkmao`、`yiove`、`xiaoji`、`miaoso`、`pan666`、`bixin`、`sdso`、`ash`、`discourse(linux.do)`

- **susu 特别说明**：架构是三段式「搜索页 → 详情页 → `wp-json/b2/v1/getDownloadPageData` → JWT payload 解码取 URL」，
  我们本地 `susu.ts` 已完整实现该逻辑，但最后一段 wp-json 接口被 CF 挡住。换出口 IP 或加 CF 绕过即可复活。
- 这批需要 headless / CF 绕过 / 住宅 IP，属于 P2 之后再处理。

### 2.3 已确认死亡

- **与我们 2026-07-06 判断一致**（复测仍死）：labi（域名过期页）、duoduo（域名已变图床）、panta、xuexizhinan、jikepan、hunhepan、qupansou(502)、thepiratebay
- **本地代码中新增失效**（建议清理）：`zhizhen`、`hdr4k`、`muou`、`huban`、`shandian`
  - 注意 `huban` 真实地址带端口 `103.45.162.207:20720`（不是裸 IP），已按正确地址复测，仍不可达
- **MacCMS 系整体崩塌**：9 个 `index.php/vod/search` 型插件中，7 个源站不可达，2 个（duoduo/qingying）有页面但无网盘链接。唯一存活的是 `ouge/wanou` 用的 `api.php/provide/vod` JSON 接口
- pansou 侧其他死源：xdpan、panzun、ddys、erxiao、mikuclub、daishudj、ypfxw、yulinshufa、fox4k(401)、cyg(520)、jupansou(404)、haisou(空)、xdyh(空)、cldi(空)、feikuai、clxiong、sousou

### 2.4 数据汇总

| 类别 | 数量 |
|---|---|
| pansou 插件目录总数 | 89 |
| 域名 HTTP 200（仅代表站点活着） | 51 |
| **真实产出网盘链接（可直接接入）** | **11** |
| 被 CF/WAF 拦截（可救） | 12 |
| 确认死亡 | ~30 |

> 「51 个」是**站点存活数**，不等于可用插件数。逐个发真实搜索请求后，
> 真正能出货的是 **11 个**，另有 12 个卡在反爬上可以后续抢救。

---

## 三、值得搬过来的架构设计（按性价比排序）

### P0 — 立刻能做，收益最大

**1. 插件盘点：注册 + 新增 + 清理**

*(a) 注册本地已有但闲置的* —— `server/core/plugins/` 有 19 个实现，`services/index.ts` 只注册了 2 个。
其中 `ouge`、`wanou` 实测可用，直接注册即可。

*(b) 新增 4 个高产出插件*（按性价比排序）：

| 插件 | 为什么值得做 | 工作量 |
|---|---|---|
| **melost** | 单关键词 2172 条结果，是所有源里出货最猛的 | JSON API，1 小时 |
| **quark4k** | 38 条夸克，Flarum 标准 API 好解析 | JSON API，1 小时 |
| ~~yunso~~（2026-08-27 移除） | 19 条但全无关（wd 参数失效，返回固定推荐列表） | 返回 HTML 片段 |
| ~~u3c3~~（2026-08-27 移除） | 62 条纯磁力（产品要求不出现磁力链接） | HTML 解析 |

*(c) 清理 5 个死源文件*：`zhizhen`、`hdr4k`、`muou`、`huban`、`shandian`

做完 (a)+(b) 后活跃插件从 **2 个 → 8 个**，且新增的都是实测高产出源。

**2. 三维打分排序**（`service/search_service.go:544-586, 1512-1556`）
```
TotalScore = TimeScore + KeywordScore + PluginScore

TimeScore   : ≤1天 500 / ≤3天 400 / ≤7天 300 / ≤30天 200 / ≤90天 100 / ≤365天 50 / 更早 20 / 无时间 0
KeywordScore: 命中 ["合集","系列","全","完","最新","附","complete"] → (len - idx) * 70，最高 490
PluginScore : 等级1 → +1000 / 等级2 → +500 / 等级3 → 0 / 等级4 → -200
```
我们的 `AsyncSearchPlugin` 接口已经有 `priority()`，但从未参与排序——接上去就行。

**3. 网盘类型识别集中化**
现在 `wanou.ts` / `hdr4k.ts` / `pan666.ts` / `susu.ts` / `huban.ts` / `ouge.ts` 各写一份判断逻辑。
抽到 `server/core/utils/panLink.ts`，参考 pansou 的统一正则：
```
pan.baidu.cn | pan.quark.cn | alipan.com | aliyundrive.com | drive.uc.cn
cloud.189.cn | yun.139.com | caiyun.139.com | caiyun.feixin.10086.cn
123684/123685/123912/123pan/123592.(com|cn) | 115.com | 115cdn.com | anxia.com
pan.xunlei.com | mypikpak.com | guangyapan.com
magnet:?xt=urn:btih: | ed2k://
```

### P1 — 中等改造，明显体验提升

**4. 「4 秒快速响应 + 后台补缓存」异步机制**（`plugin/plugin.go:546-803`）
核心是**两个 HTTP client**：
- `client` 短超时（4s，`ASYNC_RESPONSE_TIMEOUT`）→ 保证接口响应速度
- `backgroundClient` 长超时（30s，`PLUGIN_TIMEOUT`）→ 真正跑完

流程：
1. 命中完整缓存 → 直接返回；若已用时超过 TTL 的 80%，后台静默刷新
2. 缓存过期但有旧结果 → 先返回旧结果，后台刷新
3. 未命中 → 后台 goroutine 跑，主线程 `select` 等 4s
4. 4s 内完成 → 返回结果，标记 `isFinal=true` 写主缓存
5. 4s 超时 → 返回空/部分缓存，后台继续，完成后按 `UniqueID` 合并新旧结果写回主缓存

这直接解决"一个慢源拖垮整个搜索"的问题。Nitro 侧可以用 `Promise.race` + 后台 `waitUntil` 实现。

**5. 单插件多 API 端点容灾**
`hunhepan` 同时挂了 `hunhepan.com` / `qkpanso.com` / `kuake8.com` 三个同构 API，任一可用即返回。
我们的插件全是单域名硬编码，域名一挂插件就死——这正是我们删掉 8 个插件的根因。
建议基类支持 `endpoints: string[]`，失败自动降级。

**6. 结果合并按完整度取优**（`search_service.go:156-197`）
同一 `UniqueID` 出现多次时，不是简单覆盖，而是按完整度打分保留信息更全的那条：
```
有链接 +10 / 有密码 +5 / +链接数量 / 有时间 +3 / +标题长度/10 / 有描述 +2 / +标签数
```

### P2 — 大功能，差异化亮点

**7. 链接有效性检测 API**（`service/check_service.go`，1576 行）
这是我们完全没有、但对用户价值最高的功能：搜出来的链接八成已失效，能标注"有效/失效/需提取码"是硬需求。

支持 8 种网盘，状态分 `ok / bad / locked / unsupported / uncertain`：

| 网盘 | 检测方式 |
|---|---|
| 阿里云盘 | `POST api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous?share_id=`<br>看 `code` 含 sharelink/notfound/cancelled/expired → bad；`share_name`/`file_count>0` → ok |
| 夸克 | ① `POST drive-h.quark.cn/1/clouddrive/share/sharepage/token` 取 stoken<br>`code=41008` → locked（需提取码），`41004/41010/41011` → bad<br>② `GET drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pwd_id=&stoken=` |
| 百度 | `share/verify?surl=&pwd=` + `share/list?shorturl=` |
| 天翼 | `POST cloud.189.cn/api/open/share/getShareInfoByCodeV2.action` |
| 123 | `GET www.123pan.com/api/share/info?shareKey=` |
| 迅雷 | `GET api-pan.xunlei.com/drive/v1/share?share_id=&pass_code=`（带 captcha signature） |
| 115 | `GET 115cdn.com/webapi/share/snap?share_code=&receive_code=` |
| 移动云盘 | `POST share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6`（有加密，见 `check_mobile_crypto.go`） |
| UC | 复用夸克逻辑 |

工程细节值得抄：
- **按状态设不同 TTL**（`ttlForState`）——bad 可以缓存久一点，uncertain 短一点
- **inflight 合并**（`acquireInflight`）——同一链接并发检测只发一次请求
- **缓存按代理隔离**——不同出口 IP 结果可能不同
- **持久化缓存**到磁盘，重启不丢

**8. 插件开发 Skill**
pansou 写了 `docs/pansou-plugin-developer-SKILL.md`（111 行）+ AI 客户端使用指南，专门给 Codex/Claude/Cursor 用，让"加一个新插件"变成一句话的事。
我们完全可以照做一个 `.workbuddy/skills/panhub-plugin-dev/`，把插件模板、类型定义、注册位置、测试方法固化进去。考虑到源站失效频繁，这个能大幅降低维护成本。

### P3 — 可选

- **分片缓存 + 延迟批量写**（`util/cache/`）：`hybrid` 策略先写内存、按批刷盘，`immediate` 立即刷。我们目前纯内存，Serverless 下重启即失效，若上磁盘缓存可参考。
- **缓存键版本化**：`GenerateCacheKeyV2`，对频道列表/插件列表做 hash，避免列表变更后命中脏缓存。
- **优先关键词可配置化**：`priorityKeywords` 目前硬编码，可以放进 `config/`。

---

## 四、建议执行顺序

| 阶段 | 事项 | 工作量 | 产出 |
|---|---|---|---|
| 1 | 清理 5 个死插件 + 注册 ouge/wanou | 0.5 天 | 插件 2→4 |
| 2 | 新增 melost + quark4k（都是 JSON API，最快） | 0.5 天 | 插件 4→6，出货量数量级提升 |
| 3 | 抽 `panLink.ts` 统一网盘识别 | 0.5 天 | 消除 8 处重复 |
| 4 | 三维打分排序 | 0.5 天 | 搜索质量明显改善 |
| 5 | 新增 yunso + u3c3（需写 HTML 解析） | 1 天 | 插件 6→8（yunso/u3c3 已于 2026-08-27 移除） |
| 6 | 基类多端点容灾 + 4 秒快速响应 | 1-2 天 | 抗源站失效 |
| 7 | 插件开发 Skill | 1 天 | 后续加插件成本大降 |
| 8 | 链接有效性检测 API（先做夸克+阿里+百度，覆盖 80%） | 3-5 天 | 差异化功能 |
| 9 | 抢救 CF 拦截的 12 个源 | 视方案而定 | 插件 8→20 |

**建议先做 1+2**：一天内插件从 2 个变 6 个，且 melost 单源的结果量就超过现有全部之和。

---

## 五、踩坑记录（复现实测时注意）

1. **JSON 转义**：多数 API 返回 `https:\/\/pan.quark.cn\/s\/xxx`，正则不处理 `\/` 会误判为无链接。这个坑让我一度误判 yunso 和 quark4k 为死源。
2. **单关键词不可靠**：quark4k 用「流浪地球」返回 0 条，换「庆余年」和空查询都有结果。判死前至少换 2 个关键词。
3. **两段/三段式抓取**：susu 这类站点搜索页只有列表，链接在详情页甚至第三层 API。只测搜索页会得到「有页面但无链接」的假阴性。
4. **端口号**：huban 真实地址是 `103.45.162.207:20720`，pansou 源码里带端口，裸 IP 测试无意义。
5. **CF 挑战页特征**：响应体固定 5700-5800 字节 + 含 `Just a moment`。按大小就能快速批量识别。
6. **限流**：连续快速请求同一站点会被限流返回空，批量测试之间要加 sleep。
