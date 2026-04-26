# Hestia — Core Concepts

Reference for how Hestia is designed to work. Update this as decisions evolve.

---

## Memory Architecture

Hestia uses three memory layers, each serving a different purpose.

### Layer 1 — Pinned Memory (`data/MEMORY.md`)
- Short markdown file of durable, high-confidence facts
- Injected into **every** agent turn as `## Pinned Memory` in the system prompt
- Agent can overwrite it via the `write_memory` builtin tool (requires browser approval)
- The daily 3am consolidation cron regenerates it from Graphiti episodes
- Stored in the `hestia_data` Docker volume — survives container rebuilds

### Layer 2 — Active Memory Recall (per-turn Graphiti search)
- Before each turn, the server runs `graphiti__search_nodes` on the user's message
- Top 5 results (≤ 2000 chars) injected as `## Active Memory Recall`
- 2-second timeout — fails silently if Graphiti is slow or down
- Gives the agent relevant context without blowing up the prompt on every turn

### Layer 3 — Graphiti Knowledge Graph (Neo4j)
- Long-term graph of episodes, entities, and relationships
- Agent writes to it explicitly by calling `graphiti__add_memory`
- Two group IDs in use: `hestia_user` (personal/preferences) and `hestia_home` (devices, rooms, automations)
- Queried by Layer 2 on each turn; also browsable via the Knowledge Graph view in the UI

### Consolidation Cron
- Runs daily at 3am via `node-cron`
- Fetches up to 100 episodes from each group, sends to LLM for analysis
- LLM returns episodes to delete (duplicates/junk) + new `MEMORY.md` content
- Deletes flagged episodes from Graphiti; writes new `MEMORY.md`
- **Manual trigger** (browser console while logged in):
  ```js
  fetch('/api/agent/consolidate', { method: 'POST' }).then(r => r.json()).then(console.log)
  ```

---

## What Belongs in the Graphiti Graph

The graph is for things Hestia **learns** that Home Assistant doesn't already know.

### Put in the graph ✓
- User preferences: lighting temperatures, thermostat schedules, comfort settings
- Contextual notes: "basement thermostat reads 3°F high", "garage door sensor unreliable in cold"
- Maintenance history: "HVAC filter replaced April 2026", "smart lock battery changed Jan 2026"
- Routines and habits: "morning routine starts 7am weekdays", "fireplace when outdoor temp < 55°F"
- Annotations on automations: the *intent* behind an automation, not just its config
- Corrections: "the 'office' area in HA is actually the studio"

### Don't put in the graph ✗
- **Real-time entity states** — HA MCP provides these on demand; graph copies go stale instantly
- **HA structural data** (entity lists, area membership, automation configs) — already queryable via HA MCP tools; pre-loading creates a stale duplicate
- **Transient tool chatter** — one-off errors, intermediate steps, raw tool outputs

> The graph answers "what has Hestia learned about this user and home over time" — not "what devices exist." The HA MCP answers the device question.

### How the graph gets populated
The graph only grows when the agent explicitly calls `graphiti__add_memory`. Nothing is logged automatically. The graph builds naturally through:
- Conversations where the user tells Hestia something worth remembering
- The agent noticing a pattern or preference worth storing
- Explicit "remember that..." requests

---

## Skills

Skills are pre-defined prompt templates the agent can invoke, stored as `SKILL.md` files under `skills/<name>/SKILL.md`.

### Directory structure
```
skills/
  morning-brief/SKILL.md
  home-status/SKILL.md
  chicken-man/SKILL.md
```

### SKILL.md frontmatter
```yaml
---
name: morning-brief
description: One-line description used in the agent's context and the AgentPanel UI
user-invocable: true          # show in UI, allow /skill-name from chat
disable-model-invocation: false  # if true, skill content is NOT injected into system prompt
argument-hint: "[optional]"   # shown in AgentPanel next to the skill name
---

Skill body — the prompt template the agent follows when this skill is invoked.
```

### How invocation works
- User types `/morning-brief` in chat → server replaces the message with the skill body
- Agent receives the skill instructions as the user message and runs them
- Skills are loaded fresh on every request (no restart needed to pick up edits)
- **Webhook/voice**: skills are currently not available (always `[]`) — voice turns go through the webhook path which skips skill resolution

### Docker note
The `skills/` directory must be bind-mounted into the container. It's in `docker-compose.yml` as `./skills:/app/skills:ro`. The production image does not bundle skills — only `server/` and `dist/` are in the image.

---

## Tool Filter

Lets you restrict which tools the agent can use, without removing them from the registry.

### Config (`agent.config.json`)
```json
{
  "harness": {
    "allowedTools": ["home-assistant__*", "graphiti__search_nodes", "read_memory"]
  }
}
```
- `null` / omit = allow all tools (default)
- Supports exact names and `server__*` wildcards
- Persisted to `agent.config.json` on save; removed from config when set back to "allow all"

### UI
AgentPanel → Settings → Tool Filter section:
- "Allow all tools" checkbox
- Per-server group toggles (checking a server adds `server__*` wildcard)
- Expand a server to see and toggle individual tools
- Unchecking one tool while its server wildcard is active "explodes" the wildcard into individual entries for all remaining tools

### Scope
The filter applies to both the UI chat path and the HA webhook/voice path. Approval settings are separate — the tool filter controls visibility, approvals control confirmation prompts.

---

## Agent Harness — Key Behaviors

### Approvals
- Configured per-tool via `requiresApproval: true` at registration time
- Runtime toggle (AgentPanel or `/approvals on/off`) enables/disables the approval gate
- **Webhook/voice always bypasses approvals** (`approvals: null` hardcoded) — no UI to show a popup during voice
- `write_memory` requires approval (agent must ask before overwriting MEMORY.md)
- MCP tools inferred as `high` or `medium` risk (delete/write patterns) require approval when enabled

### Context compaction
- History is bounded to `contextMaxMessages` (default 40)
- When exceeded, older messages are summarized and the summary is injected into the system prompt
- Configurable in AgentPanel Settings

### Provider switching
- Hot-swap between Anthropic and OpenAI without restart via AgentPanel Settings
- Model list is fetched live from the provider's API (cached 5 min)

---

## Folder Reference

| Folder | Purpose |
|--------|---------|
| `skills/` | Skill prompt templates (bind-mounted into Docker) |
| `data/` | Runtime data volume — MEMORY.md, SQLite databases |
| `docs/` | This folder — design decisions and concept reference |
| `agent_brain/` | Old planning docs from the OpenClaw/pre-Hestia era |
| `notes/` | Dev/infra notes (Neo4j GDS setup, etc.) |
| `server/agent/` | All agent harness server code |
| `src/components/` | React UI components |
