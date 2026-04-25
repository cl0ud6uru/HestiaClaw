# AGENTS.md

Agent guidance for AI coding assistants (Codex, Copilot, Gemini, etc.) working in this repository.

## Project overview

**HestiaClaw** is a Home Assistant-centric React/Vite AI agent interface. It supports two backend modes selectable from the sidebar:

- **Agent mode** — a native agent harness embedded in the Express server with multi-provider LLM support and config-driven MCP tools
- **N8N mode** — proxies to an N8N AI agent webhook (original backend, still fully supported)

**Stack**: React 19, Vite, Express 5, SQLite (`better-sqlite3` + `connect-sqlite3`), `express-session`, `argon2`, `@anthropic-ai/sdk`, `openai`, `@modelcontextprotocol/sdk`, `neo4j-driver`, plain CSS, `react-markdown`, `remark-gfm`. No TypeScript, no CSS modules, no Tailwind, no automated test suite.

---

## Running the project

```bash
npm install
cp .env.example .env                         # fill in API keys
cp agent.config.example.json agent.config.json   # fill in provider + MCP config
npm run dev                                  # Vite on :5173+ and Express on :3001
npm run build
npm run start
npm run lint
```

### Required env vars

```bash
SESSION_SECRET=replace-with-a-long-random-secret
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=change-me-now

# Agent mode
OPENAI_API_KEY=...          # or ANTHROPIC_API_KEY for Claude
OPENAI_BASE_URL=            # optional — Ollama, LM Studio, etc.

# N8N mode
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/...

# Optional integrations
ELEVENLABS_API_KEY=...
NEO4J_URI=bolt://...
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
SEARXNG_URL=http://...      # enables built-in web_search tool in agent mode
HA_URL=https://...          # Home Assistant (used by agent.config.json MCP env block)
HA_TOKEN=...
```

---

## Repository structure

```
hestiaclaw/
├── server/
│   ├── index.js                       # Express app — auth, N8N proxy, voice, graph, agent mount
│   └── agent/
│       ├── index.js                   # Agent router (/api/agent/*)
│       ├── loop.js                    # Core agent loop — stream → tool execute → history persist
│       ├── session.js                 # SQLite conversation history (agent_messages table)
│       ├── providers/
│       │   ├── base.js                # Provider interface
│       │   ├── anthropic.js           # Anthropic SDK adapter
│       │   ├── openai.js              # OpenAI SDK adapter (also Ollama/LM Studio)
│       │   └── index.js               # Provider factory
│       ├── tools/
│       │   ├── registry.js            # Tool registry
│       │   └── builtin/
│       │       └── web-search.js      # SearXNG tool (activates if SEARXNG_URL set)
│       └── mcp/
│           └── client.js              # MCP stdio client manager
├── src/
│   ├── App.jsx                        # Root state — sendMessage (N8N) + sendMessageAgent (agent)
│   ├── App.css
│   ├── components/
│   │   ├── ChatMessage.jsx
│   │   ├── Sidebar.jsx                # Conversation list + N8N/Agent mode toggle
│   │   ├── ThinkingAnimation.jsx
│   │   ├── ChatInput.jsx
│   │   ├── LoginScreen.jsx
│   │   ├── AccountPanel.jsx
│   │   └── GraphView.jsx
│   └── lib/voice.js
├── agent.config.json                  # gitignored — copy from agent.config.example.json
├── agent.config.example.json
├── data/                              # gitignored — SQLite files
└── .env.example
```

---

## Agent harness architecture

### Activation

The harness activates when `agent.config.json` exists in the project root. Without it the server logs `"native harness disabled"` and only N8N mode is available.

### Agent config format

```json
{
  "provider": {
    "type": "openai",
    "model": "gpt-4o"
  },
  "systemPrompt": "You are Hestia, a home intelligence assistant...",
  "mcpServers": {
    "home-assistant": {
      "command": "/home/jason/.local/bin/uvx",
      "args": ["hass-mcp"],
      "env": {
        "HA_URL": "${HA_URL}",
        "HA_TOKEN": "${HA_TOKEN}"
      }
    }
  }
}
```

`${VAR}` in `env` values are expanded from `process.env` at startup.

### Provider interface (`server/agent/providers/base.js`)

```js
class Provider {
  get name()                          // 'anthropic' | 'openai'
  async *stream(messages, tools, options)
  // yields: { type: 'token', content }
  //       | { type: 'tool_call', id, name, input }
}
```

