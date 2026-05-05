FROM zepai/knowledge-graph-mcp:latest

RUN pip install --no-cache-dir jq 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/* 2>/dev/null || \
    apk add --no-cache jq 2>/dev/null || true

# Replace the upstream MCP server with our patched version (binds to 0.0.0.0
# instead of 127.0.0.1 so cross-container connections work)
COPY graphiti_mcp_server.py /app/mcp_server/graphiti_mcp_server.py

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
