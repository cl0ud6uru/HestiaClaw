# HestiaClaw

A Home Assistant-centric AI agent with a built-in multi-provider agent harness. React + Vite frontend, Express backend, real-time token streaming, MCP tool support, voice I/O, skills system, and a 3D knowledge graph visualization.

## Features

- **Native agent harness** — built-in agent loop with multi-provider LLM support (Anthropic Claude, OpenAI / GPT, or any OpenAI-compatible endpoint like Ollama or LM Studio)
- **MCP tool support** — connect any MCP server via `agent.config.json`; tools are auto-registered and available to the LLM
- **Skills system** — drop `SKILL.md` files into `skills/` to give the agent pre-defined behaviors; invoke with `/skill-name` from the chat input or let the model use them automatically
- **Knowledge graph** — full-screen 3D force-directed visualization of a Graphiti/Neo4j knowledge base, with community coloring, degree sizing, and GDS recompute
- **Runtime provider & model switching** — swap between Anthropic and OpenAI and pick any model from a live-fetched dropdown without restarting
- **Agent diagnostics panel** — inspect provider, MCP server health, tool metadata, skills, and recent traced runs
- **Harness controls** — browser-mediated approvals for risky tools, bounded context compaction, session forking
- **Real-time streaming** — responses appear token-by-token; tool call badges show which tools fired
- **Voice I/O** — hold to speak (ElevenLabs realtime STT), spoken replies after mic-originated turns
- **Thinking animation** — rotating rings, hex grid, pulsing core while the agent is thinking; shows active tool live
- **Multi-conversation sidebar** — persistent conversation history, create/switch/delete/search sessions
- **N8N mode** — N8N streaming webhook integration kept as a selectable backend
- **Markdown + syntax highlighting** — GFM rendering, auto-fenced code blocks, Prism highlighting with copy button

## Quickstart (Docker)

The easiest way to run the full stack — Neo4j, Graphiti MCP, and the app all start with one command.

```bash
git clone https://github.com/cl0ud6uru/HestiaClaw
cd HestiaClaw

cp .env.example .env
# Edit .env — set SESSION_SECRET, BOOTSTRAP_ADMIN_PASSWORD, OPENAI_API_KEY

cp agent.config.example.json agent.config.json
# Edit agent.config.json — set your provider, model, and system prompt

docker compose up -d
```

App runs at **http://localhost:3001** · Neo4j browser at **http://localhost:7474**

> **Graphiti MCP URL:** use `http://graphiti:8000/mcp` in `agent.config.json` when all services run via `docker compose` (prod). Use `http://localhost:8001/mcp` when running the app natively with `docker-compose.dev.yml`.

> **Production Docker extra files:** `graphiti_mcp_server.py` and `graphiti_config.yaml` must exist in the project root before running `docker compose up`. See [CLAUDE.md](CLAUDE.md) for details. They patch the graphiti container to (1) accept cross-container connections and (2) write memory to Neo4j instead of its embedded FalkorDB.

## Development Setup (hot reload)

Run Neo4j and Graphiti in Docker, the app natively:

```bash
docker compose -f docker-compose.dev.yml up -d   # start Neo4j + Graphiti
npm install
npm run dev                                        # Vite + Express with hot reload
```

```bash
npm run build    # production build → dist/
npm run preview  # serve the production build locally
npm run lint     # ESLint (no warnings tolerated)
```

## Configuration

