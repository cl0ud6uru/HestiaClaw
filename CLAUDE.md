# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server (usually http://localhost:5173 or 5174+ if port taken)
npm run build    # Production build → dist/
npm run preview  # Serve the production build locally
npm run lint     # ESLint (react-hooks + react-refresh rules, no warnings tolerated)
```

No test suite exists yet.

## Docker setup

Two compose files handle different workflows:

```bash
# Production — runs Neo4j + Graphiti + Hestia all in Docker
docker compose up -d

# Development — runs Neo4j + Graphiti in Docker, app runs natively with hot reload
docker compose -f docker-compose.dev.yml up -d
npm run dev
```

**Services:**
- `neo4j` — `neo4j:2026-community` with GDS plugin auto-installed (`NEO4J_PLUGINS`); browser at `http://localhost:7474`
- `graphiti` — `zepai/graphiti-mcp:latest`; MCP endpoint at `http://localhost:8001/mcp` (dev only — dev compose maps host 8001 → container 8000)
- `ha-mcp` — `ghcr.io/homeassistant-ai/ha-mcp:latest`; 87+ Home Assistant tools; MCP endpoint at `http://localhost:8002/mcp` (dev, host port 8002 → container 8086) / `http://ha-mcp:8086/mcp` (prod). Reads `HA_URL` + `HA_TOKEN` from `.env`, remapped to `HOMEASSISTANT_URL`/`HOMEASSISTANT_TOKEN` inside the container.
- `hestia` — production build of this app (production compose only)

**MCP service URLs:**
- Graphiti (prod): `http://graphiti:8000/mcp` · (dev): `http://localhost:8001/mcp`
- ha-mcp (prod): `http://ha-mcp:8086/mcp` · (dev): `http://localhost:8002/mcp`
Set these in `agent.config.json` under `mcpServers.<name>.url`.

**Production Docker extra files** (required, not committed — generated on first deploy):
- `graphiti_mcp_server.py` — patched copy of the graphiti MCP server that passes `host='0.0.0.0'` to FastMCP, disabling DNS-rebinding protection that otherwise blocks cross-container connections
- `graphiti_config.yaml` — config for `zepai/knowledge-graph-mcp` that sets `database.provider: neo4j` so graphiti writes to the Neo4j container (the default config uses embedded FalkorDB which the graph view cannot query)

Both are mounted read-only into the graphiti container via `docker-compose.yml` volumes. Copy them from the `zepai/knowledge-graph-mcp` image or another running instance if setting up fresh.

**Neo4j password** is set once via `NEO4J_PASSWORD` in `.env` and shared by both the Neo4j container and the Graphiti container. The production compose overrides `NEO4J_URI` to `bolt://neo4j:7687` automatically so the same `.env` works for both native and Docker runs.

## Git workflow

Always ask before running `git push`. Committing locally is fine without asking, but pushing to GitHub requires explicit confirmation each time.

## Architecture

Single-page React app (Vite, no router) with two backend modes selectable from the sidebar toggle:

- **Agent mode** (default when `agent.config.json` present): talks to the native agent harness at `/api/agent/chat`
- **N8N mode**: proxies to the N8N webhook at `/api/chat/send`

**Data flow (Agent mode):**
1. User submits text → `App.sendMessageAgent()` POSTs `{ message, conversation_id }` to `/api/agent/chat`
2. `isThinking = true` → `<ThinkingAnimation>` renders
3. Server runs the agent loop: calls LLM, executes MCP tools, streams NDJSON events
4. `token` events → content appended to message bubble
5. `tool_start` / `tool_end` events → tool badges accumulate
6. `done` event → `streaming: false`, cursor removed

**Data flow (N8N mode):**
1. User submits text → `App.sendMessage()` POSTs `{ chatInput, conversation_id }` to `/api/chat/send`
2. N8N streams `begin/item/end` JSON events; parsed as before

**Mode toggle**: `agentMode` state (`'n8n' | 'agent'`) persisted to `localStorage` key `hestia-agent-mode`. Rendered as a toggle in `Sidebar.jsx` footer.

**Agent stream format** (`/api/agent/chat` NDJSON):
```json
{"type":"token","content":"Hello"}
{"type":"tool_start","id":"call_abc","name":"home-assistant__get_entity","input":{...}}
{"type":"tool_end","id":"call_abc","name":"home-assistant__get_entity"}
{"type":"done"}
{"type":"error","message":"..."}
```

**N8N stream format** (unchanged — see AGENTS.md for full detail):
Each line is a JSON object: `{ type: "begin"|"item"|"end", metadata: { nodeId, nodeName, ... }, content?: string }`

**Message shape:**
```js
{
  id: number,
  role: 'user' | 'assistant',
  content: string,
  streaming: boolean,
  isError?: boolean,
  toolCalls?: Array<{ name: string, type: 'subagent' | 'silent' }>
}
```

