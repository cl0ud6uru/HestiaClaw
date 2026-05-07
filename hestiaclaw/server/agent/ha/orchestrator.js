// Home Assistant control orchestrator.
//
// Combines the resolver, policy engine, MCP bridge, and verifier into a single
// deterministic pipeline:
//
//   user request -> resolve target -> policy check -> execute service ->
//   verify post-state -> structured result
//
// The orchestrator is the single source of truth for HA control. The agent
// loop never sees ha_call_service directly through this tool — guesswork is
// trapped at the boundary.

import { resolveTarget } from './resolver.js'
import { evaluatePolicy } from './policy.js'
import { callService, getEntityState, isHaMcpAvailable } from './mcp-bridge.js'
import { verifyAction } from './verifier.js'

// Map high-level actions to (domain, service, data-shaping). Domain may be
// derived from the resolved entity if the action is generic.
//
// Each entry is (resolvedDomain) -> { service, mergeData(data) }
const ACTION_MAP = {
  turn_on: {
    light:        { service: 'turn_on' },
    switch:       { service: 'turn_on' },
    fan:          { service: 'turn_on' },
    media_player: { service: 'turn_on' },
    input_boolean:{ service: 'turn_on' },
    automation:   { service: 'turn_on' },
    script:       { service: 'turn_on' },
    scene:        { service: 'turn_on' },
    climate:      { service: 'turn_on' },
  },
  turn_off: {
    light:        { service: 'turn_off' },
    switch:       { service: 'turn_off' },
    fan:          { service: 'turn_off' },
    media_player: { service: 'turn_off' },
    input_boolean:{ service: 'turn_off' },
    automation:   { service: 'turn_off' },
    script:       { service: 'turn_off' },
    climate:      { service: 'turn_off' },
  },
  toggle: {
    light:        { service: 'toggle' },
    switch:       { service: 'toggle' },
    fan:          { service: 'toggle' },
    input_boolean:{ service: 'toggle' },
  },
  set_brightness: {
    light: {
      service: 'turn_on',
      mergeData(data) {
        const out = { ...(data || {}) }
        if (out.brightness == null && out.brightness_pct == null && data?.value != null) {
          out.brightness_pct = Number(data.value)
        }
        return out
      },
    },
  },
  set_color: {
    light: { service: 'turn_on' },
  },
  set_temperature: {
    climate: {
      service: 'set_temperature',
      mergeData(data) {
        const out = { ...(data || {}) }
        if (out.temperature == null && data?.value != null) out.temperature = Number(data.value)
        return out
      },
    },
  },
  set_hvac_mode: {
    climate: { service: 'set_hvac_mode' },
  },
  open: {
    cover: { service: 'open_cover' },
  },
  close: {
    cover: { service: 'close_cover' },
  },
  stop: {
    cover:        { service: 'stop_cover' },
    media_player: { service: 'media_stop' },
    vacuum:       { service: 'stop' },
  },
  set_position: {
    cover: {
      service: 'set_cover_position',
      mergeData(data) {
        const out = { ...(data || {}) }
        if (out.position == null && data?.value != null) out.position = Number(data.value)
        return out
      },
    },
  },
  lock: {
    lock: { service: 'lock' },
  },
  unlock: {
    lock: { service: 'unlock' },
  },
  activate: {
    scene:  { service: 'turn_on' },
    script: { service: 'turn_on' },
  },
  trigger: {
    automation: { service: 'trigger' },
    script:     { service: 'turn_on' },
  },
  play: {
    media_player: { service: 'media_play' },
  },
  pause: {
    media_player: { service: 'media_pause' },
  },
  set_volume: {
    media_player: {
      service: 'volume_set',
      mergeData(data) {
        const out = { ...(data || {}) }
        if (out.volume_level == null && data?.value != null) out.volume_level = Number(data.value)
        return out
      },
    },
  },
}

