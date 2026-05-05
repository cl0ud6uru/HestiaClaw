#!/bin/sh
set -e

OPTIONS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

PASSWORD=$(opt password)
PASSWORD="${PASSWORD:-changeme}"
LLM_PROVIDER=$(opt llm_provider)
LLM_MODEL=$(opt llm_model)
OPENAI_API_KEY=$(opt openai_api_key)
ANTHROPIC_API_KEY=$(opt anthropic_api_key)

# --- Neo4j ---
export NEO4J_AUTH="neo4j/${PASSWORD}"
export NEO4J_dbms_security_auth__lock__time=0
export NEO4J_HOME=/data/neo4j
mkdir -p /data/neo4j

echo "Starting Neo4j..."
neo4j console &

echo "Waiting for Neo4j bolt port..."
retries=0
until nc -z localhost 7687 2>/dev/null; do
  retries=$((retries + 1))
  if [ $retries -ge 120 ]; then
    echo "Neo4j not ready after 120s, exiting"
    exit 1
  fi
  sleep 1
done
echo "Neo4j port open — waiting 10s for full initialization..."
sleep 10

# --- Graphiti ---
export NEO4J_URI="bolt://localhost:7687"
export NEO4J_USER="neo4j"
export NEO4J_PASSWORD="${PASSWORD}"
export OPENAI_API_KEY
export ANTHROPIC_API_KEY

mkdir -p /data
cat > /data/graphiti_config.yaml << EOF
server:
  transport: "http"
  host: "0.0.0.0"
  port: 8000

llm:
  provider: "${LLM_PROVIDER:-openai}"
  model: "${LLM_MODEL:-gpt-5-mini}"
  max_tokens: 4096

  providers:
    openai:
      api_key: \${OPENAI_API_KEY}
    anthropic:
      api_key: \${ANTHROPIC_API_KEY}

embedder:
  provider: "openai"
  model: "text-embedding-3-small"
  dimensions: 1536

  providers:
    openai:
      api_key: \${OPENAI_API_KEY}

database:
  provider: "neo4j"

  providers:
    neo4j:
      uri: \${NEO4J_URI}
      username: \${NEO4J_USER}
      password: \${NEO4J_PASSWORD}
      database: neo4j
      use_parallel_runtime: false

graphiti:
  group_id: hestia_user
  entity_types:
    - name: "Preference"
      description: "User preferences, choices, opinions, or selections"
    - name: "Requirement"
      description: "Specific needs, features, or functionality that must be fulfilled"
    - name: "Procedure"
      description: "Standard operating procedures and sequential instructions"
    - name: "Location"
      description: "Physical or virtual places where activities occur"
    - name: "Event"
      description: "Time-bound activities, occurrences, or experiences"
    - name: "Organization"
      description: "Companies, institutions, groups, or formal entities"
    - name: "Document"
      description: "Information content in various forms"
    - name: "Topic"
      description: "Subject of conversation, interest, or knowledge domain"
    - name: "Object"
      description: "Physical items, tools, devices, or possessions"
EOF

echo "Starting Graphiti MCP server..."
PYTHON=/opt/graphiti-venv/bin/python

if [ ! -x "$PYTHON" ]; then
  echo "Graphiti Python runtime is missing or not executable: $PYTHON"
  exit 1
fi

if ! "$PYTHON" -c "import graphiti_core" 2>/tmp/graphiti_import_error.log; then
  echo "Graphiti Python runtime cannot import graphiti_core. Build dependencies are incomplete."
  cat /tmp/graphiti_import_error.log
  exit 1
fi

exec "$PYTHON" /app/mcp/src/graphiti_mcp_server.py --config /data/graphiti_config.yaml
