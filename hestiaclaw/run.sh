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
BOOTSTRAP_ADMIN_PASSWORD=$(opt admin_password)
if [ -z "$BOOTSTRAP_ADMIN_PASSWORD" ]; then
  BOOTSTRAP_ADMIN_PASSWORD=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | cut -c1-16 || date +%s | cut -c1-16)
  echo "[auth] No admin_password set — generated temporary password: ${BOOTSTRAP_ADMIN_PASSWORD}"
  echo "[auth] Set admin_password in the add-on configuration to use a fixed password."
fi
export BOOTSTRAP_ADMIN_PASSWORD

# Home Assistant connection
# Prefer an explicit long-lived token from config; fall back to the Supervisor token
export HA_URL="http://homeassistant:8123"
HA_TOKEN_CONFIG=$(opt ha_token)
if [ -n "$HA_TOKEN_CONFIG" ]; then
  export HA_TOKEN="$HA_TOKEN_CONFIG"
  echo "[ha] Using long-lived access token from add-on config"
else
  export HA_TOKEN="${SUPERVISOR_TOKEN}"
  echo "[ha] Using Supervisor token (set ha_token in config to use a long-lived token)"
fi
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

# Wait for ha-mcp to accept connections (any HTTP response means it's up)
echo "[init] Waiting for ha-mcp to start..."
i=0
until curl -s -o /dev/null http://localhost:8086/mcp || [ "$i" -ge 30 ]; do
  i=$((i+1))
  sleep 1
done
if [ "$i" -ge 30 ]; then
  echo "[init] Warning: ha-mcp did not respond within 30s, starting anyway"
else
  echo "[init] ha-mcp ready after ${i}s"
fi

# Build agent.config.json from options and write to /data (persisted).
# The core system prompt (memory + Home Assistant policy) is built into the
# app; SOUL.md is the supported per-install customization layer.
if [ -n "$(opt system_prompt)" ]; then
  echo "[agent] system_prompt add-on option is deprecated and ignored; edit data/SOUL.md from the Hestia settings panel for per-install customization."
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
  "harness": {
    "approvals": true,
    "approvalTimeoutMs": 60000,
    "compactionEnabled": true,
    "contextMaxMessages": 40,
    "systemPromptLocked": true
  },
  "mcpServers": {
    ${GRAPHITI_BLOCK}
    "home-assistant": { "url": "http://localhost:8086/mcp", "role": "home-assistant", "modelVisible": false }
  }
}
EOF

# Symlink into /app so the server finds it
ln -sf /data/agent.config.json /app/agent.config.json

# HA Voice Agent token — authenticates the HA custom component against this server.
# Prefer an explicit value from addon config; otherwise generate and persist one.
HESTIA_VOICE_TOKEN=$(opt hestia_voice_token)
if [ -z "$HESTIA_VOICE_TOKEN" ]; then
  TOKEN_FILE=/data/hestia_voice_token
  if [ -f "$TOKEN_FILE" ]; then
    HESTIA_VOICE_TOKEN=$(cat "$TOKEN_FILE")
  else
    HESTIA_VOICE_TOKEN=$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' || date +%s%N | sha256sum | cut -c1-32)
    echo "$HESTIA_VOICE_TOKEN" > "$TOKEN_FILE"
  fi
fi
export HESTIA_VOICE_TOKEN

# Install the Hestia Conversation custom component into HA's config directory.
# Requires config:rw in the addon map. HA Core must be restarted once after first install.
HA_CUSTOM_COMPONENTS_DIR="/config/custom_components"
HESTIA_COMPONENT_DEST="${HA_CUSTOM_COMPONENTS_DIR}/hestia_conversation"
if [ -d "$HA_CUSTOM_COMPONENTS_DIR" ]; then
  mkdir -p "$HESTIA_COMPONENT_DEST"
  cp -r /app/ha_component/hestia_conversation/. "$HESTIA_COMPONENT_DEST/"
  echo "[ha-voice] Hestia Conversation component installed at ${HESTIA_COMPONENT_DEST}"
  echo "[ha-voice] If this is a first-time install, restart Home Assistant Core to activate it."

  # Notify HA Core via the Supervisor discovery API so the integration auto-appears.
  # Retry with exponential backoff — HA Core may not be fully ready at addon startup.
  DISCOVERY_BODY="{\"service\": \"hestia_conversation\", \"config\": {\"url\": \"http://localhost:3001\", \"token\": \"${HESTIA_VOICE_TOKEN}\"}}"
  _delay=2
  _attempt=1
  _max_attempts=5
  _discovered=0
  while [ "$_attempt" -le "$_max_attempts" ]; do
    _code=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$DISCOVERY_BODY" \
      http://supervisor/discovery 2>/dev/null || echo "000")
    if [ "$_code" = "200" ] || [ "$_code" = "201" ]; then
      echo "[ha-voice] Supervisor discovery registered (attempt ${_attempt}) — HA will prompt to configure Hestia Conversation."
      _discovered=1
      break
    fi
    echo "[ha-voice] Discovery attempt ${_attempt}/${_max_attempts} returned HTTP ${_code}, retrying in ${_delay}s..."
    sleep "$_delay"
    _delay=$((_delay * 2))
    _attempt=$((_attempt + 1))
  done
  if [ "$_discovered" = "0" ]; then
    echo "[ha-voice] Supervisor discovery failed after ${_max_attempts} attempts. Restart the addon to retry."
  fi
else
  echo "[ha-voice] /config not mounted — skipping custom component install (config:rw map required)"
fi

exec node /app/server/index.js
