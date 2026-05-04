# HestiaClaw

An AI home intelligence assistant with a chat interface, voice I/O, and a 3D knowledge graph. It connects to Home Assistant natively using the Supervisor token — no manual token setup required.

## Prerequisites

- Home Assistant OS (add-ons require the Supervisor; plain HA Container is not supported)
- An LLM API key: [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)
- *(Optional)* [ElevenLabs](https://elevenlabs.io/) API key for voice I/O
- *(Optional)* **HestiaClaw Neo4j** and **HestiaClaw Graphiti** add-ons for long-term memory

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top-right) → **Repositories**.
3. Add `https://github.com/cl0ud6uru/hestiaclaw` and click **Add**.
4. Find **HestiaClaw** in the store and click **Install**.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `provider` | Yes | LLM backend: `anthropic` or `openai` |
| `model` | Yes | Model name, e.g. `claude-opus-4-7` or `gpt-4o` |
| `anthropic_api_key` | If provider=anthropic | Your Anthropic API key |
| `openai_api_key` | If provider=openai | Your OpenAI API key |
| `system_prompt` | No | Override the default Hestia system prompt |
| `elevenlabs_api_key` | No | ElevenLabs key for voice synthesis |
| `elevenlabs_default_voice_id` | No | ElevenLabs voice ID to use |
| `graphiti_url` | No | Graphiti MCP URL, e.g. `http://localhost:8000/mcp` |
| `neo4j_uri` | No | Neo4j Bolt URI, e.g. `bolt://localhost:7687` |
| `neo4j_user` | No | Neo4j username (default: `neo4j`) |
| `neo4j_password` | No | Neo4j password |
| `searxng_url` | No | SearXNG instance URL for web search |
| `session_secret` | No | Cookie signing secret (auto-generated if blank) |
| `admin_username` | Yes | Login username (default: `admin`) |
| `admin_password` | Yes | Login password |

## Full Memory Stack

For long-term memory and the 3D knowledge graph, install the companion add-ons in this order:

1. **HestiaClaw Neo4j** — start first, set a password
2. **HestiaClaw Graphiti** — configure with the same Neo4j password and your LLM key
3. **HestiaClaw** — set `graphiti_url` to `http://localhost:8000/mcp` and the same Neo4j credentials

## Accessing the UI

Once started, HestiaClaw appears as **HestiaClaw** in the Home Assistant sidebar. It is also directly accessible at `http://<ha-host>:3001` if you need a standalone window.

## Networking Note

All three HestiaClaw add-ons use `host_network: true` so they can communicate via `localhost`. This is necessary for the Graphiti and Neo4j add-ons to be reachable from HestiaClaw without manual IP configuration.
