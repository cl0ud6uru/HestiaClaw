// Home Assistant facade tools.
//
// `ha_control` is the primary model-facing write tool for device control. It
// resolves the target deterministically, checks the smart-home policy, calls
// the underlying ha-mcp service, and verifies the post-action state. The
// model never has to invent an entity_id — it provides a target description
// (e.g. "kitchen lights") and an action.
//
// `ha_resolve_target` exposes the resolver transparently so the model can
// preview ranked candidates without committing to an action.
//
// `ha_get_area_summary` returns structured ranked candidates (no longer a
// truncated text blob).
//
// `ha_execute_service` is retained as a legacy fallback for arbitrary HA
// service calls. The model is steered toward ha_control for normal device
// operations.

import {
  orchestrateHaControl,
  orchestrateResolveTarget,
} from '../../ha/orchestrator.js'
import { resolveTarget } from '../../ha/resolver.js'
import { callServiceToolName } from '../../ha/mcp-bridge.js'

const HIGH_RISK_HA_DOMAINS = new Set(['lock', 'alarm_control_panel'])
const HIGH_RISK_HA_SERVICES = new Set(['unlock', 'lock', 'open', 'close', 'alarm_disarm', 'alarm_trigger'])

function isHighRiskHaAction(domain, service) {
  return HIGH_RISK_HA_DOMAINS.has(domain) || HIGH_RISK_HA_SERVICES.has(service)
}

