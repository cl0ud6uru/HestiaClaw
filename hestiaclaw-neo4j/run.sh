#!/bin/bash
set -e

OPTIONS=/data/options.json

PASSWORD=$(jq -r '.password // "changeme"' "$OPTIONS")

export NEO4J_AUTH="neo4j/${PASSWORD}"

# Disable auth rate limiting so bad passwords during setup don't lock the account
export NEO4J_dbms_security_auth__lock__time=0

# Use /data as the Neo4j home so databases persist in the HA data volume
export NEO4J_HOME=/data/neo4j
mkdir -p /data/neo4j

exec neo4j console
