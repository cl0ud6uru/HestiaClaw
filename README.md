# HestiaClaw

**Hestia** is a self-hosted smart home AI assistant built around Home Assistant. She runs entirely on your own infrastructure — no cloud middleman, no subscription, no data leaving your server unless you choose it. Talk to her in the browser, ask about your home, trigger automations, and watch her build a persistent memory of your world through a live 3D knowledge graph.

Under the hood: a React + Vite frontend, an Express agent harness, real-time token streaming, a layered memory system (pinned facts + Graphiti long-term graph), MCP tool support, voice I/O, and a skills system for custom behaviors.

---

## Features

- **Native agent harness** — built-in agent loop with multi-provider LLM support: Anthropic Claude, OpenAI / GPT, or any OpenAI-compatible endpoint (Ollama, LM Studio, etc.)
- **Home Assistant integration** — 84+ HA tools via ha-mcp; control devices, query entities, trigger automations, and check states directly from chat
- **Layered memory system** — pinned facts file (`MEMORY.md`) + per-turn Graphiti recall + long-term knowledge graph; memories are promoted, consolidated, and pruned automatically each night
- **MCP tool support** — connect any MCP server in `agent.config.json`; tools are auto-registered and immediately available to the LLM
- **Skills system** — drop `SKILL.md` files into `skills/` to define custom agent behaviors; invoke with `/skill-name` or let the model pick them up automatically
- **3D knowledge graph** — full-screen force-directed visualization of the Graphiti/Neo4j memory graph, with community coloring, degree sizing, and one-click GDS recompute
- **Runtime provider & model switching** — swap between Anthropic and OpenAI and pick any model from a live-fetched dropdown without restarting the server
- **Agent diagnostics panel** — inspect provider, MCP server health, tool metadata, skills, and fully traced recent runs
- **Harness controls** — browser-mediated approvals for risky tools, bounded context compaction, session forking
- **Real-time streaming** — responses appear token-by-token; tool call badges show which tools fired and when
- **Voice I/O** — hold to speak (ElevenLabs realtime STT), spoken replies after mic-originated turns (ElevenLabs TTS)
- **Thinking animation** — rotating rings, hex grid, pulsing core while the agent is thinking; shows active tool name live
- **Multi-conversation sidebar** — persistent conversation history, create / switch / delete / search sessions
- **Markdown + syntax highlighting** — GFM rendering, auto-fenced code blocks, Prism highlighting with copy button

---

## Quickstart

The full stack — Neo4j, Graphiti MCP, ha-mcp, and Hestia — starts with one command.

```bash
git clone https://github.com/cl0ud6uru/HestiaClaw
cd HestiaClaw

cp .env.example .env
# Edit .env — set SESSION_SECRET, BOOTSTRAP_ADMIN_PASSWORD, OPENAI_API_KEY,
# NEO4J_PASSWORD, HA_URL, and HA_TOKEN at minimum

cp agent.config.example.json agent.config.json
# Edit agent.config.json — set your provider, model, and system prompt

docker compose up -d
```

App runs at **http://localhost:3001** · Neo4j browser at **http://localhost:7474**

> **Note:** Two extra files — `graphiti_mcp_server.py` and `graphiti_config.yaml` — must exist in the project root before running `docker compose up`. They patch the Graphiti container to accept cross-container connections and write memory to Neo4j instead of its embedded FalkorDB. Copy them from a running `zepai/knowledge-graph-mcp` instance or see [CLAUDE.md](CLAUDE.md) for details.

---

## Configuration

