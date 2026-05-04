#!/bin/bash
set -e

OPTIONS=/data/options.json

PASSWORD=$(jq -r '.password // "changeme"' "$OPTIONS")

export NEO4J_AUTH="neo4j/${PASSWORD}"

# Use /data as the Neo4j home so databases persist in the HA data volume
export NEO4J_HOME=/data/neo4j
mkdir -p /data/neo4j

exec neo4j console
