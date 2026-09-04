# 构建阶段（无 native 依赖，用 Alpine 减小体积）
FROM node:24-alpine AS builder
WORKDIR /app

# 先复制依赖文件，利用层缓存
COPY package.json package-lock.json ./

# 安装依赖
RUN npm ci

# 复制源码并构建
COPY . .
RUN NITRO_PRESET=node-server npm run build

# 运行阶段：Alpine 仅 ~50MB
FROM node:24-alpine AS runner
WORKDIR /app

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV NITRO_LOG_LEVEL=info
# 内存上限与容器 --memory 768m 对齐：V8 堆上限 512MB（堆+非堆在 768m 内安全），
# 防止 OOM 拖垮宿主机（无 swap 的 2GB 小机上内存一满直接 thrash）
ENV NODE_OPTIONS=--max-old-space-size=512

EXPOSE 4000

# 从构建阶段复制所有必要文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package.json ./

# 切换到非 root 用户
USER node

CMD ["node", "--enable-source-maps", ".output/server/index.mjs"]
