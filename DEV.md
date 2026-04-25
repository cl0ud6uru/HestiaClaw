# Dev Cheat Sheet

## Start / Stop

### Dev mode (hot reload)
```bash
npm run dev          # start — Vite frontend + Express backend
Ctrl+C               # stop
```

### With Docker deps (Neo4j + Graphiti)
```bash
docker compose -f docker-compose.dev.yml up -d    # start Neo4j + Graphiti in background
npm run dev                                         # start app with hot reload
docker compose -f docker-compose.dev.yml down      # stop Neo4j + Graphiti
```

### Full production stack
```bash
docker compose up -d          # start everything (Neo4j + Graphiti + app)
docker compose down           # stop everything
docker compose logs -f        # follow logs
docker compose logs hestia    # logs for app only
```

## URLs

| Service | URL |
|---|---|
| App | http://localhost:3001 |
| Vite dev server | http://localhost:5173 |
| Neo4j browser | http://localhost:7474 |
| Graphiti MCP | http://localhost:8001/mcp |

## Common Tasks

### Kill app if port 3001 is stuck
```bash
kill $(lsof -ti:3001)
```

### Kill Vite if port 5173/5174 is stuck
```bash
kill $(lsof -ti:5173) 2>/dev/null; kill $(lsof -ti:5174) 2>/dev/null
```

### Add a skill (no restart needed)
1. Create `skills/<skill-name>/SKILL.md`
2. The skill is available immediately on the next chat request

### Wipe conversation history
```bash
rm data/hestia.sqlite
```
The database is recreated automatically on next start.

### Rebuild Docker image after code changes
```bash
docker compose build hestia
docker compose up -d
```

## Branches

| Branch | Purpose |
|---|---|
| `main` | Stable |
| `feature/docker-compose` | Docker Compose + skills wiring (current) |

## Env / Config

| File | Purpose |
|---|---|
| `.env` | API keys, ports, Neo4j creds (copy from `.env.example`) |
| `agent.config.json` | LLM provider, system prompt, MCP servers (copy from `agent.config.example.json`) |
| `skills/` | Drop `SKILL.md` files here to add agent behaviors |
