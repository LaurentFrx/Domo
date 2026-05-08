# ─── Build stage ───
FROM node:20-alpine AS build
WORKDIR /app

# Installer pnpm
RUN npm install -g pnpm@9

# Copier les manifests d'abord (cache Docker)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# Copier le code et builder
COPY . .
RUN pnpm build

# ─── Runtime stage ───
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini && \
    addgroup -g 1001 -S app && \
    adduser -S app -u 1001 -G app

COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/ || exit 1
