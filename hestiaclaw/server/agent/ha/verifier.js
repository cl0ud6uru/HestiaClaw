// Domain-aware post-action verification.
//
// After a service call returns "successfully" at the API layer, we re-read the
// entity state and compare it against an expected outcome derived from the
// (domain, service, data) tuple. If the observed state matches, the
// orchestrator reports a verified success; otherwise it surfaces the mismatch
// honestly so the model does not hallucinate a successful action.

import { getEntityState } from './mcp-bridge.js'

// How long to wait between issuing the call and re-reading state. Some
// transitions (covers opening, climate ramping) take longer than instant
// state changes, so we use a per-domain delay.
const VERIFY_DELAY_MS = {
  light: 200,
  switch: 200,
  fan: 250,
  scene: 300,
  script: 300,
  automation: 200,
  input_boolean: 100,
  input_select: 100,
  input_number: 100,
  media_player: 400,
  climate: 600,
  cover: 800,
  lock: 600,
  vacuum: 600,
}

const DEFAULT_VERIFY_DELAY_MS = 300

const TURN_ON_SERVICES = new Set(['turn_on', 'toggle', 'open', 'open_cover', 'unlock', 'start', 'media_play'])
const TURN_OFF_SERVICES = new Set(['turn_off', 'close', 'close_cover', 'lock', 'stop', 'media_stop', 'media_pause'])

function expectedStateFor({ domain, service, prevState }) {
  // Toggle: predicted opposite of previous state (when known).
  if (service === 'toggle') {
    if (prevState === 'on') return 'off'
    if (prevState === 'off') return 'on'
    return null
  }

  // Domain-specific overrides.
  if (domain === 'cover') {
    if (service === 'open_cover') return ['open', 'opening']
    if (service === 'close_cover') return ['closed', 'closing']
    if (service === 'stop_cover') return null
  }
  if (domain === 'lock') {
    if (service === 'lock') return 'locked'
    if (service === 'unlock') return 'unlocked'
  }
  if (domain === 'media_player') {
    if (service === 'media_play') return ['playing', 'on']
    if (service === 'media_pause') return ['paused', 'idle', 'on']
    if (service === 'media_stop') return ['idle', 'off', 'standby']
  }
  if (domain === 'climate' && service === 'set_temperature') return null
  if (domain === 'climate' && service === 'set_hvac_mode') return null
  if (domain === 'scene' || domain === 'script' || domain === 'automation') {
    return null  // no observable state on the entity itself
  }
  if (domain === 'vacuum') {
    if (service === 'start') return ['cleaning', 'returning']
    if (service === 'stop') return ['idle', 'docked']
    if (service === 'return_to_base') return ['returning', 'docked']
  }

  if (TURN_ON_SERVICES.has(service)) return 'on'
  if (TURN_OFF_SERVICES.has(service)) return 'off'
  return null
}

function attributeExpectations({ domain, service, data = {} }) {
  const expectations = []
  if (!data || typeof data !== 'object') return expectations

  if (domain === 'light' && service === 'turn_on') {
    if (data.brightness != null) expectations.push({ attribute: 'brightness', expected: data.brightness, tolerance: 5 })
    if (data.brightness_pct != null) expectations.push({ attribute: 'brightness_pct', expected: data.brightness_pct, tolerance: 5, derive: 'brightness_pct' })
    if (data.color_temp != null) expectations.push({ attribute: 'color_temp', expected: data.color_temp, tolerance: 20 })
  }
  if (domain === 'climate' && service === 'set_temperature') {
    if (data.temperature != null) expectations.push({ attribute: 'temperature', expected: data.temperature, tolerance: 0.5 })
    if (data.target_temp_high != null) expectations.push({ attribute: 'target_temp_high', expected: data.target_temp_high, tolerance: 0.5 })
    if (data.target_temp_low != null) expectations.push({ attribute: 'target_temp_low', expected: data.target_temp_low, tolerance: 0.5 })
  }
  if (domain === 'climate' && service === 'set_hvac_mode' && data.hvac_mode) {
    expectations.push({ attribute: 'hvac_mode', expected: data.hvac_mode })
  }
  if (domain === 'cover' && service === 'set_cover_position' && data.position != null) {
    expectations.push({ attribute: 'current_position', expected: data.position, tolerance: 5 })
  }
  if (domain === 'fan' && service === 'set_percentage' && data.percentage != null) {
    expectations.push({ attribute: 'percentage', expected: data.percentage, tolerance: 5 })
  }
  if (domain === 'media_player' && service === 'volume_set' && data.volume_level != null) {
    expectations.push({ attribute: 'volume_level', expected: data.volume_level, tolerance: 0.05 })
  }
  return expectations
}

