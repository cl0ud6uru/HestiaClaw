// Defensive bridge between the orchestrator and the underlying ha-mcp tools.
// ha-mcp may register tools under slightly different names across versions
// (ha_call_service vs call_service, etc.) and returns text content rather
// than structured objects. This module hides that variability.

const SEARCH_TOOL_CANDIDATES = [
  'home-assistant__ha_search_entities',
  'home-assistant__search_entities',
  'home-assistant__ha_list_entities',
  'home-assistant__list_entities',
  'home-assistant__ha_get_entities',
  'home-assistant__get_entities',
]

const GET_ENTITY_TOOL_CANDIDATES = [
  'home-assistant__ha_get_entity',
  'home-assistant__get_entity',
  'home-assistant__ha_get_state',
  'home-assistant__get_state',
]

const CALL_SERVICE_TOOL_CANDIDATES = [
  'home-assistant__ha_call_service',
  'home-assistant__call_service',
  'home-assistant__ha_execute_service',
  'home-assistant__execute_service',
]

export function findTool(registry, candidates) {
  for (const name of candidates) {
    if (registry.has(name)) return name
  }
  return null
}

export function searchToolName(registry) { return findTool(registry, SEARCH_TOOL_CANDIDATES) }
export function getEntityToolName(registry) { return findTool(registry, GET_ENTITY_TOOL_CANDIDATES) }
export function callServiceToolName(registry) { return findTool(registry, CALL_SERVICE_TOOL_CANDIDATES) }

export function isHaMcpAvailable(registry) {
  return Boolean(callServiceToolName(registry))
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

// MCP tools return their content as joined text. Some servers stringify JSON
// objects, others emit human-readable lines. We try JSON first, then fall back
// to line-oriented parsing that recognises `entity_id` patterns.

const ENTITY_ID_RE = /\b([a-z][a-z0-9_]*\.[a-z0-9_]+)\b/i

function tryParseJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!/^[[{"]/.test(trimmed) && !/```/.test(trimmed)) return null
  // Strip common markdown fences
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  // Sometimes the result wraps multiple JSON objects, NDJSON-style.
  if (stripped.includes('\n')) {
    const objects = []
    for (const line of stripped.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { objects.push(JSON.parse(t)) } catch { /* ignore */ }
    }
    if (objects.length > 0) return objects
  }
  return null
}

function normalizeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null
  const entity_id = raw.entity_id || raw.entityId || raw.id || null
  if (!entity_id || typeof entity_id !== 'string' || !entity_id.includes('.')) return null
  const domain = entity_id.split('.')[0]
  const attributes = raw.attributes || raw.attrs || {}
  const name =
    raw.friendly_name ||
    raw.name ||
    attributes.friendly_name ||
    entity_id.split('.')[1].replace(/_/g, ' ')
  const area =
    raw.area_name ||
    raw.area ||
    raw.area_id ||
    attributes.area ||
    null
  const state = raw.state ?? raw.value ?? null
  return { entity_id, domain, name: String(name), area: area ? String(area) : null, state, attributes }
}

// Parse an unstructured text blob into entity records. Each `entity_id` token
// becomes a record. We pull the surrounding line as a (rough) friendly name and
// look for `state: x` and `area: x` markers.
function parseEntitiesFromText(text) {
  const out = []
  const seen = new Set()
  if (typeof text !== 'string') return out
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(ENTITY_ID_RE)
    if (!match) continue
    const entity_id = match[1].toLowerCase()
    if (seen.has(entity_id)) continue
    seen.add(entity_id)
    const domain = entity_id.split('.')[0]
    const stateMatch = line.match(/state[:=]\s*([^\s,;]+)/i) || line.match(/\bis\s+([a-z_]+)\b/i)
    const areaMatch = line.match(/area[:=]\s*([^,;]+?)(?:[,;]|$)/i) ||
                      line.match(/in\s+the\s+([a-z0-9_\- ]+?)\s+(?:area|room)/i)
    const nameMatch = line.match(/(?:name|friendly_name)[:=]\s*([^,;]+?)(?:[,;]|$)/i) ||
                      line.match(/^[-*]\s+([^()]+?)\s*[(:]/)
    out.push({
      entity_id,
      domain,
      name: nameMatch ? nameMatch[1].trim() : entity_id.split('.')[1].replace(/_/g, ' '),
      area: areaMatch ? areaMatch[1].trim() : null,
      state: stateMatch ? stateMatch[1].trim().toLowerCase() : null,
      attributes: {},
    })
  }
  return out
}

export function parseEntitiesResult(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return raw.map(normalizeEntity).filter(Boolean)
  }
  if (typeof raw === 'object') {
    const single = normalizeEntity(raw)
    if (single) return [single]
    for (const key of ['entities', 'results', 'items', 'data']) {
      if (Array.isArray(raw[key])) return raw[key].map(normalizeEntity).filter(Boolean)
    }
    return []
  }
  if (typeof raw !== 'string') return []
  const json = tryParseJson(raw)
  if (json) return parseEntitiesResult(json)
  return parseEntitiesFromText(raw)
}

export function parseEntityStateResult(raw) {
  const entities = parseEntitiesResult(raw)
  return entities[0] || null
}

// ---------------------------------------------------------------------------
// Underlying tool invocations
// ---------------------------------------------------------------------------

export async function searchEntities(registry, { query, area, domain } = {}) {
  const tool = searchToolName(registry)
  if (!tool) return { available: false, entities: [] }
  const queryParts = []
  if (query) queryParts.push(query)
  if (area && !query?.toLowerCase().includes(String(area).toLowerCase())) queryParts.push(String(area))
  if (domain && !query?.toLowerCase().includes(`${domain}.`)) queryParts.push(domain)
  const q = queryParts.join(' ').trim() || (domain ? `${domain}.` : '')
  try {
    const raw = await registry.execute(tool, q ? { query: q } : {})
    return { available: true, entities: parseEntitiesResult(raw), raw }
  } catch (err) {
    return { available: true, entities: [], error: err.message }
  }
}

export async function getEntityState(registry, entity_id) {
  const tool = getEntityToolName(registry)
  if (!tool) return null
  try {
    const raw = await registry.execute(tool, { entity_id })
    return parseEntityStateResult(raw)
  } catch {
    return null
  }
}

export async function callService(registry, { domain, service, entity_id, data }) {
  const tool = callServiceToolName(registry)
  if (!tool) throw new Error('ha-mcp call-service tool is not registered')
  const input = {
    domain,
    service,
    ...(entity_id ? { entity_id } : {}),
    ...(data && Object.keys(data).length ? { data } : {}),
  }
  return registry.execute(tool, input)
}