// Some action names are aliases.
const ACTION_ALIASES = {
  on: 'turn_on',
  off: 'turn_off',
  switch_on: 'turn_on',
  switch_off: 'turn_off',
  brightness: 'set_brightness',
  color: 'set_color',
  temperature: 'set_temperature',
  hvac_mode: 'set_hvac_mode',
  open_cover: 'open',
  close_cover: 'close',
  set_cover_position: 'set_position',
  position: 'set_position',
  volume: 'set_volume',
  volume_set: 'set_volume',
  scene_activate: 'activate',
}

function normalizeAction(action) {
  if (!action) return null
  const a = String(action).toLowerCase().trim()
  return ACTION_ALIASES[a] || a
}

export function describeCandidate(c) {
  return {
    entity_id: c.entity_id,
    name: c.name,
    area: c.area,
    domain: c.domain,
    state: c.state,
    score: c.score,
    reasons: c.reasons,
  }
}

function pickServiceForResolved(action, domain) {
  const map = ACTION_MAP[action]
  if (!map) return null
  return map[domain] || null
}

function inferDomainFromAction(action) {
  // If the action is only meaningful for one domain, we can hint at it.
  const map = ACTION_MAP[action]
  if (!map) return null
  const domains = Object.keys(map)
  if (domains.length === 1) return domains[0]
  return null
}

