# 从仓库根目录构建：docker build -f docker/platform.Dockerfile .
FROM node:24.20.0-alpine AS build
WORKDIR /source
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/platform/package.json ./apps/platform/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/launcher/package.json ./apps/launcher/package.json
COPY packages/pi-extension/package.json ./packages/pi-extension/package.json
COPY packages/contract/package.json ./packages/contract/package.json
COPY packages/platform-http/package.json ./packages/platform-http/package.json
RUN pnpm --filter @pi-steward/platform... --filter @pi-steward/web... install --frozen-lockfile
COPY packages/contract ./packages/contract
COPY apps/platform ./apps/platform
COPY apps/web ./apps/web
RUN pnpm --filter @pi-steward/contract build && \
    pnpm --filter @pi-steward/web build && \
    pnpm --filter @pi-steward/platform build && \
    pnpm --config.inject-workspace-packages=true --filter @pi-steward/platform deploy --prod /out

FROM node:24.20.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    STEWARD_DATA_DIR=/data \
    STEWARD_WEB_DIR=/app/web \
    PORT=3000
RUN mkdir /data && chown node:node /data && chmod 700 /data
COPY --from=build --chown=node:node /out/ ./
COPY --from=build --chown=node:node /source/apps/web/dist/ ./web/
COPY --from=build --chown=node:node /source/apps/web/THIRD_PARTY_NOTICES.md ./web-THIRD_PARTY_NOTICES.md
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exitCode=1},()=>{process.exitCode=1})"
CMD ["node", "dist/index.js"]