Both providers translate their native streaming deltas into this common event shape.

### Agent loop (`server/agent/loop.js`)

1. Load bounded history from SQLite via `session.getContext(conversationId)`
2. Append new user message
3. Call `provider.stream(messages, tools, { system })` — collect `token` and `tool_call` events
4. Emit `token` events to HTTP response as `{"type":"token","content":"..."}` NDJSON lines
5. On `tool_call`: emit `tool_start`, request browser approval for risky write tools, execute via `registry.execute(name, input)`, emit `tool_end`
6. Append assistant turn + tool results to messages; repeat until no tool calls (max 10 iterations)
7. Persist all new messages to SQLite
8. Emit `{"type":"done"}`

Long conversations use bounded context via `session.getContext()`: recent messages are kept verbatim and older messages are summarized into the effective system prompt.

### Tool registry (`server/agent/tools/registry.js`)

- `register(name, description, schema, executeFn, metadata?)` — add a tool
- `getDefinitions()` → array passed to LLM as tool definitions
- `listTools()` → definitions plus harness metadata (`source`, `kind`, `risk`, approval flag, timeout)
- `execute(name, input)` → string result

MCP tools are registered as `serverName__toolName`. Names are capped at 64 chars (OpenAI hard limit) — long server names are truncated, tool names are preserved.

### MCP client (`server/agent/mcp/client.js`)

- Supports stdio `mcpServers` entries with `command`/`args` and remote HTTP entries with `url`
- HTTP entries try streamable HTTP first and fall back to SSE when `transport` is omitted or set to `"auto"`
- Calls `listTools()` on each server and registers every tool into the registry
- Graceful shutdown on `SIGTERM`/`SIGINT`

### Agent stream format (NDJSON, one JSON object per line)

| Event | Fields | Meaning |
|-------|--------|---------|
| `run_start` | `id` | Agent run trace started |
| `context_summary` | `messageCount, keptMessages` | Older history was summarized into the effective system prompt |
| `token` | `content: string` | LLM output token |
| `tool_start` | `id, name, input` | Tool execution beginning |
| `approval_required` | `approvalId, id, name, input, risk, kind, timeoutMs` | Browser approval required before a risky tool runs |
| `tool_end` | `id, name` | Tool execution complete |
| `done` | — | Turn complete |
| `error` | `message: string` | Agent or API error |

### Conversation history

Stored in `agent_messages` SQLite table, separate from the auth DB. Agent runs are also traced in `agent_runs`, `agent_run_events`, and `agent_tool_calls` for diagnostics. Message schema:
```sql
CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,   -- JSON-serialized full provider message object
  created_at INTEGER NOT NULL
);
```

The client only sends `{ message, conversation_id }` per turn — no full history in the request body.

Agent history can be forked server-side with `/api/agent/conversations/fork`, which copies messages and conversation summary to a new conversation id.

History rows must deserialize to real provider message objects. `AgentSession._deserializeRow()` invokes the parser and validates messages before sending them to providers; do not allow malformed rows or functions to enter the `messages` array because JSON serialization turns unsupported values into `null`, which OpenAI rejects.

---

## OpenAI streaming quirk (important)

**gpt-5.4-mini and likely other newer GPT models** send `function.name` in **two separate stream chunks** for the same tool call index. Accumulating with `+=` would double the name (e.g. 35 + 35 = 70 chars), breaking OpenAI's 64-char limit on the next request.

**Fix in `openai.js`**: tool call names are set only on the **first non-empty occurrence** per index:

```js
if (tc.function?.name && !pendingToolCalls[tc.index].name) {
  pendingToolCalls[tc.index].name = tc.function.name
}
// arguments still use +=
```

Do NOT change this to `+=` for names.

---

## Frontend mode routing

`App.jsx` maintains `agentMode: 'n8n' | 'agent'` (persisted in `localStorage` as `hestia-agent-mode`).

```js
const sendMessage = async (text, options = {}) => {
  if (agentMode === 'agent') return sendMessageAgent(text, options)
  // ... N8N path unchanged
}
```

The sidebar toggle calls `handleAgentModeChange(mode)` which updates state and `localStorage`.

---

## Auth and API architecture

### Browser-facing rules

