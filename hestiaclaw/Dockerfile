# Stage 1: Extract ha-mcp binary from upstream image
FROM ghcr.io/homeassistant-ai/ha-mcp:latest AS ha-mcp-src

# Stage 2: Build the React frontend
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js eslint.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

# Stage 3: Production runtime
FROM node:22-alpine

RUN apk add --no-cache jq curl python3 uv

# Copy ha-mcp binary (path may vary by image version — verify with:
#   docker run --rm --entrypoint=sh ghcr.io/homeassistant-ai/ha-mcp:latest -c "which ha-mcp-web || find / -name ha-mcp-web 2>/dev/null"
COPY --from=ha-mcp-src /usr/local/bin/ha-mcp-web /usr/local/bin/ha-mcp-web

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server ./server

COPY hestiaclaw/run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3001

CMD ["/run.sh"]
