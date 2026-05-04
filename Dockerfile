# Stage 1: build the frontend
FROM node:22-alpine AS builder
WORKDIR /app
COPY hestiaclaw/package*.json ./
RUN npm ci
COPY hestiaclaw/index.html hestiaclaw/vite.config.js hestiaclaw/eslint.config.js ./
COPY hestiaclaw/src ./src
COPY hestiaclaw/public ./public
RUN npm run build

# Stage 2: production image (no devDeps, just built assets + server)
FROM node:22-alpine
RUN apk add --no-cache curl python3 && \
    curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
COPY hestiaclaw/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY hestiaclaw/server ./server
COPY hestiaclaw/skills ./skills
EXPOSE 3001
CMD ["node", "server/index.js"]
