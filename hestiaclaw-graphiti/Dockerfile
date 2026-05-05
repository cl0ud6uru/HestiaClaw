# Stage 1: grab the pre-built graphiti venv and server from the upstream image
FROM zepai/knowledge-graph-mcp:latest AS graphiti

# Stage 2: Neo4j as the base (includes JVM + GDS plugin support) with graphiti layered on top
FROM neo4j:2026-community

# Install Python 3, jq, and netcat for the run script
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 jq netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Copy graphiti app (venv + server) from stage 1
COPY --from=graphiti /app /app

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
