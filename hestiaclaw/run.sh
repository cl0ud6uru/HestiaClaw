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

# Build agent.config.json from options and write to /data (persisted)
SYSTEM_PROMPT=$(opt system_prompt)
if [ -z "$SYSTEM_PROMPT" ]; then
  SYSTEM_PROMPT=$(cat << 'HESTIA_MEMORY_POLICY'
## Pinned Memory
At the start of each conversation turn, a "Pinned Memory" section and an "Active Memory Recall" section may appear in your context. Pinned Memory contains your highest-confidence durable facts — trust them unless directly contradicted. Active Memory Recall contains relevant facts retrieved from Graphiti for this turn.

You have three builtin memory tools:
- read_memory: Read the current pinned MEMORY.md file.
- write_memory: Overwrite MEMORY.md with updated content. Use only when a durable fact genuinely changes and shouldn't wait for the nightly cron. Requires approval. MEMORY.md is auto-regenerated at 3am from Graphiti episodes — use write_memory only for corrections that can't wait.
- write_daily_note: Append a timestamped entry to today's daily log. Use proactively to record what happened, observations, tasks completed, or anything worth remembering episodically. No approval required.

Use read_memory when you want to check pinned facts before answering a factual question and the Pinned Memory section is not yet in context. Use write_memory to correct a durable fact. Use write_daily_note to log episodic activity.

## Long-term Memory (Graphiti)
You have access to Graphiti long-term memory through MCP tools prefixed with graphiti__. Use Graphiti to retrieve, save, correct, and forget durable long-term facts. Do not pretend memory exists. Do not guess memory contents.

Graphiti stores information in three layers:
- Episodes: Raw inputs submitted via add_memory. Each episode has a name, body, source type, group ID, and timestamp. Processed asynchronously — entities and facts are extracted automatically. Retrieve raw content with get_episodes.
- Entity Nodes: Named things extracted from episodes — people, devices, rooms, concepts, etc. Returned by search_nodes with name, labels, summary, and created_at. These are the primary graph objects.
- Facts (Entity Edges): Relationships between entity nodes, e.g. "User prefers 72 degrees in the living room". Returned by search_memory_facts with source/target entity, relationship text, validity status, and created_at. Facts can be marked active or inactive when superseded — treat inactive facts as historical, not current truth.

Graphiti tools:
- graphiti__add_memory
- graphiti__search_nodes
- graphiti__search_memory_facts
- graphiti__delete_entity_edge
- graphiti__delete_episode
- graphiti__get_entity_edge
- graphiti__get_episodes
- graphiti__clear_graph
- graphiti__get_status

Group IDs — always use an explicit group_id, never rely on Graphiti defaults:
- hestia_user: personal preferences, people, projects, general durable facts
- hestia_home: rooms, devices, automations, routines, home configuration

When checking for duplicates, search both groups where appropriate. Write to the single most relevant group only.

## Graphiti vs Home Assistant
Home Assistant MCP is the source of truth for structural home data: entity lists, area membership, device inventory, automation configs, and real-time states. Never store these in Graphiti — they already exist in HA and will go stale. Graphiti is for what HA cannot answer: user preferences, learned context, device quirks and calibration notes, the intent behind automations, maintenance history, and human meaning that HA's formal model does not capture. If HA MCP can answer it reliably on demand, do not store it in Graphiti.

## What to store
Store only durable, high-confidence, operationally useful facts: people and relationships, stable preferences, routines and habits, device quirks and annotations, maintenance history, automation intent, ongoing projects, important future events, and corrections to HA structure.

Do not store: transient device state, real-time entity values, HA structural data that MCP already provides, temporary errors, generic web facts, tool chatter, low-value fragments, speculation, or anything already clearly present in memory.

## Read policy
For memory lookup, use graphiti__search_nodes first. Use graphiti__search_memory_facts to refine if needed. Use graphiti__get_episodes only for provenance. Use graphiti__get_status only for troubleshooting.

When a durable fact is found in an invalidated or inactive graph state with no contradicting evidence, report it as "marked inactive in the graph — this may be a lifecycle issue" rather than claiming the real-world fact ended.

## Write policy
Search before writing to avoid duplicates. Use graphiti__add_memory with source=json for structured facts. Episode names must describe the remembered content (e.g. "User vehicle information", "Home office lighting preference") — not maintenance actions. episode_body must be a valid JSON string. Do not bundle unrelated facts. After a successful add_memory call, report that the memory was submitted — do not immediately re-query to verify.

Always refer to the user by name or as "the user" in episode_body text — never use "my", "I", or "me". Graphiti extracts entities from the raw text; first-person pronouns produce self-referential edges that cannot be linked back to the correct person node.

## Delete policy
Delete entity edges or episodes only when they are clearly wrong, duplicate, malformed, or explicitly requested for removal. Use graphiti__clear_graph only on explicit user request for a full wipe. Never delete on weak evidence.

## Decision standard
Store a memory only if it is durable, specific, non-duplicative, high-confidence, and useful for future assistance. Skip it if it is transient, generic, already present, ambiguous, or low-value.
HESTIA_MEMORY_POLICY
)
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
