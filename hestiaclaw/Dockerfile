# Stage 1: Source the ha-mcp Python package
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

# Install ha-mcp into a clean venv. The upstream image has no pyproject.toml so we
# can't do a source install — instead install its PyPI deps, copy the ha_mcp package
# directly into site-packages, and write the entry point script ourselves.
COPY --from=ha-mcp-src /app/src/ha_mcp /opt/ha-mcp-src/ha_mcp
RUN uv python install 3.13 && \
    uv venv /opt/ha-mcp-venv --python 3.13 && \
    uv pip install --python /opt/ha-mcp-venv/bin/python \
        "fastmcp==3.2.4" \
        "httpx[socks]==0.28.1" \
        "pydantic==2.13.2" \
        "python-dotenv==1.2.2" \
        "truststore==0.10.4" \
        "websockets==16.0" \
        "cryptography==46.0.7" && \
    SITE=$(/opt/ha-mcp-venv/bin/python -c 'import site; print(site.getsitepackages()[0])') && \
    cp -r /opt/ha-mcp-src/ha_mcp "$SITE/" && \
    printf '#!/opt/ha-mcp-venv/bin/python3\nfrom ha_mcp.__main__ import main_web\nimport sys; sys.exit(main_web())\n' \
        > /opt/ha-mcp-venv/bin/ha-mcp-web && \
    chmod +x /opt/ha-mcp-venv/bin/ha-mcp-web && \
    ln -sf /opt/ha-mcp-venv/bin/ha-mcp-web /usr/local/bin/ha-mcp-web

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY skills ./skills
COPY ha_component ./ha_component

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3001

CMD ["/run.sh"]
