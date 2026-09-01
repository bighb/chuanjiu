# ───────── 构建阶段 ─────────
FROM node:22-alpine AS build
WORKDIR /app

# corepack 按 package.json 的 packageManager 字段激活对应版本的 pnpm
RUN corepack enable

# 先只拷贝依赖清单，让依赖层能被缓存
# pnpm-workspace.yaml 里的 allowBuilds（esbuild/sharp 构建脚本批准）也要一起拷进来，
# 否则容器里非交互式 pnpm install 会因为"未批准构建脚本"直接失败
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build          # 内容 schema 校验在这一步；不过就构建失败

# ───────── 运行阶段 ─────────
FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# 关键：产物放进 bbq/ 子目录，让容器的 URL 空间与生产一致（02 文档 D-9）
COPY --from=build /app/dist /usr/share/nginx/html/bbq

EXPOSE 80
