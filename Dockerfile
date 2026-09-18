# syntax=docker/dockerfile:1
# 多阶段构建：编译 TypeScript → 精简生产镜像

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
COPY migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --start-period=10s --retries=12 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/src/server.js"]