**Tool call detection:**
- Agent mode: `tool_start` events → badge with `type: 'subagent'`; MCP tool names use `serverName__toolName` format (capped at 64 chars), display strips `__` to `: `
- N8N mode: `begin` events with different nodeId → named subagent badge; silent HA cycles → silent badge

**Markdown rendering** (`ChatMessage.jsx`):
- `preprocessMarkdown()` runs before `react-markdown` — auto-detects unfenced code lines and wraps them in fences
- `react-markdown` + `remark-gfm` renders the result

## Component map

| File | Purpose |
|------|---------|
| `src/App.jsx` | All state, both send paths (`sendMessage` / `sendMessageAgent`), stream parsing, mode routing |
| `src/components/ChatMessage.jsx` | Message bubble renderer; contains `preprocessMarkdown()` |
| `src/components/ThinkingAnimation.jsx` | Arc reactor + live tool label; accepts `activeTool` prop |
| `src/components/ChatInput.jsx` | Textarea input; send on Enter, disabled while thinking |
| `src/components/Sidebar.jsx` | Conversation list + N8N/Agent mode toggle |
| `src/components/GraphView.jsx` | Knowledge graph overlay; fetches `/api/graph`, renders 3D force graph |
| `src/lib/voice.js` | Browser microphone capture, realtime STT, and audio-transcription fallback helpers |

## Server map

| File | Purpose |
|------|---------|
| `server/index.js` | Express app; mounts all routes; boots agent harness on startup if `agent.config.json` exists |
| `server/agent/index.js` | Agent router (`/api/agent/*`) |
| `server/agent/loop.js` | Core agent loop — LLM streaming → tool execution → history persistence |
| `server/agent/session.js` | SQLite conversation history (`agent_messages` table) |
| `server/agent/approvals.js` | In-memory pending approval manager for risky tool calls |
| `server/agent/events.js` | Lightweight runtime hook/event bus foundation |
| `server/agent/providers/anthropic.js` | Anthropic SDK streaming adapter |
| `server/agent/providers/openai.js` | OpenAI SDK streaming adapter (also works with Ollama / LM Studio via `OPENAI_BASE_URL`) |
| `server/agent/providers/index.js` | Provider factory keyed by `config.type` |
| `server/agent/tools/registry.js` | Tool registry — register, list definitions, execute by name |
| `server/agent/tools/builtin/web-search.js` | Optional SearXNG web search tool (activates if `SEARXNG_URL` is set) |
| `server/agent/tools/builtin/memory-file.js` | `read_memory` + `write_memory` builtin tools for `data/MEMORY.md` |
| `server/agent/memory-consolidation.js` | Daily consolidation job — fetches Graphiti episodes → LLM → prunes dupes → writes MEMORY.md |
| `server/agent/mcp/client.js` | MCP stdio client — connects servers from `agent.config.json`, registers their tools |
| `src/components/AgentPanel.jsx` | Agent Harness diagnostics panel — provider/model dropdowns (live-fetched), MCP server status, tool metadata, recent runs, runtime settings |

## Agent harness

**Activation**: presence of `agent.config.json` in the project root. Without it, the server starts in N8N-only mode.

**Config format** (`agent.config.json`, gitignored — copy from `agent.config.example.json`):
```json
{
  "provider": { "type": "openai", "model": "gpt-4o" },
  "systemPrompt": "You are Hestia, a home intelligence assistant...",
  "mcpServers": {
    "home-assistant": {
      "command": "uvx",
      "args": ["hass-mcp"],
      "env": { "HA_URL": "${HA_URL}", "HA_TOKEN": "${HA_TOKEN}" }
    }
  }
}
```

**Supported provider types**: `anthropic`, `openai`

**MCP notes**:
- Uses `@modelcontextprotocol/sdk` stdio transport
- Tool names registered as `serverName__toolName`, capped at 64 chars (OpenAI limit)
- MCP config supports stdio servers with `command`/`args` and remote HTTP servers with `url`
- `${VAR}` in `env` and `headers` blocks expands from `process.env` at startup
- `uvx` — use `uvx` (no path) in `command`; native installs expect it on `$PATH`, and the Docker image installs `uv` to `/root/.local/bin` which is added to `PATH` in the Dockerfile

**OpenAI provider uses the Responses API** (`client.responses.create()` / `POST /v1/responses`). Tool definitions are flattened (`{type:'function', name, description, parameters}` — no nested `function` wrapper). Tool calls are emitted on `response.output_item.done` events. History items use `type:'function_call'` and `type:'function_call_output'`. Old Chat Completions history (`role:'tool'`, `tool_calls:[]`) is auto-converted on read. `reasoning` is dropped when tools are present to avoid API errors.

**Conversation history**: stored in SQLite `agent_messages` table, keyed by `conversation_id`. The `content` column stores the full provider message JSON so tool metadata such as OpenAI `tool_calls` and `tool_call_id` survives reloads. The server holds history server-side; the client only sends `{ message, conversation_id }` per turn.

