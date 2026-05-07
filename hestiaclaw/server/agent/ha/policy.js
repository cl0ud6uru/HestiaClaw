// Argument-aware Smart Home Policy Engine.
//
// Computes the risk and approval requirements for a resolved (entity, service,
// data) tuple, taking into account the trigger source. This replaces the
// name-pattern heuristics that previously misclassified service calls.
//
// Sources:
//   - 'chat'       — browser chat with approvals available
//   - 'voice'      — Home Assistant voice/Assist (no UI for approvals)
//   - 'webhook'    — external HA webhook (no UI for approvals)
//   - 'automation' — scheduled / triggered automations (no UI for approvals)
//
// Risk levels:
//   - 'low'    — fire-and-forget reads or trivial state changes
//   - 'medium' — stateful changes that are easily reverted
//   - 'high'   — security/safety-sensitive (locks, alarms, garage doors,
//                disabling automations, deleting/wiping)
//   - 'block'  — never permitted from this source

const HIGH_RISK_DOMAINS = new Set(['lock', 'alarm_control_panel'])

const HIGH_RISK_SERVICES = new Set([
  'unlock', 'lock',
  'alarm_arm_away', 'alarm_arm_home', 'alarm_arm_night',
  'alarm_arm_vacation', 'alarm_arm_custom_bypass',
  'alarm_disarm', 'alarm_trigger',
])

const COVER_HIGH_RISK_KEYWORDS = ['garage', 'gate', 'front_door', 'back_door', 'main_door', 'driveway']

const SAFE_DOMAIN_SERVICES = new Set([
  'light.turn_on', 'light.turn_off', 'light.toggle',
  'switch.turn_on', 'switch.turn_off', 'switch.toggle',
  'fan.turn_on', 'fan.turn_off', 'fan.toggle', 'fan.set_percentage',
  'media_player.media_play', 'media_player.media_pause', 'media_player.volume_set',
  'media_player.volume_up', 'media_player.volume_down', 'media_player.media_stop',
  'scene.turn_on',
  'input_boolean.turn_on', 'input_boolean.turn_off', 'input_boolean.toggle',
  'input_select.select_option',
  'input_number.set_value',
])

const MEDIUM_RISK_DOMAIN_SERVICES = new Set([
  'climate.set_temperature', 'climate.set_hvac_mode', 'climate.set_fan_mode',
  'climate.set_humidity', 'climate.turn_on', 'climate.turn_off',
  'cover.open_cover', 'cover.close_cover', 'cover.set_cover_position',
  'cover.stop_cover',
  'script.turn_on', 'script.turn_off',
  'automation.trigger', 'automation.turn_on', 'automation.turn_off',
  'vacuum.start', 'vacuum.stop', 'vacuum.return_to_base',
])

// Per-source policy overrides. A blocked or restricted action stops execution.
// `requireApprovalAt` is the lowest risk that should trigger an approval prompt.
const SOURCE_POLICY = {
  chat:       { requireApprovalAt: 'high', blockAt: null },
  voice:      { requireApprovalAt: null,   blockAt: 'high' },
  webhook:    { requireApprovalAt: null,   blockAt: 'high' },
  automation: { requireApprovalAt: null,   blockAt: 'high' },
}

function isHighRiskCover(entity_id, service) {
  if (!entity_id?.startsWith('cover.')) return false
  if (!['open_cover', 'close_cover', 'toggle', 'set_cover_position'].includes(service)) return false
  const id = entity_id.toLowerCase()
  return COVER_HIGH_RISK_KEYWORDS.some(kw => id.includes(kw))
}

function isAutomationDisable(domain, service) {
  return domain === 'automation' && service === 'turn_off'
}

export function classifyRisk({ domain, service, entity_id }) {
  const key = `${domain}.${service}`

  if (HIGH_RISK_DOMAINS.has(domain)) return 'high'
  if (HIGH_RISK_SERVICES.has(service)) return 'high'
  if (isHighRiskCover(entity_id, service)) return 'high'
  if (isAutomationDisable(domain, service)) return 'high'

  if (MEDIUM_RISK_DOMAIN_SERVICES.has(key)) return 'medium'
  if (SAFE_DOMAIN_SERVICES.has(key)) return 'low'

  // Unknown service in a known-low domain → medium by default. Unknown domain
  // → medium so it gets surfaced rather than silently rubber-stamped.
  return 'medium'
}

const RISK_RANK = { low: 1, medium: 2, high: 3, block: 4 }

function rankAtLeast(level, minimum) {
  if (!minimum) return false
  return RISK_RANK[level] >= RISK_RANK[minimum]
}

export function evaluatePolicy({
  domain,
  service,
  entity_id,
  source = 'chat',
  approvalsAvailable = false,
} = {}) {
  const risk = classifyRisk({ domain, service, entity_id })
  const sourcePolicy = SOURCE_POLICY[source] || SOURCE_POLICY.chat

  // Source-level block (e.g. voice cannot unlock doors).
  if (rankAtLeast(risk, sourcePolicy.blockAt)) {
    return {
      risk,
      allowed: false,
      requiresApproval: false,
      reason: `Risk "${risk}" actions are not permitted from "${source}". Use the browser chat to approve this manually.`,
    }
  }

  if (rankAtLeast(risk, sourcePolicy.requireApprovalAt)) {
    if (!approvalsAvailable) {
      return {
        risk,
        allowed: false,
        requiresApproval: true,
        reason: `Risk "${risk}" requires user approval but the approvals system is not connected for source "${source}".`,
      }
    }
    return {
      risk,
      allowed: true,
      requiresApproval: true,
      reason: `Risk "${risk}" requires user approval — delegate to the underlying ha-mcp tool which is gated by approvals.`,
    }
  }

  return { risk, allowed: true, requiresApproval: false, reason: null }
}