- The browser must only call `/api/*` — never N8N or ElevenLabs directly.
- Vite proxies `/api/*` to `http://localhost:3001` in development.

### Express server responsibilities (`server/index.js`)

- Bootstraps first admin user from env when users table is empty
- Auth: login, logout, session check, credential update
- Chat proxy: `/api/chat/send` → N8N webhook (pipe stream)
- Agent harness: mount `/api/agent/*` routes if `agent.config.json` present
- Voice: ElevenLabs token issuance, STT, TTS (all proxied — key never sent to browser)
- Graph: Neo4j queries + GDS recompute

### Security defaults

- Session cookies: `HttpOnly`, `secure` in prod, `sameSite: 'lax'`
- Login is rate-limited (7 attempts / 15 min)
- POST routes enforce `requireSameOrigin()`
- Never forward non-200 upstream status codes from ElevenLabs/Neo4j — use `502`

---

## N8N stream event patterns (critical for N8N mode)

### Pattern 1 — Direct response
```
begin (AI Agent, nodeId: X) → item tokens → end
```

### Pattern 2 — Named sub-agent tool call
```
begin (AI Agent) → end
begin (Memory Agent) → item tokens (suppressed) → end
begin (AI Agent) → item tokens (shown) → end
```

### Pattern 3 — Silent MCP tool call
```
begin (AI Agent) → empty items → end
[HA MCP runs silently]
begin (AI Agent) → item tokens (shown) → end
```

### Detection rules (`App.sendMessage`)

- `mainNodeId` = nodeId of first `begin` event
- Only `item` events where `currentNodeId === mainNodeId` go into chat
- Different nodeId `begin` → named tool badge + live `activeToolName`
- Main agent cycling twice with no content + no sub-agent → silent tool badge
- Tool calls deduplicated by name

---

## State (App.jsx)

| State | Purpose |
|-------|---------|
| `agentMode` | `'n8n' \| 'agent'` — active backend, persisted to localStorage |
| `authUser` | Authenticated user from session |
| `conversations` | All conversation threads (localStorage, user-scoped) |
| `activeId` | Active conversation UUID |
| `isThinking` | True from send until first content token |
| `activeToolName` | Name of currently-running tool (shown in ThinkingAnimation) |
| `sidebarOpen` | Sidebar visibility |
| `voiceState` | `'idle' \| 'requesting' \| 'recording' \| 'transcribing'` |
| `selectedVoiceId` | ElevenLabs voice for TTS replies |

---

## Key constraints and gotchas

1. **Tool name doubling** — See OpenAI streaming quirk above. Never use `+=` for `function.name`.
2. **Tool names capped at 64 chars** — OpenAI enforces this on both tool definitions and messages. MCP names are sanitized and de-duplicated with a short hash; do not go back to simple truncation because collisions silently overwrite tools.
3. **MCP uvx path** — `uvx` is at `/home/jason/.local/bin/uvx`; use the full path in `agent.config.json` since Node's `spawn` may not have it in PATH.
4. **Sub-agent content suppression** — N8N sub-agents stream their own LLM tokens; never show these in the main chat bubble.
5. **agent.config.json is gitignored** — contains secrets; only `agent.config.example.json` is committed.
6. **Server-side history** — In agent mode, conversation history lives in SQLite on the server, not in the request body.
7. **Webhook secrecy** — `N8N_WEBHOOK_URL` stays server-side.
8. **ElevenLabs secrecy** — API key never reaches the browser; all voice calls are proxied.
9. **Bootstrap admin** — Created only when the `users` table is empty.
10. **User-scoped localStorage** — Conversations stored as `hestia-conversations:user:<id>`.
11. **Fixed HUD width** — `ThinkingAnimation` is `240px` fixed; don't make it content-driven.

---

## Adding new features — checklist

- [ ] Run `npm run lint` — zero warnings tolerated
- [ ] Browser talks to `/api/*` only
- [ ] Agent mode: new tools go in `server/agent/tools/` and are registered in `server/index.js`
- [ ] N8N mode: new node types need tool badge handling in `sendMessage` and badge CSS
- [ ] New message fields → update message shape in both `CLAUDE.md` and `AGENTS.md`
- [ ] Auth/session changes → update `.env.example` and `README.md`
- [ ] Match CSS aesthetic: HUD corners, cyan palette, Orbitron for labels
- [ ] Keep `ThinkingAnimation` at `240px` fixed width