**Harness controls**: risky MCP write tools require browser approval before execution. Long conversations use bounded context with a generated summary injected into the effective system prompt. Agent conversations can be forked from the Agent Harness panel, copying server-side history to a new conversation id.

**Runtime provider & model switching**: `POST /api/agent/settings` accepts a `provider` field (`anthropic` | `openai`) that hot-swaps the active provider instance without a server restart. `GET /api/agent/models?provider=X` calls the provider's models API and returns a sorted list (cached 5 min per provider). Both `AnthropicProvider` and `OpenAIProvider` expose a `listModels()` method used by this endpoint.

## Memory system

Hestia uses a layered memory architecture:

**Layer 1 — Pinned facts (`data/MEMORY.md`):**
- Lives at `data/MEMORY.md`, mounted in the `hestia_data` Docker volume at `/app/data/MEMORY.md`
- Injected into every agent turn as a `## Pinned Memory` section in the effective system prompt
- Agent can update it via the `write_memory` builtin tool (medium risk → requires approval)
- Daily consolidation cron regenerates it from Graphiti episodes

**Layer 2 — Active memory recall (per-turn Graphiti search):**
- Before each agent turn, the server calls `graphiti__search_nodes` with the user message as query
- Top 5 results (≤ 2000 chars) are injected as `## Active Memory Recall` in the effective system prompt
- 2-second timeout — fails silently if Graphiti is slow

**Layer 3 — Graphiti long-term graph:**
- All conversations still write episodes to Graphiti
- Group IDs: `hestia_user` (personal/general), `hestia_home` (devices, rooms, automations)
- The agent calls Graphiti tools directly for targeted reads, writes, and deletes

**Consolidation (`POST /api/agent/consolidate`):**
- Fetches last 100 episodes from each group, sends to LLM for analysis
- LLM returns `{ episodes_to_delete: [...], memory_md_content: "..." }`
- Deletes duplicate/junk episodes; writes new `data/MEMORY.md`
- Also runs daily at 03:00 via `node-cron`

## Styling conventions

All styles are plain CSS co-located with their component — no CSS modules, no Tailwind.

- **Fonts**: `Orbitron` (HUD labels, titles) · `Rajdhani` (body/chat text) — Google Fonts in `index.html`
- **Color palette**: `#030810` bg · `#00d4ff` primary cyan · `#00ffaa` status green · `#0099ff` secondary blue
- **HUD corner brackets**: four `<span>` siblings (`.bubble-corner.tl/tr/bl/br`) with absolute positioning and partial borders — used on every panel
- **Tool badges**: `.tool-badge` (subagent = cyan, silent = blue) rendered inside `.tool-calls` below message text
- **Code blocks**: dark navy `rgba(0,4,18,0.9)` background, left cyan border accent, `JetBrains Mono` or `Courier New`
- Animations are defined at the top of each CSS file with `@keyframes`

## N8N backend context

The N8N backend (still available in N8N mode) can connect to an external N8N agent workflow:
- **LLM**: GPT-4 series for main agent
- **Smart home**: Home Assistant MCP — tool calls appear as silent AI Agent cycles in the stream
- **Long-term memory**: Graphiti knowledge graph — surfaces as `"Memory Agent"` sub-agent in stream
- **Web search**: SearXNG + URL fetch sub-agent
- **Session memory**: Postgres keyed by `conversation_id`

## Knowledge graph

The "KNOWLEDGE GRAPH" button in the header opens a full-screen 3D force-directed visualization of the Graphiti Neo4j knowledge base.

**Data flow:**
- `GET /api/graph` (Express, auth-required) queries Neo4j via `neo4j-driver` server-side and returns `{ nodes, edges }` JSON — credentials never reach the browser
- Neo4j entity nodes (`Entity` label, `name`/`community`/`degree` properties) are mapped to nodes; `RELATES_TO` edges carry a `fact` property shown in the info panel
- Community detection and degree centrality are written as node properties via Neo4j GDS

**Env vars** (in `.env`):
```
NEO4J_PASSWORD=your_password   # shared by Neo4j + Graphiti containers
NEO4J_URI=bolt://localhost:7687  # override to bolt://neo4j:7687 inside Docker (done automatically)
NEO4J_USER=neo4j
```
When running via Docker Compose, Neo4j and Graphiti start automatically — no manual installation needed.

**Important server-side rule:** Never forward upstream HTTP status codes from ElevenLabs or Neo4j directly to the client — always use `502` for upstream errors. A forwarded `401` from ElevenLabs would log the user out.

## Voice integration

- ElevenLabs voice traffic stays behind the local Express server.
- Browser clients request single-use websocket tokens from `/api/voice/token`.
- Available voices come from `GET /api/voice/voices`.
- Fallback STT uses `POST /api/voice/transcribe`.
- TTS uses `POST /api/voice/speak` and plays after the assistant reply finishes.
- Spoken replies only trigger for mic-originated turns and must use the same main-agent-only visible text as chat output.
