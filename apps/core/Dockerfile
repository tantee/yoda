# Build context: repository root (docker build -f apps/core/Dockerfile .)
# Base images pinned by digest, the tag kept beside it for reading; bump both: docs/releasing.md, "Pinned build inputs".
FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/core...
RUN pnpm --filter @yoda/core build
RUN pnpm --filter @yoda/core --prod --ignore-scripts deploy --legacy /out \
 && cp -r apps/core/dist apps/core/drizzle /out/

FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
# Host-side admin commands: docker compose exec core yoda-admin <command> (setup-token, create-break-glass,
# reset-break-glass, status, rotate-master-key, recovery-kit, reset-master-key, recovery on|off; `yoda-admin` alone
# lists them).
RUN printf '#!/bin/sh\nexec node /app/dist/yoda-admin.js "$@"\n' > /usr/local/bin/yoda-admin && chmod 0755 /usr/local/bin/yoda-admin
USER node
EXPOSE 4000
# Configuration (DATABASE_URL, OIDC_*, ...) comes from the environment at runtime.
# The server migrates on start unless MIGRATE_ON_START=false; production compose runs `node dist/migrate.js`
# once in its `migrate` service instead.
CMD ["node", "dist/server.js"]
