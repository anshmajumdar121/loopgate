# Loopgate public demo image: one process serves the built UI, the API and
# the WebSocket on $PORT, in LOOP_PUBLIC_DEMO mode (bundled fake LLM only,
# no keys, no connections, writes confined to /tmp). See docs/DEPLOY_DEMO.md.
#
#   docker build -t loopgate-demo .
#   docker run --rm -p 10000:10000 loopgate-demo     → http://localhost:10000

# Node 24 / npm 11: the lock files were generated with npm 11; npm 10 (Node 22)
# rejects them in `npm ci` over an optional nested dependency.
FROM node:24-bookworm-slim AS build
# The runtime check (headless Chromium) is disabled in demo mode.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY ui/package.json ui/package-lock.json ui/
RUN cd ui && npm ci --no-audit --no-fund
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --no-audit --no-fund
COPY ui ui
COPY backend backend
RUN cd ui && npx vite build
RUN cd backend && npx tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    LOOP_PUBLIC_DEMO=1 \
    LOOP_HOST=0.0.0.0 \
    PORT=10000
WORKDIR /app/backend
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/package.json /app/backend/llm-agent.mjs /app/backend/cli-tools.mjs ./
COPY --from=build /app/backend/scripts/demo ./scripts/demo
COPY --from=build /app/ui/dist /app/ui/dist
COPY loop-constraints.md /app/
USER node
EXPOSE 10000
CMD ["node", "dist/index.js"]