function jsonString(value) {
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

export function registerHaFacade(registry, options = {}) {
  const approvalsAvailable = options.approvalsAvailable !== false  // default true at chat scope

  // -------------------------------------------------------------------------
  // ha_control — primary model-facing write tool
  // -------------------------------------------------------------------------
  registry.register(
    'ha_control',
    'Control a Home Assistant device deterministically. Provide a natural-language target (e.g. "kitchen lights") and a high-level action (e.g. "turn_on"). The orchestrator resolves the actual entity_id from the HA inventory, applies the smart-home safety policy, executes the underlying service, and re-reads the entity state to verify the change. ' +
    'Use this for almost all device control. Never invent an entity_id — pass the target description in plain words. If the target is ambiguous, the tool returns ranked candidates and refuses to act; ask the user to clarify or pass entity_id explicitly. ' +
    'Supported actions: turn_on, turn_off, toggle, set_brightness, set_color, set_temperature, set_hvac_mode, open, close, stop, set_position, lock, unlock, activate, trigger, play, pause, set_volume. ' +
    'Examples: ' +
    '{target:"kitchen lights",action:"turn_on"} ' +
    '{target:"living room",action:"set_brightness",domain:"light",params:{brightness_pct:60}} ' +
    '{target:"office thermostat",action:"set_temperature",params:{temperature:72}} ' +
    '{target:"goodnight",action:"activate",domain:"scene"} ' +
    '{entity_id:"light.kitchen_lights",action:"turn_off"}',
    {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Natural-language description of the device, e.g. "kitchen lights", "office thermostat", "front door". Combined with optional area/domain hints to deterministically resolve the entity_id.' },
        action: { type: 'string', description: 'High-level action: turn_on, turn_off, toggle, set_brightness, set_color, set_temperature, set_hvac_mode, open, close, stop, set_position, lock, unlock, activate, trigger, play, pause, set_volume.' },
        area: { type: 'string', description: 'Optional area hint to disambiguate ("kitchen", "office", "bedroom").' },
        domain: { type: 'string', description: 'Optional domain hint ("light", "switch", "climate", "scene", "script", etc.) when a single target name spans multiple domains.' },
        entity_id: { type: 'string', description: 'Optional explicit entity_id to bypass resolution when the user has supplied or confirmed it.' },
        params: { type: 'object', description: 'Action-specific parameters: {brightness_pct, color_name, rgb_color, color_temp, transition} for lights; {temperature, hvac_mode} for climate; {position} for covers; {volume_level} for media_player; etc.' },
      },
    },
    async (input, context = {}) => {
      const source = context.source || input.source || 'chat'
      const sourceApprovals = context.approvalsAvailable != null
        ? Boolean(context.approvalsAvailable)
        : (source === 'chat' ? approvalsAvailable : false)
      const result = await orchestrateHaControl(registry, input, {
        approvalsAvailable: sourceApprovals,
        source,
      })
      return jsonString(result)
    },
    { kind: 'write', risk: 'medium', timeoutMs: 20000 },
  )

  // -------------------------------------------------------------------------
  // ha_resolve_target — transparent ranked candidate preview
  // -------------------------------------------------------------------------
  registry.register(
    'ha_resolve_target',
    'Preview the ranked Home Assistant entity candidates that match a target description, without taking any action. Use this when you are about to call ha_control on an unfamiliar target and want to confirm the resolution, or to clarify ambiguous user requests by listing options.',
    {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Natural-language target, e.g. "bedroom light".' },
        area: { type: 'string', description: 'Optional area hint.' },
        domain: { type: 'string', description: 'Optional domain hint ("light", "switch", "climate", etc.).' },
        limit: { type: 'number', description: 'Maximum number of candidates to return (default 5, max 20).' },
      },
      required: ['target'],
    },
    async (input) => {
      const result = await orchestrateResolveTarget(registry, input)
      return jsonString(result)
    },
    { kind: 'read', risk: 'low', timeoutMs: 10000 },
  )

  // -------------------------------------------------------------------------
  // ha_get_area_summary — improved: returns structured ranked entities
  // -------------------------------------------------------------------------
  registry.register(
    'ha_get_area_summary',
    'List the Home Assistant entities in a specific area or room as structured ranked candidates with their current states. Use to discover what is in a room before deciding what to control.',
    {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Area name, e.g. "living room" or "kitchen".' },
        domain: { type: 'string', description: 'Optional domain filter ("light", "switch", "climate", etc.).' },
        limit: { type: 'number', description: 'Max entities to return (default 20).' },
      },
      required: ['area'],
    },
    async ({ area, domain = null, limit = 20 }) => {
      if (!area) return jsonString({ ok: false, message: 'area is required.' })
      const cap = Math.min(Math.max(Number(limit) || 20, 1), 50)
      const resolution = await resolveTarget(registry, { target: area, area, domain, limit: cap })
      const entities = resolution.candidates.map(c => ({
        entity_id: c.entity_id,
        name: c.name,
        domain: c.domain,
        area: c.area,
        state: c.state,
        score: c.score,
      }))
      const byDomain = {}
      for (const e of entities) {
        byDomain[e.domain] = (byDomain[e.domain] || 0) + 1
      }
      return jsonString({
        ok: entities.length > 0,
        area,
        domain_filter: domain,
        total: entities.length,
        domains: byDomain,
        entities,
      })
    },
    { kind: 'read', risk: 'low', timeoutMs: 10000 },
  )

  // -------------------------------------------------------------------------
  // ha_execute_service — legacy fallback for arbitrary service calls
  // -------------------------------------------------------------------------
  registry.register(
    'ha_execute_service',
    'Legacy fallback: execute an arbitrary Home Assistant service call by domain + service + entity_id. Prefer ha_control for normal device operations — it resolves the target, applies policy, and verifies the outcome. Use ha_execute_service only for esoteric services that ha_control does not cover (custom integrations, niche service calls). ' +
    'Examples: {domain:"notify",service:"mobile_app_phone",data:{message:"Hello"}} ' +
    '{domain:"persistent_notification",service:"create",data:{title:"x",message:"y"}}',
    {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'HA domain.' },
        service: { type: 'string', description: 'Service name within the domain.' },
        entity_id: { type: 'string', description: 'Optional target entity_id (some services do not target a single entity).' },
        data: { type: 'object', description: 'Additional service parameters.' },
      },
      required: ['domain', 'service'],
    },
    async ({ domain, service, entity_id, data, service_data }) => {
      const callTool = callServiceToolName(registry)
      if (!callTool) {
        return 'Home Assistant service execution is not available — the ha-mcp server may not be connected.'
      }
      if (isHighRiskHaAction(domain, service)) {
        return `${domain}.${service} is a security-sensitive action. Use the native Home Assistant MCP tool for this domain/service — it will prompt for approval before executing.`
      }
      try {
        const resolvedEntityId = entity_id || service_data?.entity_id
        let resolvedData = data
        if (!resolvedData && service_data) {
          const rest = { ...service_data }
          delete rest.entity_id
          if (Object.keys(rest).length) resolvedData = rest
        }
        const input = {
          domain,
          service,
          ...(resolvedEntityId ? { entity_id: resolvedEntityId } : {}),
          ...(resolvedData ? { data: resolvedData } : {}),
        }
        const result = await registry.execute(callTool, input)
        return result || `${domain}.${service} executed successfully${resolvedEntityId ? ` on ${resolvedEntityId}` : ''}.`
      } catch (err) {
        return `Failed to execute ${domain}.${service}${entity_id ? ` on ${entity_id}` : ''}: ${err.message}. Do not retry with the same arguments — report this error to the user.`
      }
    },
    { kind: 'write', risk: 'low', timeoutMs: 15000 },
  )
}
