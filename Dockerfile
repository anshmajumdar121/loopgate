FROM node:22.23.3-bookworm-slim AS build

WORKDIR /app

COPY backend/package*.json backend/
RUN npm ci --prefix backend

COPY ui/package*.json ui/
RUN npm ci --prefix ui

COPY backend backend
COPY ui ui

RUN npm run build --prefix backend
RUN npm run build --prefix ui

FROM node:22.23.3-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV LOOP_HOST=0.0.0.0

COPY --from=build /app/backend ./backend
COPY --from=build /app/ui/dist ./ui/dist

VOLUME ["/app/backend/data"]
EXPOSE 3001

CMD ["node", "backend/dist/index.js"]
