# HestiaClaw Neo4j (Deprecated)

> **This add-on is no longer needed.** Neo4j is now built into the HestiaClaw Graphiti add-on. Install that instead and uninstall this one.

---

Neo4j Community Edition 2026 with the Graph Data Science (GDS) plugin pre-installed. Used by HestiaClaw for knowledge graph storage and community detection.

## Installation

Install this add-on **before** HestiaClaw Graphiti and HestiaClaw.

1. Add the HestiaClaw repository to your HA add-on store (see HestiaClaw main DOCS.md).
2. Install **HestiaClaw Neo4j**.
3. Set a strong `password` in the Configuration tab.
4. Start the add-on.

## Configuration

| Option | Description |
|--------|-------------|
| `password` | Neo4j database password. Use the same value in HestiaClaw Graphiti. |

## Ports

| Port | Description |
|------|-------------|
| `7474` | Neo4j Browser (HTTP) |
| `7687` | Bolt protocol (used by Graphiti and HestiaClaw) |

Neo4j Browser is accessible at `http://<ha-host>:7474`. Log in with username `neo4j` and your configured password.

## Data Persistence

Database files are stored in the add-on's data volume and survive restarts and updates.

## Resource Usage

Neo4j is memory-intensive. The add-on is configured with:
- Heap: 512 MB initial / 1 GB max  
- Page cache: 512 MB

On systems with less than 2 GB free RAM, reduce these values by setting `NEO4J_dbms_memory_heap_max__size` and `NEO4J_dbms_memory_pagecache_size` environment overrides.
