FROM neo4j:2026-community

RUN apk add --no-cache jq 2>/dev/null || apt-get install -y --no-install-recommends jq 2>/dev/null || true

ENV NEO4J_PLUGINS='["graph-data-science"]'
ENV NEO4J_dbms_memory_heap_initial__size=512m
ENV NEO4J_dbms_memory_heap_max__size=1G
ENV NEO4J_dbms_memory_pagecache_size=512m

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
