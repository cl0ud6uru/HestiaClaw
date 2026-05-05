# HestiaClaw Graphiti

Graphiti temporal knowledge graph MCP server with **Neo4j built-in**. Provides HestiaClaw with long-term episodic memory — conversations are stored as a queryable graph of entities and relationships.

> **Note:** The separate HestiaClaw Neo4j add-on is no longer needed. This add-on runs Neo4j internally.

## Installation

1. Add the HestiaClaw repository to your HA add-on store.
2. Install **HestiaClaw Graphiti** (this add-on).
3. Configure and start — that's it.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `password` | Yes | Neo4j database password. Used internally — just set it once here. |
| `reset_neo4j_data` | No | Deletes persisted Neo4j data on next start so the current password can be initialized. Turn it back off after one successful start. |
| `llm_provider` | Yes | `openai` or `anthropic` |
| `llm_model` | Yes | Model for entity extraction, e.g. `gpt-5-mini` or `claude-haiku-4-5-20251001` |
| `openai_api_key` | Yes | OpenAI API key (required for embeddings even when using Anthropic as LLM) |
| `anthropic_api_key` | If llm_provider=anthropic | Anthropic API key |

## Ports

| Port | Description |
|------|-------------|
| `7474` | Neo4j Browser — `http://<ha-host>:7474`, login: `neo4j` / your password |
| `7687` | Neo4j Bolt (internal) |
| `8000` | Graphiti MCP endpoint |

## MCP Endpoint

```
http://<ha-host>:8000/mcp
```

Set this as `graphiti_url` in the HestiaClaw add-on configuration.

## How Memory Works

Every HestiaClaw conversation is stored as an episode in Graphiti. Graphiti extracts entities (people, locations, devices, preferences) and builds a knowledge graph. Before each agent turn, HestiaClaw searches this graph for relevant context and injects it into the system prompt.

## Data Persistence

Neo4j database files are stored in the add-on's data volume at `/data/neo4j` and survive restarts and updates.

The `password` option is applied with `neo4j-admin dbms set-initial-password` before the first database startup. If you change it after `/data/neo4j` already exists, Neo4j keeps the old password and Graphiti can fail with `Neo.ClientError.Security.Unauthorized` or `AuthenticationRateLimit`. Restore the original password, or set `reset_neo4j_data` to `true` for one start if you intentionally want to recreate Neo4j with the current password.

## Resource Usage

Neo4j is memory-intensive. The add-on is configured with:
- Heap: 512 MB initial / 1 GB max
- Page cache: 512 MB

Recommended minimum: **2 GB free RAM**.
