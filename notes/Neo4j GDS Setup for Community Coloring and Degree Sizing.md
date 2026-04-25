# Neo4j GDS — Knowledge Graph Visualization Setup

Covers how Neo4j Graph Data Science (GDS) was enabled for the HestiaClaw knowledge graph view, and how to maintain it going forward.

---

## What this does

The knowledge graph panel colors nodes by **community** (Louvain cluster detection) and sizes them by **degree** (connection count). Both are computed by Neo4j GDS and written back as node properties on the `Entity` nodes that Graphiti creates.

Without GDS: the graph renders but all nodes are the same color and size.  
With GDS: nodes cluster into colored communities and hubs appear larger.

---

## Docker / Portainer setup (one-time)

GDS is a plugin. In the Portainer Neo4j stack, these environment variables were added to the Neo4j service:

```yaml
NEO4J_PLUGINS: '["graph-data-science"]'
NEO4J_dbms_security_procedures_unrestricted: "gds.*"
NEO4J_dbms_security_procedures_allowlist: "gds.*"
```

`NEO4J_PLUGINS` tells the Neo4j Docker image to download and configure the GDS plugin at startup. The two `gds.*` procedure settings allow the plugin's procedures to actually be called. After redeploying the stack, `CALL gds.version()` in Neo4j Browser should return a version number confirming GDS is loaded.

---

## Running the algorithms

### Option A — RECOMPUTE button (recommended)

The HestiaClaw knowledge graph panel has a green **RECOMPUTE** button in the header. Clicking it calls `POST /api/graph/recompute` on the Express server, which runs all four GDS steps automatically and then refreshes the graph. No Neo4j Browser needed.

### Option B — Manually in Neo4j Browser

```cypher
-- 1. Project an in-memory graph from all Entity nodes and RELATES_TO edges
CALL gds.graph.project('hestia-graph', '*', {RELATES_TO: {orientation: 'UNDIRECTED'}})
YIELD graphName, nodeCount, relationshipCount;

-- 2. Run Louvain community detection, write result to each node as .community
CALL gds.louvain.write('hestia-graph', {writeProperty: 'community'})
YIELD communityCount, modularity;

-- 3. Run degree centrality, write result to each node as .degree
CALL gds.degree.write('hestia-graph', {writeProperty: 'degree'})
YIELD nodePropertiesWritten;

-- 4. Drop the temporary in-memory projection (written properties are kept)
CALL gds.graph.drop('hestia-graph') YIELD graphName
RETURN graphName;
```

> **Note on step 4:** Use `YIELD graphName RETURN graphName` to avoid a deprecation warning about the `schema` return field in older GDS versions.

---

## When to recompute

The `community` and `degree` properties are written into the real Neo4j database, so they persist across container restarts without re-running anything.

Recompute when:
- Hestia has had many new conversations (new Graphiti entities/relationships added)
- The graph clusters look stale or don't reflect recent knowledge
- You've done a bulk import into Graphiti

The graph's **↺ refresh button** only re-fetches existing data from Neo4j — it does not recompute GDS. Use **RECOMPUTE** for updated community colors and sizing.

---

## What GDS actually computes

### Louvain community detection → `community` property

Groups nodes into clusters based on how densely they connect to each other. Nodes in the same cluster share a color in the visualization. The value is an integer ID (0, 3, 8, etc.) — not a human label. HestiaClaw uses a 12-color palette cycling through the IDs.

### Degree centrality → `degree` property

Counts how many connections each node has in the projected graph. Higher = larger node in the visualization. A node like "Jason" or "home" will have a high degree and render as a large hub.

### In-memory projection vs. stored properties

- **`hestia-graph` projection** — temporary, lives only in GDS memory during the algorithm run. Dropped at the end.
- **`community` and `degree` properties** — written into the real Neo4j database and persist until overwritten by the next RECOMPUTE.

---

## Verification

```cypher
-- Confirm GDS is loaded
CALL gds.version();

-- Confirm properties were written
MATCH (n:Entity)
WHERE n.community IS NOT NULL
RETURN count(n) AS enrichedNodes;

-- Inspect the distribution
MATCH (n:Entity)
RETURN n.community, n.degree, n.name
ORDER BY n.degree DESC
LIMIT 20;
```

---

## GDS persistence across reboots

- **`/data` volume mounted** → database files (including written node properties) survive restarts.
- **`NEO4J_PLUGINS` in the stack** → GDS plugin is re-downloaded/configured at each container startup, so it's available after a restart.
- **In-memory projection** → gone after restart, but it's dropped at the end of every run anyway, so this doesn't matter.

For a home-lab setup this is fine. For a production pattern, bake the plugin jar into a custom Docker image or mount it via `/plugins` instead of relying on the startup download.
