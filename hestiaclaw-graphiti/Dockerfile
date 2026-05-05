# Stage 1: grab the pre-built graphiti venv and server from the upstream image
FROM zepai/knowledge-graph-mcp:latest AS graphiti

# Stage 2: Neo4j as the base (includes JVM + GDS plugin support) with graphiti layered on top
FROM neo4j:2026-community

# Copy graphiti app (venv + server) from stage 1
COPY --from=graphiti /app /app

# The neo4j base (Debian Trixie) ships Python 3.12 and has no python3.11 package.
# The graphiti venv was built for python3.11 at /usr/local/bin/python3.11.
# Copying /usr/local from the graphiti image provides that binary and its stdlib/lib
# so the venv symlinks resolve correctly.
COPY --from=graphiti /usr/local /usr/local

# Install jq and netcat for run.sh; refresh linker cache for the copied Python lib
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq netcat-openbsd python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && ldconfig

# Build a deterministic Python environment in the final image. Do not rely on
# the upstream image's venv path; it has changed across builds.
RUN python3 -m venv /opt/graphiti-venv \
    && /opt/graphiti-venv/bin/python -m pip install --upgrade pip setuptools wheel \
    && if [ -f /app/mcp/requirements.txt ]; then \
        /opt/graphiti-venv/bin/pip install -r /app/mcp/requirements.txt; \
      elif [ -f /app/requirements.txt ]; then \
        /opt/graphiti-venv/bin/pip install -r /app/requirements.txt; \
      fi \
    && /opt/graphiti-venv/bin/pip install \
        "graphiti-core" \
        "mcp[cli]" \
        "python-dotenv" \
        "pydantic" \
        "starlette" \
        "openai" \
        "anthropic" \
        "neo4j" \
        "pyyaml"

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
