# Stage 1: grab the pre-built graphiti venv and server from the upstream image
FROM zepai/knowledge-graph-mcp:latest AS graphiti

# Stage 2: Neo4j as the base (includes JVM + GDS plugin support) with graphiti layered on top
FROM neo4j:2026-community

# Copy graphiti app first so we can detect the Python version the venv was built with
COPY --from=graphiti /app /app

# Install the exact Python version used by the graphiti venv, plus utilities.
# Then fix the venv symlinks — they point to the graphiti image's Python path which
# doesn't exist in this base image, causing ModuleNotFoundError for graphiti_core.
RUN set -e; \
    VENV_PY=$(ls /app/mcp/.venv/lib/ | grep '^python' | head -1); \
    apt-get update; \
    apt-get install -y --no-install-recommends "${VENV_PY}" jq netcat-openbsd; \
    rm -rf /var/lib/apt/lists/*; \
    SYS_PY_BIN=$(command -v "${VENV_PY}" || echo "/usr/bin/${VENV_PY}"); \
    SYS_PY_DIR=$(dirname "${SYS_PY_BIN}"); \
    ln -sf "${SYS_PY_BIN}" /app/mcp/.venv/bin/"${VENV_PY}"; \
    ln -sf "${VENV_PY}" /app/mcp/.venv/bin/python3; \
    ln -sf "${VENV_PY}" /app/mcp/.venv/bin/python; \
    sed -i "s|^home = .*|home = ${SYS_PY_DIR}|" /app/mcp/.venv/pyvenv.cfg || true

# Neo4j settings
ENV NEO4J_PLUGINS='["graph-data-science"]'
ENV NEO4J_dbms_memory_heap_initial__size=512m
ENV NEO4J_dbms_memory_heap_max__size=1G
ENV NEO4J_dbms_memory_pagecache_size=512m
ENV NEO4J_dbms_security_auth__lock__time=0

# Patch the MCP server to bind on 0.0.0.0 for cross-container access
COPY graphiti_mcp_server.py /app/mcp/src/graphiti_mcp_server.py

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
