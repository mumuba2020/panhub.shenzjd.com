// https://nuxt.com/docs/api/configuration/nuxt-config
import channelsConfig from "./config/channels.json";

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  // admin-shared.css 只在 layouts/admin.vue 里按需引入（admin 专属），
  // 不再全局注入——普通用户访问客户端页面不加载任何 admin 代码与样式
  // 2026-09-01 后台管理接入 TDesign（tdesign.tencent.com）：
  // 官方 Nuxt 模块，自动按需导入组件/图标/CSS 变量，SSR 友好。
  // 组件按 t- 前缀解析，客户端页面未使用 t- 组件，不增加客户端包体。
  modules: ["@tdesign-vue-next/nuxt"],
  tdesign: {
    // 关掉模块的全局样式注入：es/style/index.css（token + 基础 reset，约 19KB）
    // 会进 nuxt.options.css 全局数组，客户端页面也会下载。
    // 改由 layouts/admin.vue 自行 import，只随 /admin 路由加载。
    importVariables: false,
  },
  devServer: {
    port: 4000,
  },
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "PanHub · 全网最全的网盘搜索",
      titleTemplate: "%s · PanHub",
      meta: [
        {
          name: "viewport",
          content:
            "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
        },
        {
          name: "description",
          content:
            "PanHub：聚合阿里云盘、夸克、百度网盘、115、迅雷等平台的全网最全网盘搜索工具，实时检索分享资源，快速、高效。",
        },
        {
          name: "keywords",
          content:
            "网盘搜索, 阿里云盘, 夸克, 百度网盘, 115, 迅雷, 资源搜索, 盘搜, panhub, 网盘聚合搜索",
        },
        { name: "theme-color", content: "#111111" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "PanHub" },
      ],
      link: [
        {
          rel: "icon",
          type: "image/svg+xml",
          href: "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/imgx-20260828-151509-5bk7.svg",
        },
      ],
    },
  },
  nitro: {
    // 根据环境变量动态选择部署预设
    preset: process.env.VERCEL
      ? "vercel"
      : process.env.NITRO_PRESET || "node-server",
    // Vercel serverless function 最大执行时间（Pro: 60s, Hobby: 10s）
    vercel: {
      functions: {
        maxDuration: 60,
      },
    },
  },
  routeRules: {
    // 热搜接口不缓存，否则 POST 写入后 GET 仍返回旧数据
    "/api/hot-searches": { swr: false, cache: false },
    // 首页统计带（2026-09-01 替代 hot-calendar 的页头指标）：走 service 层
    // TTL 读缓存，路由层禁缓存保证数字不被 SWR 固化 1 小时
    "/api/hot-stats": { swr: false, cache: false },
    // /hot 每日榜单页已下线（2026-09-01：公开页不再展示搜索词），
    // 已收录链接 301 回首页，权重不丢
    "/hot": { redirect: { to: "/", statusCode: 301 } },
    // 豆瓣热搜允许短时缓存（服务端已有 60 分钟 cache）
    "/api/douban-hot": { swr: false, cache: false },
    // 搜索接口依赖 Cookie 鉴权，禁止缓存避免 401 被缓存
    "/api/search": { swr: false, cache: false },
    // SSE 搜索流（2026-08-24 架构改造）：长连接逐批推送，禁止缓存
    // （默认 /** swr:3600 会把流缓存成 204 空响应）
    "/api/search.stream": { swr: false, cache: false },
    // 搜索明细管理查询（2026-08-25）：敏感数据 + 需实时看到新增记录，禁缓存
    "/api/search-log": { swr: false, cache: false },
    // IP 黑名单管理查询（2026-08-25）：同样禁缓存——
    // ⚠️ 漏加此条曾导致首次 401 被 /** swr:3600 缓存 1 小时，之后请求
    // 到不了后端，用户有 token 也永远 401（管理页看不到 userinfo 调用）
    "/api/blacklist": { swr: false, cache: false },
    // 管理后台频道接口（2026-08-26）：同样禁缓存——
    // ⚠️ 与 blacklist 同坑：首次无 cookie 的 401 被 /** swr:3600 缓存，
    // 用户登录后仍命中缓存 401（"明明登录了却说没登录"）。
    // 管理员登录态（wxauth-token cookie）本身就是每请求必读的，
    // 任何缓存都会把"未登录的错误响应"或"登录前的旧响应"复用。
    "/api/admin/**": { swr: false, cache: false },
    // 链接检测接口需要读 POST body，禁止缓存避免 body 被中间件消费
    "/api/check": { swr: false, cache: false },
    // 图片代理依赖豆瓣，禁止 SWR 缓存避免错误响应被缓存
    "/api/img": { swr: false, cache: false },
    // 小程序登录接口（2026-08-28）：POST 写入 + 敏感凭证，禁缓存
    "/api/mp/**": { swr: false, cache: false },
    "/**": { swr: 3600 },
  },
  runtimeConfig: {
    // 2026-08-24：频道清单已从仓库/配置移除，改由 ChannelConfigService
    // 从 Turso 加密表拉取（见 server/core/services/channelConfigService.ts），
    // 不再注入 runtimeConfig；前端经 /api/channels 下发获取。
    defaultConcurrency: channelsConfig.defaultConcurrency,
    pluginTimeoutMs: channelsConfig.pluginTimeoutMs,
    cacheEnabled: true,
    cacheTtlMinutes: channelsConfig.cacheTtlMinutes,
    public: {
      apiBase: "/api",
      siteUrl: "https://panhub.shenzjd.com",
      // 2026-08-26：微信认证已写死强制（无开关）——不再有 wxAuthEnforce/
      // NUXT_PUBLIC_WX_AUTH_ENFORCE 配置项。前端 useWxAuth 恒 required，
      // 后端 requireWxAuth 恒拦截（详见两处代码注释）。
      // 2026-08-28：认证统一收敛到 wx-auth 服务（唯一登录通道）：
      // 小程序 Bearer token 由 wx-auth /api/auth/mp-login 签发，网页端
      // 公众号 cookie 由 wx-auth-sdk 种下，panhub 只做转发校验
      // （server/utils/wxAuthCheck.ts），不再持有微信密钥/自建登录。
    },
  },
});