### `.env`

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | ✅ | Long random string for session cookies |
| `BOOTSTRAP_ADMIN_USERNAME` | ✅ | First-run admin username |
| `BOOTSTRAP_ADMIN_PASSWORD` | ✅ | First-run admin password |
| `NEO4J_PASSWORD` | ✅ | Shared password for Neo4j and Graphiti |
| `HA_URL` | ✅ | Home Assistant URL (e.g. `https://ha.yourdomain.com`) |
| `HA_TOKEN` | ✅ | Home Assistant long-lived access token |
| `OPENAI_API_KEY` | Agent / Graphiti | OpenAI key — also used by Graphiti for embeddings |
| `OPENAI_BASE_URL` | — | Override for Ollama, LM Studio, etc. |
| `ANTHROPIC_API_KEY` | Agent mode | Anthropic key (if using Claude models) |
| `ELEVENLABS_API_KEY` | Voice | ElevenLabs key for STT + TTS |
| `ELEVENLABS_DEFAULT_VOICE_ID` | Voice | Default TTS voice ID |
| `ELEVENLABS_TTS_MODEL_ID` | — | TTS model, default `eleven_flash_v2_5` |
| `ELEVENLABS_STT_MODEL_ID` | — | STT model, default `scribe_v2_realtime` |
| `NEO4J_URI` | — | Bolt URI override (auto-set inside Docker) |
| `NEO4J_USER` | — | Neo4j username, default `neo4j` |
| `N8N_WEBHOOK_URL` | N8N mode | N8N streaming webhook URL |
| `SEARXNG_URL` | — | SearXNG instance for built-in web search |
| `DATABASE_PATH` | — | SQLite path, default `./data/hestia.sqlite` |
| `TRUST_PROXY` | — | Set to `1` behind an HTTPS reverse proxy |
| `FRONTEND_ORIGIN` | — | Dev frontend origin, default `http://localhost:5173` |

### `agent.config.json`

The agent harness activates when this file is present. Copy the example and customize:

```bash
cp agent.config.example.json agent.config.json
```

```json
{
  "provider": {
    "type": "openai",
    "model": "gpt-4.1-mini"
  },
  "systemPrompt": "You are Hestia, a smart home AI assistant...",
  "harness": {
    "approvals": true,
    "approvalTimeoutMs": 60000,
    "compactionEnabled": true,
    "contextMaxMessages": 40
  },
  "mcpServers": {
    "home-assistant": {
      "url": "http://ha-mcp:8086/mcp"
    },
    "graphiti": {
      "url": "http://graphiti:8000/mcp"
    }
  }
}
```

**Supported providers:**

| `type` | Model examples | Notes |
|---|---|---|
| `anthropic` | `claude-opus-4-7`, `claude-sonnet-4-6` | Requires `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4.1`, `gpt-4.1-mini` | Requires `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for local models |

**MCP servers** support both stdio configs (`command`/`args`) and remote HTTP configs (`url`). `${VAR}` references in `env` and `headers` blocks expand from the environment at startup.

---

## Memory System

Hestia uses a three-layer memory architecture so she actually remembers things:

1. **Pinned facts** (`data/MEMORY.md`) — the highest-confidence durable facts, injected into every turn. The agent can update this file directly (with your approval), and a nightly consolidation job regenerates it from the full Graphiti graph.

2. **Active recall** — before each reply, Hestia runs a fast semantic search against your Graphiti graph using your message as the query. The top results are silently injected into her context so relevant memories surface without her having to explicitly look them up.

3. **Graphiti knowledge graph** — all conversations write episodes to Graphiti. Entities and relationships accumulate over time and are visible in the 3D graph view. The nightly consolidation job prunes duplicates and promotes the best facts to the pinned layer.

To trigger consolidation manually: `POST /api/agent/consolidate`

---

## Skills

Skills are pre-defined agent behaviors stored as `SKILL.md` files in the `skills/` directory.

```
skills/
  morning-brief/
    SKILL.md
  lights-off/
    SKILL.md
```

**SKILL.md format:**

```markdown
---
name: morning-brief
description: Deliver a morning briefing covering overnight activity and what's on for the day.
user-invocable: true
argument-hint: (optional hint shown in the palette)
disable-model-invocation: false
---

