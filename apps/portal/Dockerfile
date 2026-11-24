# Build context: repository root (docker build -f apps/portal/Dockerfile .)
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/portal...
RUN pnpm --filter @yoda/portal build

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/portal/.output ./.output
USER node
EXPOSE 3000
# Runtime config: NUXT_CORE_URL, NUXT_PUBLIC_KEYCLOAK_URL / _REALM / _CLIENT_ID.
CMD ["node", ".output/server/index.mjs"]
