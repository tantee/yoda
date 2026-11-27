# Build context: repository root (docker build -f apps/runner/Dockerfile .)
# Base images pinned by digest, the tag kept beside it for reading; bump both: docs/releasing.md, "Pinned build inputs".
FROM node:22.23.5-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @yoda/runner...
RUN pnpm --filter @yoda/runner build
RUN pnpm --filter @yoda/runner --prod --ignore-scripts deploy --legacy /out \
 && cp -r apps/runner/dist /out/

FROM node:22.23.5-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
# Pinned Claude Code (the version the runner's flags were checked against). Bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.332
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
# Git asks this for clone / push credentials: YODA_GIT_USERNAME / YODA_GIT_PASSWORD from the environment
# (the runner removes both from the agent's environment). Or mount a credential helper instead.
RUN printf '%s\n' '#!/bin/sh' 'case "$1" in Username*) printf "%s\n" "${YODA_GIT_USERNAME:-oauth2}" ;; *) printf "%s\n" "${YODA_GIT_PASSWORD:-}" ;; esac' \
      > /usr/local/bin/yoda-git-askpass \
 && chmod 755 /usr/local/bin/yoda-git-askpass
ENV NODE_ENV=production \
    GIT_ASKPASS=/usr/local/bin/yoda-git-askpass \
    GIT_TERMINAL_PROMPT=0
WORKDIR /app
COPY --from=build /out/ ./
RUN chmod 755 /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/yoda-runner \
 && mkdir -p /home/node/.local/share/yoda-runner /home/node/.config/yoda-runner \
 && chown -R node:node /home/node
USER node
# No secrets in the image. At runtime: YODA_CORE_URL, YODA_RUNNER_TOKEN, ANTHROPIC_API_KEY, git credentials,
# and a config file (repos with cloneUrl, executor settings) at /home/node/.config/yoda-runner/config.json.
VOLUME ["/home/node/.local/share/yoda-runner"]
ENTRYPOINT ["yoda-runner"]
CMD ["start"]