Your instructions for the agent go here. This becomes part of the system prompt
when this skill is active.
```

**Invoking skills:**

- Type `/` in the chat input to open the command palette — navigate with arrow keys, select with Enter or Tab
- Type `/morning-brief` and send to invoke directly
- Skills with `disable-model-invocation: false` are injected into the system prompt so the model can invoke them automatically when the context matches

---

## Knowledge Graph

Click **KNOWLEDGE GRAPH** in the header to open the full-screen 3D force-directed view. Requires Neo4j running with `NEO4J_URI`, `NEO4J_USER`, and `NEO4J_PASSWORD` set in `.env`.

- Nodes colored by Louvain community, sized by degree centrality
- Click a node to see its relationships in the info panel
- **RECOMPUTE** re-runs the full GDS pipeline (community detection + degree centrality) server-side

As Hestia converses and queries Home Assistant, Graphiti extracts entities and builds relationships in the graph automatically — it grows on its own.

---

## Agent Harness

### API routes

All routes require authentication except `/api/auth/login`.

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate and create session |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/session` | Current auth state |
| `POST` | `/api/auth/change-password` | Change username or password |
| `POST` | `/api/agent/chat` | Run agent loop, stream NDJSON |
| `GET` | `/api/agent/config` | Provider, model, tools, skills, MCP status, recent runs |
| `GET` | `/api/agent/models` | Live model list for a provider (cached 5 min) |
| `POST` | `/api/agent/settings` | Hot-swap provider / model / system prompt / reasoning effort |
| `GET` | `/api/agent/tools` | All registered tools with metadata |
| `GET` | `/api/agent/runs` | Recent traced agent runs |
| `GET` | `/api/agent/approvals` | Pending tool approval requests |
| `POST` | `/api/agent/approvals/:id` | Approve or deny a pending tool call |
| `POST` | `/api/agent/conversations/fork` | Copy agent history into a new conversation |
| `POST` | `/api/agent/consolidate` | Trigger memory consolidation manually |
| `GET` | `/api/graph` | Query Neo4j knowledge graph (nodes + edges) |
| `POST` | `/api/graph/recompute` | Re-run GDS Louvain + degree analytics |
| `GET` | `/api/voice/voices` | List ElevenLabs voices |
| `POST` | `/api/voice/token` | Single-use ElevenLabs WebSocket token |
| `POST` | `/api/voice/transcribe` | Fallback audio → text (ElevenLabs STT) |
| `POST` | `/api/voice/speak` | Text → audio (ElevenLabs TTS) |

### Context management

Long conversations use bounded context: recent messages are kept verbatim, older messages are summarized and injected into the effective system prompt. Configurable via `harness.contextMaxMessages` in `agent.config.json` or the Agent Harness panel at runtime.

---

## N8N Mode

A legacy N8N streaming webhook integration is still available as a selectable backend. Toggle between N8N and Agent mode from the sidebar. Set `N8N_WEBHOOK_URL` in `.env` and configure your N8N node with `Response Mode: Streaming`.

---

## Built With

- **Frontend:** React 19 + Vite 8, plain CSS, Orbitron & Rajdhani fonts
- **Backend:** Express 5, SQLite (better-sqlite3) — auth, sessions, agent history, audit log
- **LLM:** `@anthropic-ai/sdk` + `openai` SDK (Responses API)
- **MCP:** `@modelcontextprotocol/sdk` stdio + HTTP client
- **Memory:** Graphiti + Neo4j + GDS (via Docker)
- **Rendering:** react-markdown + remark-gfm + react-syntax-highlighter (Prism)
- **3D graph:** three.js + 3d-force-graph
- **Voice:** ElevenLabs realtime STT WebSocket + TTS proxy
- **Auth:** Argon2 password hashing, express-session, helmet
- **Scheduling:** node-cron (daily memory consolidation)

---

## Acknowledgments

Hestia stands on the shoulders of some excellent open-source projects:

- **[Graphiti](https://github.com/getzep/graphiti)** by [Zep AI](https://www.getzep.com/) — the temporal knowledge graph engine that powers Hestia's long-term memory
- **[ha-mcp](https://github.com/homeassistant-ai/ha-mcp)** by homeassistant-ai — the MCP server that gives Hestia her 84+ Home Assistant tools
- **[Home Assistant](https://www.home-assistant.io/)** — the open-source smart home platform this whole thing is built around
- **[Neo4j](https://neo4j.com/)** — the graph database backing the knowledge graph visualization
- **[3d-force-graph](https://github.com/vasturiano/3d-force-graph)** + **[three.js](https://threejs.org/)** — the 3D graph rendering stack
- **[ElevenLabs](https://elevenlabs.io/)** — realtime voice STT and TTS
- **[Model Context Protocol](https://modelcontextprotocol.io/)** — the open standard that makes MCP servers plug-and-play with any compliant agent
