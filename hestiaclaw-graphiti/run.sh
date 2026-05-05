#!/bin/sh
set -e

OPTIONS=/data/options.json

opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

NEO4J_URI=$(opt neo4j_uri)
NEO4J_USER=$(opt neo4j_user)
NEO4J_PASSWORD=$(opt neo4j_password)
LLM_PROVIDER=$(opt llm_provider)
LLM_MODEL=$(opt llm_model)
OPENAI_API_KEY=$(opt openai_api_key)
ANTHROPIC_API_KEY=$(opt anthropic_api_key)

export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"
export NEO4J_PASSWORD
export OPENAI_API_KEY
export ANTHROPIC_API_KEY

# Write graphiti config to /data so it persists and can be inspected
mkdir -p /data
cat > /data/graphiti_config.yaml << EOF
server:
  transport: "http"
  host: "0.0.0.0"
  port: 8000

llm:
  provider: "${LLM_PROVIDER:-openai}"
  model: "${LLM_MODEL:-gpt-4o-mini}"
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

# Wait for Neo4j to accept connections before starting
NEO4J_HOST=$(echo "${NEO4J_URI}" | sed 's|bolt://||' | cut -d: -f1)
NEO4J_PORT=$(echo "${NEO4J_URI}" | sed 's|bolt://||' | cut -d: -f2)
NEO4J_PORT="${NEO4J_PORT:-7687}"
echo "Waiting for Neo4j at ${NEO4J_HOST}:${NEO4J_PORT}..."
retries=0
until nc -z "${NEO4J_HOST}" "${NEO4J_PORT}" 2>/dev/null; do
  retries=$((retries + 1))
  if [ $retries -ge 60 ]; then
    echo "Neo4j not reachable after 60s, starting anyway"
    break
  fi
  sleep 1
done
# Port is open but Neo4j needs a few more seconds to finish auth initialization
echo "Neo4j port open, waiting 10s for full initialization..."
sleep 10
echo "Starting Graphiti"

exec /app/mcp/.venv/bin/python /app/mcp/src/graphiti_mcp_server.py --config /data/graphiti_config.yaml