export async function orchestrateHaControl(registry, input = {}, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)))
  const source = input.source || deps.source || 'chat'
  const approvalsAvailable = Boolean(deps.approvalsAvailable)

  if (!isHaMcpAvailable(registry)) {
    return {
      ok: false,
      stage: 'preflight',
      message: 'Home Assistant control is unavailable — the ha-mcp server is not connected.',
    }
  }

  const action = normalizeAction(input.action)
  if (!action) {
    return {
      ok: false,
      stage: 'preflight',
      message: 'Missing required field "action". Use one of: turn_on, turn_off, toggle, set_brightness, set_color, set_temperature, set_hvac_mode, open, close, stop, set_position, lock, unlock, activate, trigger, play, pause, set_volume.',
    }
  }
  if (!ACTION_MAP[action]) {
    return {
      ok: false,
      stage: 'preflight',
      message: `Unknown action "${input.action}". Use the legacy ha_execute_service tool for arbitrary HA service calls.`,
    }
  }

  if (!input.target && !input.entity_id) {
    return {
      ok: false,
      stage: 'preflight',
      message: 'Provide either "target" (e.g. "kitchen lights") or "entity_id" (e.g. "light.kitchen_lights").',
    }
  }

  // 1. Resolve the target.
  const domainHint = input.domain || inferDomainFromAction(action)
  const resolution = await resolveTarget(registry, {
    target: input.target || '',
    area: input.area || null,
    domain: domainHint,
    entity_id: input.entity_id || null,
    limit: 5,
  })

  if (!resolution.candidates.length) {
    return {
      ok: false,
      stage: 'resolve',
      resolution,
      message: `Could not find any Home Assistant entity matching "${input.target || input.entity_id}"${input.area ? ` in area "${input.area}"` : ''}. Refuse to act on a guess — ask the user for clarification or call ha_resolve_target with a different query.`,
    }
  }

  const top = resolution.candidates[0]
  if (resolution.confidence === 'low') {
    return {
      ok: false,
      stage: 'resolve',
      resolution: { ...resolution, candidates: resolution.candidates.map(describeCandidate) },
      message: `Low-confidence match for "${input.target || input.entity_id}". Top candidates: ${resolution.candidates.slice(0, 3).map(c => c.entity_id).join(', ')}. Confirm with the user or pass entity_id explicitly before acting.`,
    }
  }

  // 2. Service mapping for the resolved domain.
  const serviceMap = pickServiceForResolved(action, top.domain)
  if (!serviceMap) {
    const supportedDomains = Object.keys(ACTION_MAP[action] || {})
    return {
      ok: false,
      stage: 'resolve',
      resolution: { ...resolution, candidates: resolution.candidates.map(describeCandidate) },
      message: `Action "${action}" is not defined for domain "${top.domain}" (supported: ${supportedDomains.join(', ') || 'none'}). Resolved entity ${top.entity_id} would be the wrong target — refuse and clarify with the user.`,
    }
  }

  const callData = serviceMap.mergeData ? serviceMap.mergeData(input.params || input.data || {}) : (input.params || input.data || undefined)
  const callPayload = {
    domain: top.domain,
    service: serviceMap.service,
    entity_id: top.entity_id,
    data: callData,
  }

  // 3. Policy check.
  const policy = evaluatePolicy({
    domain: callPayload.domain,
    service: callPayload.service,
    entity_id: callPayload.entity_id,
    source,
    approvalsAvailable,
  })

  if (!policy.allowed) {
    return {
      ok: false,
      stage: 'policy',
      resolved: describeCandidate(top),
      action: callPayload,
      policy,
      message: policy.reason,
    }
  }

  if (policy.requiresApproval) {
    if (typeof deps.requestApproval !== 'function') {
      return {
        ok: false,
        stage: 'requires_approval',
        resolved: describeCandidate(top),
        action: callPayload,
        policy,
        message: `${callPayload.domain}.${callPayload.service} on ${callPayload.entity_id} is risk="${policy.risk}" and requires user approval, but no approval callback is available.`,
      }
    }
    await deps.requestApproval({
      name: 'ha_control',
      input: {
        target: input.target || null,
        entity_id: top.entity_id,
        action,
        service_call: callPayload,
      },
      risk: policy.risk,
      kind: 'write',
    })
  }

  // 4. Read pre-state for verification (optional — failures are non-fatal).
  const preState = await getEntityState(registry, top.entity_id).catch(() => null)

  // 5. Execute.
  let executeResult
  try {
    executeResult = await callService(registry, callPayload)
  } catch (err) {
    return {
      ok: false,
      stage: 'execute',
      resolved: describeCandidate(top),
      action: callPayload,
      policy,
      pre_state: preState ? { state: preState.state, attributes: preState.attributes } : null,
      error: err.message,
      message: `Failed to execute ${callPayload.domain}.${callPayload.service} on ${callPayload.entity_id}: ${err.message}. Do not retry with the same arguments — surface this error to the user.`,
    }
  }

  // 6. Verify.
  const verification = await verifyAction(registry, {
    entity_id: top.entity_id,
    domain: callPayload.domain,
    service: callPayload.service,
    data: callData || {},
    preState,
    sleep,
  })

  return {
    ok: verification.verified,
    stage: 'verified',
    resolved: describeCandidate(top),
    action: callPayload,
    policy,
    pre_state: preState ? { state: preState.state, attributes: preState.attributes } : null,
    post_state: verification.postState,
    verification,
    raw_result: typeof executeResult === 'string' ? executeResult.slice(0, 500) : executeResult,
    message: verification.verified
      ? `${callPayload.domain}.${callPayload.service} on ${top.entity_id} (${top.name}) — ${verification.message}`
      : `${callPayload.domain}.${callPayload.service} dispatched on ${top.entity_id} but verification failed: ${verification.message}`,
  }
}

export async function orchestrateResolveTarget(registry, input = {}) {
  if (!isHaMcpAvailable(registry)) {
    return { ok: false, message: 'Home Assistant control is unavailable — the ha-mcp server is not connected.', candidates: [] }
  }
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20)
  const resolution = await resolveTarget(registry, {
    target: input.target || '',
    area: input.area || null,
    domain: input.domain || null,
    limit,
  })
  return {
    ok: resolution.candidates.length > 0,
    confidence: resolution.confidence,
    candidates: resolution.candidates.map(describeCandidate),
    domain_hints: resolution.domainHints,
    total_considered: resolution.totalConsidered,
  }
}
