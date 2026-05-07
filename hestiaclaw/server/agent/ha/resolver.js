// Deterministic Home Assistant target resolver.
//
// Given a user-facing target ("kitchen lights"), an optional area hint, and
// an optional domain hint, return ranked candidate entities with explicit
// scores and reasons. The scoring is deterministic and explainable so that
// the orchestrator can refuse to act on a low-confidence guess.

import { searchEntities } from './mcp-bridge.js'

const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'of', 'and', 'or',
  'please', 'turn', 'set', 'switch', 'make', 'all', 'my', 'our',
])

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t))
}

function uniq(values) {
  return Array.from(new Set(values))
}

// Build a normalized comparable form: lowercase, alnum-only, '_'/space collapsed.
function norm(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokensOf(entity) {
  const out = []
  if (entity.entity_id) out.push(...tokenize(entity.entity_id.split('.')[1] || ''))
  if (entity.name) out.push(...tokenize(entity.name))
  if (entity.area) out.push(...tokenize(entity.area))
  return uniq(out)
}

// Domain hints derived from English verbs/phrases. Used when the caller did
// not specify a domain explicitly, to prefer entities of the relevant type.
const ACTION_DOMAIN_HINTS = {
  light: ['light', 'lights', 'lamp', 'bulb', 'sconce', 'chandelier'],
  switch: ['switch', 'plug', 'outlet'],
  fan: ['fan'],
  cover: ['blind', 'blinds', 'shade', 'shades', 'curtain', 'curtains', 'cover', 'garage', 'door', 'shutter'],
  climate: ['thermostat', 'climate', 'heater', 'ac', 'temperature', 'hvac'],
  lock: ['lock'],
  scene: ['scene'],
  script: ['script'],
  automation: ['automation', 'routine'],
  media_player: ['tv', 'speaker', 'music', 'media', 'sonos', 'player'],
  vacuum: ['vacuum', 'roomba'],
}

export function inferDomainHints(target) {
  const tokens = new Set(tokenize(target))
  const hits = new Set()
  for (const [domain, keywords] of Object.entries(ACTION_DOMAIN_HINTS)) {
    for (const kw of keywords) {
      if (tokens.has(kw)) hits.add(domain)
    }
  }
  return Array.from(hits)
}

export function scoreCandidate({ entity, target, area, domain, domainHints }) {
  const reasons = []
  let score = 0

  const targetNorm = norm(target)
  const targetTokens = tokenize(target)
  const entityIdTail = entity.entity_id.split('.')[1] || ''
  const entityNameNorm = norm(entity.name)
  const entityIdNorm = norm(entityIdTail)
  const entityAreaNorm = norm(entity.area || '')
  const entityTokens = tokensOf(entity)

  // 1. Exact entity_id match — highest signal.
  if (target && targetNorm === norm(entity.entity_id)) {
    score += 200
    reasons.push('exact_entity_id')
  }

  // 2. Exact friendly_name match.
  if (targetNorm && entityNameNorm && targetNorm === entityNameNorm) {
    score += 150
    reasons.push('exact_name')
  } else if (targetNorm && entityIdNorm && targetNorm === entityIdNorm) {
    score += 130
    reasons.push('exact_object_id')
  }

  // 3. All target tokens contained in entity name OR id.
  if (targetTokens.length > 0) {
    const matched = targetTokens.filter(t =>
      entityNameNorm.includes(t) || entityIdNorm.includes(t),
    )
    if (matched.length === targetTokens.length) {
      score += 80
      reasons.push('all_tokens_match')
    } else if (matched.length > 0) {
      score += 25 * matched.length
      reasons.push(`partial_tokens(${matched.length}/${targetTokens.length})`)
    }
  }

  // 4. Token overlap (broader): how many target tokens appear in any field.
  const overlap = targetTokens.filter(t => entityTokens.includes(t)).length
  if (overlap > 0) {
    score += 5 * overlap
    reasons.push(`token_overlap(${overlap})`)
  }

  // 5. Area boost.
  if (area) {
    const areaNorm = norm(area)
    if (areaNorm && entityAreaNorm === areaNorm) {
      score += 60
      reasons.push('area_exact')
    } else if (areaNorm && entityIdNorm.includes(areaNorm.replace(/ /g, '_'))) {
      score += 40
      reasons.push('area_in_object_id')
    }
  } else if (targetTokens.length > 0 && entityAreaNorm) {
    // The user mentioned "kitchen" inside the target — give credit if the
    // entity's area matches one of the target tokens.
    const areaTokens = tokenize(entity.area)
    const areaMatches = targetTokens.filter(t => areaTokens.includes(t)).length
    if (areaMatches > 0) {
      score += 25 * areaMatches
      reasons.push(`area_token_match(${areaMatches})`)
    }
  }

  // 6. Domain matching.
  if (domain) {
    if (entity.domain === domain) {
      score += 50
      reasons.push('domain_match')
    } else {
      score -= 80
      reasons.push('domain_mismatch')
    }
  } else if (domainHints && domainHints.length > 0) {
    if (domainHints.includes(entity.domain)) {
      score += 30
      reasons.push('domain_hint_match')
    }
  }

  // 7. Prefer group/aggregate entities (e.g. light.kitchen_lights) when the
  // user used a plural ("lights"). This handles the canonical bug where
  // light.kitchen does not exist but light.kitchen_lights does.
  if (/s\b/.test(targetNorm) && /_(?:lights|switches|fans|covers|locks|group)$/.test(entityIdTail)) {
    score += 20
    reasons.push('plural_group_match')
  }
  if (/_lights?$|_group$|_all$|^all_/.test(entityIdTail)) {
    score += 5
    reasons.push('group_like')
  }

  // 8. Penalise unavailable entities.
  if (entity.state === 'unavailable' || entity.state === 'unknown') {
    score -= 30
    reasons.push('unavailable')
  }

  return { score, reasons }
}

function classifyConfidence(score, candidates) {
  if (candidates.length === 0) return 'none'
  if (score >= 150) return 'high'
  if (score >= 60) {
    if (candidates.length >= 2 && (candidates[0].score - candidates[1].score) < 15) return 'low'
    return 'medium'
  }
  if (score > 0) return 'low'
  return 'none'
}

export async function resolveTarget(registry, {
  target = '',
  area = null,
  domain = null,
  entity_id = null,
  limit = 5,
} = {}) {
  // Caller already knows the entity_id — short-circuit but still verify it
  // appears in the inventory (so we can attach state and detect typos).
  if (entity_id) {
    const lookup = await searchEntities(registry, { query: entity_id })
    const exact = lookup.entities.find(e => e.entity_id === entity_id)
    if (exact) {
      return {
        confidence: 'high',
        candidates: [{ ...exact, score: 200, reasons: ['caller_provided_entity_id'] }],
        domainHints: domain ? [domain] : inferDomainHints(target),
        searchAvailable: lookup.available,
      }
    }
    // Caller-provided entity_id but search didn't return it. Surface as a
    // single low-confidence candidate so the orchestrator can decide.
    return {
      confidence: lookup.available ? 'low' : 'medium',
      candidates: [{
        entity_id,
        domain: entity_id.split('.')[0],
        name: entity_id.split('.')[1].replace(/_/g, ' '),
        area: null,
        state: null,
        attributes: {},
        score: lookup.available ? 30 : 80,
        reasons: lookup.available ? ['caller_provided_entity_id', 'not_found_in_search'] : ['caller_provided_entity_id', 'search_unavailable'],
      }],
      domainHints: domain ? [domain] : inferDomainHints(target),
      searchAvailable: lookup.available,
    }
  }

  const domainHints = domain ? [domain] : inferDomainHints(target)
  const queryParts = uniq([target, area].filter(Boolean).map(String))
  const query = queryParts.join(' ').trim()
  const lookup = await searchEntities(registry, { query, area, domain })
  if (!lookup.available) {
    return { confidence: 'none', candidates: [], domainHints, searchAvailable: false }
  }

  const scored = lookup.entities
    .map(entity => {
      const { score, reasons } = scoreCandidate({ entity, target, area, domain, domainHints })
      return { ...entity, score, reasons }
    })
    // When the caller supplies an explicit domain hint, exclude wrong-domain
    // matches outright — they should not show up as alternatives.
    .filter(c => c.score > 0 && (!domain || c.domain === domain))
    .sort((a, b) => b.score - a.score)

  const top = scored.slice(0, limit)
  const confidence = classifyConfidence(top[0]?.score || 0, top)
  return {
    confidence,
    candidates: top,
    domainHints,
    searchAvailable: true,
    totalConsidered: lookup.entities.length,
  }
}
