# Build context: repository root (docker build -f apps/portal/Dockerfile .)
# Base images pinned by digest, the tag kept beside it for reading; bump both: docs/releasing.md, "Pinned build inputs".
# The build stage runs on the builder's own platform: the output (.output, ssr: false) is plain JavaScript with no
# native modules, so it is the same for every target, and a Nuxt/Vite build under QEMU (arm64 on an amd64 runner)
# runs for hours. Only the runtime stage below is per target platform.
FROM --platform=$BUILDPLATFORM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/portal...
RUN pnpm --filter @yoda/portal build

FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/portal/.output ./.output
USER node
EXPOSE 3000
# Runtime config: NUXT_CORE_URL, NUXT_PUBLIC_KEYCLOAK_URL / _REALM / _CLIENT_ID.
CMD ["node", ".output/server/index.mjs"]
