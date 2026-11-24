# Build context: repository root (docker build -f apps/core/Dockerfile .)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/core...
RUN pnpm --filter @yoda/core build
RUN pnpm --filter @yoda/core --prod --ignore-scripts deploy --legacy /out \
 && cp -r apps/core/dist apps/core/drizzle /out/

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
USER node
EXPOSE 4000
# Configuration (DATABASE_URL, OIDC_*, ...) comes from the environment at runtime.
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