### `.env`

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | ✅ | Long random secret for session cookies |
| `BOOTSTRAP_ADMIN_USERNAME` | ✅ | First-run admin username |
| `BOOTSTRAP_ADMIN_PASSWORD` | ✅ | First-run admin password |
| `NEO4J_PASSWORD` | Knowledge graph | Shared password for Neo4j and Graphiti containers |
| `NEO4J_URI` | Native setup | Bolt URI, e.g. `bolt://localhost:7687` (auto-set in Docker) |
| `NEO4J_USER` | Native setup | Neo4j username, default `neo4j` |
| `OPENAI_API_KEY` | Agent / Graphiti | OpenAI API key (also used by Graphiti for embeddings) |
| `OPENAI_BASE_URL` | — | Override base URL for Ollama, LM Studio, etc. |
| `ANTHROPIC_API_KEY` | Agent mode | Anthropic API key |
| `ELEVENLABS_API_KEY` | — | ElevenLabs key for voice I/O |
| `ELEVENLABS_DEFAULT_VOICE_ID` | — | Fallback voice for TTS |
| `ELEVENLABS_TTS_MODEL_ID` | — | TTS model, default `eleven_flash_v2_5` |
| `ELEVENLABS_STT_MODEL_ID` | — | STT model, default `scribe_v2_realtime` |
| `N8N_WEBHOOK_URL` | N8N mode | N8N streaming webhook URL |
| `SEARXNG_URL` | — | SearXNG instance URL for built-in web search tool |
| `DATABASE_PATH` | — | SQLite path, default `./data/hestia.sqlite` |
| `TRUST_PROXY` | — | Set to `1` when running behind an HTTPS reverse proxy |
| `FRONTEND_ORIGIN` | — | Dev frontend origin, default `http://localhost:5173` |

### `agent.config.json`

The agent harness activates when `agent.config.json` is present. Copy the example:

```bash
cp agent.config.example.json agent.config.json
```

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-opus-4-7"
  },
  "systemPrompt": "You are Hestia, a home intelligence assistant...",
  "harness": {
    "approvals": true,
    "approvalTimeoutMs": 60000,
    "compactionEnabled": true,
    "contextMaxMessages": 40
  },
  "mcpServers": {
    "graphiti": {
      "url": "http://localhost:8001/mcp"
    },
    "home-assistant": {
      "command": "uvx",
      "args": ["hass-mcp"],
      "env": {
        "HA_URL": "${HA_URL}",
        "HA_TOKEN": "${HA_TOKEN}"
      }
    }
  }
}
```

**Supported providers:**

| `type` | Model examples | Notes |
|---|---|---|
| `anthropic` | `claude-opus-4-7`, `claude-sonnet-4-6` | Requires `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4o`, `gpt-4o-mini` | Requires `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for local models |

**MCP servers** support stdio configs (`command`/`args`) and remote HTTP configs (`url`). `${VAR}` references in `env` and `headers` blocks expand from the environment at startup.

## Skills

Skills are pre-defined agent behaviors stored as `SKILL.md` files in the `skills/` directory. Each skill is a small markdown file with a frontmatter header and a body containing instructions for the agent.

```
skills/
  morning-brief/
    SKILL.md
  my-custom-skill/
    SKILL.md
```

**SKILL.md format:**

```markdown
---
name: morning-brief
description: Deliver a morning briefing covering overnight activity and what's relevant for the day.
user-invocable: true
argument-hint: (optional hint shown in the palette)
disable-model-invocation: false
---

Your instructions for the agent go here. This becomes part of the system prompt
and the agent will follow these instructions when this skill is invoked.
```

**Frontmatter fields:**

| Field | Default | Description |
|---|---|---|
| `name` | required | Slash command name, e.g. `morning-brief` → `/morning-brief` |
| `description` | required | Shown in the slash command palette |
| `user-invocable` | `true` | Show in the `/` command palette |
| `argument-hint` | — | Placeholder text shown after `/name` in the palette |
| `disable-model-invocation` | `false` | If `true`, skill is not injected into the system prompt |

**Invoking skills:**

- Type `/` in the chat input to open the command palette — navigate with arrow keys, select with Enter or Tab
- Type `/morning-brief` and send to invoke that skill directly
- Skills with `disable-model-invocation: false` are also injected into the system prompt so the model can invoke them automatically when context matches

## Knowledge Graph

The **KNOWLEDGE GRAPH** button opens a 3D force-directed view of the Graphiti/Neo4j graph. Requires Neo4j running (via Docker Compose or manually) with `NEO4J_URI`, `NEO4J_USER`, and `NEO4J_PASSWORD` set in `.env`.

