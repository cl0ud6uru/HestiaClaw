# Stage 1: Source the ha-mcp app (Python src + venv)
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

WORKDIR /app

# Copy ha-mcp's entire /app (src + venv) into our /app.
# The ha-mcp-web script has shebang #!/app/.venv/bin/python3 and the editable
# install finder maps ha_mcp → /app/src/ha_mcp, so both paths must stay at /app.
# Our files (server/, dist/, node_modules/, package.json) don't conflict.
COPY --from=ha-mcp-src /app /app
RUN ln -s /app/.venv/bin/ha-mcp-web /usr/local/bin/ha-mcp-web

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY skills ./skills

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3001

CMD ["/run.sh"]
