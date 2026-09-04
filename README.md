# PanHub · 全网最全的网盘搜索

> 一个搜索框，搜遍全网网盘资源 —— 即搜即得、聚合去重、轻量部署

**在线体验**：<https://panhub.shenzjd.com>

## ✨ 核心特性

- **多源聚合**：80+ Telegram 频道 + 20+ 第三方插件，聚合去重、智能排序、插件熔断隔离
- **影视榜单**：豆瓣 12 分类，点击即可一键搜索
- **链接探活**：服务端检测失效 / 需密码链接，自动标记角标
- **实时热搜**：聚合全网搜索词，词云展示 + 每日榜单
- **多端部署**：Docker / Vercel / Cloudflare Workers

## 🚀 快速开始

```bash
# Docker（数据持久化）
docker run -d -p 4000:4000 -v /root/panhub/data:/app/data \
  ghcr.io/wu529778790/panhub.shenzjd.com:latest
```

## ⚡ 一键部署

| 平台 | 部署方式 |
|------|---------|
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fwu529778790%2Fpanhub.shenzjd.com&project-name=panhub) |
| Cloudflare Workers | [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fwu529778790%2Fpanhub.shenzjd.com) |

> Cloudflare Workers 构建命令使用 `npm run build:cf`（Nitro Cloudflare 预设）。
> 部署环境变量参考 `.env.example`（复制为 `.env` 后修改）。

- 本地开发：`npm install && npm run dev`；测试：`npm test`

## 📦 支持平台

阿里云盘 / 夸克 / 百度网盘 / 115 / 迅雷 / UC / 天翼云盘 / 123 网盘 / 移动云盘 / 磁力链接

## 🛡️ 免责声明

- 不存储、不传播任何受版权保护的内容；资源链接均来自公开网络
- 请遵守当地法律法规与平台使用条款；侵权问题请联系源站处理

## 🛡️ 运维

- [Bot 防御与黑名单运维](./docs/bot-defense-and-tuning.md)：IP 黑名单机制、公众号登录强制认证说明、手工解封 SQL

## 📄 版权声明

Copyright © 2025-2026 shenzjd. All rights reserved.

本仓库代码仅供学习参考，未经授权禁止用于任何商业用途或二次分发。