function deriveAttributeValue(attrs, derive) {
  if (derive === 'brightness_pct') {
    const b = attrs.brightness
    if (typeof b !== 'number') return null
    return Math.round((b / 255) * 100)
  }
  return null
}

function compareState(actual, expected) {
  if (expected == null) return { matched: null }  // not asserted
  const list = Array.isArray(expected) ? expected : [expected]
  if (actual == null) return { matched: false, reason: 'no_state_returned', actual, expected }
  const a = String(actual).toLowerCase()
  for (const e of list) {
    if (a === String(e).toLowerCase()) return { matched: true, actual, expected }
  }
  return { matched: false, reason: 'state_mismatch', actual, expected }
}

function compareAttributes(attrs, expectations) {
  const results = []
  for (const ex of expectations) {
    const value = ex.derive
      ? deriveAttributeValue(attrs, ex.derive)
      : attrs?.[ex.attribute]
    if (value == null) {
      results.push({ ok: false, attribute: ex.attribute, expected: ex.expected, observed: null, reason: 'missing' })
      continue
    }
    if (ex.tolerance != null) {
      const ok = Math.abs(Number(value) - Number(ex.expected)) <= ex.tolerance
      results.push({ ok, attribute: ex.attribute, expected: ex.expected, observed: value, tolerance: ex.tolerance })
    } else {
      const ok = String(value).toLowerCase() === String(ex.expected).toLowerCase()
      results.push({ ok, attribute: ex.attribute, expected: ex.expected, observed: value })
    }
  }
  return results
}

export async function verifyAction(registry, {
  entity_id,
  domain,
  service,
  data = {},
  preState = null,
  delayMs = null,
  sleep = null,
} = {}) {
  const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)))
  const expectedState = expectedStateFor({ domain, service, prevState: preState?.state })
  const attrExpectations = attributeExpectations({ domain, service, data })
  const fireAndForget = expectedState == null && attrExpectations.length === 0

  // Stateless calls (scene/script/automation/etc.) — nothing to verify against.
  if (fireAndForget) {
    return {
      verified: true,
      fireAndForget: true,
      expectedState: null,
      postState: null,
      attributeChecks: [],
      message: `${domain}.${service} dispatched (stateless action — no entity state to verify).`,
    }
  }

  const effectiveDelay = delayMs != null ? delayMs : (VERIFY_DELAY_MS[domain] ?? DEFAULT_VERIFY_DELAY_MS)
  if (effectiveDelay > 0) await wait(effectiveDelay)

  const post = await getEntityState(registry, entity_id)
  if (!post) {
    return {
      verified: false,
      reason: 'no_post_state',
      expectedState,
      postState: null,
      attributeChecks: [],
      message: 'Service call dispatched, but the entity state could not be re-read to verify the change.',
    }
  }

  const stateCheck = compareState(post.state, expectedState)
  const attrChecks = compareAttributes(post.attributes || {}, attrExpectations)
  const stateOk = stateCheck.matched !== false  // true OR null (not asserted)
  const attrOk = attrChecks.every(c => c.ok)
  const verified = stateOk && attrOk

  let message
  if (verified) {
    const stateNote = stateCheck.matched ? `state=${post.state}` : 'state ok'
    message = `${entity_id}: ${stateNote}`
    if (attrChecks.length > 0) {
      message += `; ${attrChecks.map(c => `${c.attribute}=${c.observed}`).join(', ')}`
    }
  } else {
    const failures = []
    if (stateCheck.matched === false) failures.push(`expected state ${JSON.stringify(stateCheck.expected)} but got "${stateCheck.actual}"`)
    for (const c of attrChecks) {
      if (!c.ok) failures.push(`expected ${c.attribute}=${c.expected} but got ${c.observed}`)
    }
    message = `${entity_id} did not reach the expected state — ${failures.join('; ')}.`
  }

  return {
    verified,
    expectedState,
    postState: { state: post.state, attributes: post.attributes },
    stateCheck,
    attributeChecks: attrChecks,
    message,
  }
}
