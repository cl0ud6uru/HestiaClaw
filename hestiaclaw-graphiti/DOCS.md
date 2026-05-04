# HestiaClaw Graphiti

Graphiti temporal knowledge graph MCP server. Provides HestiaClaw with long-term episodic memory — conversations are stored as a queryable graph of entities and relationships backed by Neo4j.

## Prerequisites

**HestiaClaw Neo4j** must be installed and running before starting this add-on.

## Installation

1. Add the HestiaClaw repository to your HA add-on store.
2. Install **HestiaClaw Neo4j** first and set its password.
3. Install **HestiaClaw Graphiti**.
4. Configure and start.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `neo4j_uri` | Yes | Neo4j Bolt URI. Use `bolt://localhost:7687` if using HestiaClaw Neo4j. |
| `neo4j_user` | Yes | Neo4j username (default: `neo4j`) |
| `neo4j_password` | Yes | Must match the password set in HestiaClaw Neo4j |
| `llm_provider` | Yes | `openai` or `anthropic` |
| `llm_model` | Yes | Model for entity extraction, e.g. `gpt-4o-mini` or `claude-haiku-4-5-20251001` |
| `openai_api_key` | If llm_provider=openai | OpenAI API key (also used for embeddings) |
| `anthropic_api_key` | If llm_provider=anthropic | Anthropic API key |

**Note:** OpenAI is always used for embeddings (`text-embedding-3-small`), so `openai_api_key` is required even when using Anthropic as the LLM provider.

## MCP Endpoint

Once running, the Graphiti MCP endpoint is at:

```
http://localhost:8000/mcp
```

Set this as `graphiti_url` in the HestiaClaw add-on configuration.

## How Memory Works

Every HestiaClaw conversation is stored as an episode in Graphiti. Graphiti extracts entities (people, locations, devices, preferences) and builds a knowledge graph. Before each agent turn, HestiaClaw searches this graph for relevant context and injects it into the system prompt.
