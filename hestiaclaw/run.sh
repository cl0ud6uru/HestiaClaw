#!/bin/sh
set -e

OPTIONS=/data/options.json

# Helper: read a string option, defaulting to "" if null/missing
opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

# LLM provider & model
export PROVIDER=$(opt provider)
export MODEL=$(opt model)
export ANTHROPIC_API_KEY=$(opt anthropic_api_key)
export OPENAI_API_KEY=$(opt openai_api_key)

# Voice
export ELEVENLABS_API_KEY=$(opt elevenlabs_api_key)
export ELEVENLABS_DEFAULT_VOICE_ID=$(opt elevenlabs_default_voice_id)

# Graph / memory (optional)
export NEO4J_URI=$(opt neo4j_uri)
export NEO4J_USER=$(opt neo4j_user)
export NEO4J_PASSWORD=$(opt neo4j_password)
export GRAPHITI_URL=$(opt graphiti_url)

# Web search (optional)
export SEARXNG_URL=$(opt searxng_url)

# Auth
SESSION_SECRET=$(opt session_secret)
export SESSION_SECRET=${SESSION_SECRET:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)}
export BOOTSTRAP_ADMIN_USERNAME=$(opt admin_username)
export BOOTSTRAP_ADMIN_PASSWORD=$(opt admin_password)

# Home Assistant connection — provided automatically by Supervisor
export HA_URL="http://homeassistant:8123"
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HOMEASSISTANT_URL="${HA_URL}"
export HOMEASSISTANT_TOKEN="${HA_TOKEN}"

# App settings
export PORT=3001
export NODE_ENV=production
export DATABASE_PATH=/data/hestia.sqlite
export TRUST_PROXY=1

# Start ha-mcp as a background service on its default port (8086)
HOMEASSISTANT_URL="${HA_URL}" \
  HOMEASSISTANT_TOKEN="${HA_TOKEN}" \
  ENABLE_WEBSOCKET=true \
  LOG_LEVEL=INFO \
  /usr/local/bin/ha-mcp-web &

# Wait briefly for ha-mcp to be ready
sleep 2

# Build agent.config.json from options and write to /data (persisted)
SYSTEM_PROMPT=$(opt system_prompt)
if [ -z "$SYSTEM_PROMPT" ]; then
  SYSTEM_PROMPT="You are Hestia, an intelligent home assistant. You have access to tools to control and monitor the home via Home Assistant. Be concise, helpful, and proactive about suggesting automations and improvements."
fi

# Conditionally add graphiti to mcpServers if a URL is configured
if [ -n "$GRAPHITI_URL" ]; then
  GRAPHITI_BLOCK="\"graphiti\": { \"url\": \"${GRAPHITI_URL}\" },"
else
  GRAPHITI_BLOCK=""
fi

cat > /data/agent.config.json << EOF
{
  "provider": { "type": "${PROVIDER:-anthropic}", "model": "${MODEL:-claude-opus-4-7}" },
  "systemPrompt": $(jq -n --arg s "$SYSTEM_PROMPT" '$s'),
  "harness": {
    "approvals": true,
    "approvalTimeoutMs": 60000,
    "compactionEnabled": true,
    "contextMaxMessages": 40
  },
  "mcpServers": {
    ${GRAPHITI_BLOCK}
    "home-assistant": { "url": "http://localhost:8086/mcp" }
  }
}
EOF

# Symlink into /app so the server finds it
ln -sf /data/agent.config.json /app/agent.config.json

exec node /app/server/index.js
