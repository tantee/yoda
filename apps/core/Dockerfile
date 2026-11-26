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
# Host-side admin commands: docker compose exec core yoda-admin <command> (setup-token, reset-break-glass, status).
RUN printf '#!/bin/sh\nexec node /app/dist/yoda-admin.js "$@"\n' > /usr/local/bin/yoda-admin && chmod 0755 /usr/local/bin/yoda-admin
USER node
EXPOSE 4000
# Configuration (DATABASE_URL, OIDC_*, ...) comes from the environment at runtime.
# The server migrates on start unless MIGRATE_ON_START=false; production compose runs `node dist/migrate.js`
# once in its `migrate` service instead.
CMD ["node", "dist/server.js"]