- Nodes colored by Louvain community, sized by degree centrality
- Click a node to see its relationships in an info panel
- **RECOMPUTE** button re-runs the full GDS pipeline (community detection + degree centrality) server-side

The Graphiti MCP server (configured in `agent.config.json`) handles entity extraction and memory storage as the agent converses. The knowledge graph visualization reflects what Graphiti has stored in Neo4j.

## Agent Harness Details

### Stream format (NDJSON)

```json
{"type":"skill_invoked","name":"morning-brief"}
{"type":"token","content":"Good morning."}
{"type":"tool_start","id":"call_abc","name":"home-assistant__get_entity","input":{}}
{"type":"approval_required","approvalId":"...","id":"call_abc","name":"tool","risk":"medium","kind":"write","timeoutMs":60000}
{"type":"tool_end","id":"call_abc","name":"home-assistant__get_entity"}
{"type":"done"}
{"type":"error","message":"..."}
```

### Context management

Long conversations use bounded context: recent messages are kept verbatim and older messages are summarized and injected into the effective system prompt. Configurable via `harness.contextMaxMessages` in `agent.config.json` or the Agent Harness panel at runtime.

### API routes

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/agent/chat` | Run agent loop, stream NDJSON |
| `GET` | `/api/agent/config` | Provider, model, tools, skills, MCP status, recent runs |
| `GET` | `/api/agent/models` | Live model list for a provider (cached 5 min) |
| `POST` | `/api/agent/settings` | Hot-swap provider/model/system prompt/reasoning effort |
| `GET` | `/api/agent/tools` | All registered tools with metadata |
| `GET` | `/api/agent/runs` | Recent traced agent runs |
| `GET` | `/api/agent/approvals` | Pending tool approval requests |
| `POST` | `/api/agent/approvals/:id` | Approve or deny a pending tool call |
| `POST` | `/api/agent/conversations/fork` | Copy agent history into a new conversation id |

## N8N Mode

Set the N8N webhook node `Response Mode` to **Streaming** and enable `Enable Streaming` on the AI Agent node. Toggle between N8N and Agent mode from the sidebar.

| Field | Expression |
|---|---|
| `chatInput` | `{{ $json.body.chatInput }}` |
| `sessionid` | `{{ $json.body.conversation_id }}` |

## API Routes

All routes require authentication (cookie session) except `/api/auth/login`.

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate and create session |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/session` | Current auth state |
| `POST` | `/api/auth/change-password` | Change username or password |
| `POST` | `/api/chat/send` | Proxy to N8N, stream response |
| `GET` | `/api/voice/voices` | List ElevenLabs voices |
| `POST` | `/api/voice/token` | Single-use ElevenLabs WebSocket token |
| `POST` | `/api/voice/transcribe` | Fallback audio → text (ElevenLabs STT) |
| `POST` | `/api/voice/speak` | Text → audio (ElevenLabs TTS) |
| `GET` | `/api/graph` | Query Neo4j knowledge graph (nodes + edges) |
| `POST` | `/api/graph/recompute` | Re-run GDS Louvain + degree analytics |

## Stack

- **Frontend:** React 19 + Vite 8, plain CSS, Orbitron & Rajdhani fonts
- **Backend:** Express 5, SQLite (better-sqlite3) — auth, sessions, agent history, audit log
- **LLM:** `@anthropic-ai/sdk` + `openai` SDK
- **MCP:** `@modelcontextprotocol/sdk` stdio + HTTP client
- **Knowledge graph:** Neo4j + GDS (via Docker), Graphiti MCP server
- **Rendering:** react-markdown + remark-gfm + react-syntax-highlighter (Prism)
- **3D graph:** three.js + 3d-force-graph
- **Voice:** ElevenLabs realtime STT WebSocket + TTS proxy
- **Auth:** Argon2 password hashing, express-session, helmet
