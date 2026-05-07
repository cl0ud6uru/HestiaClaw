function findTool(registry, ...candidates) {
  for (const name of candidates) {
    if (registry.has(name)) return name
  }
  return null
}

const HIGH_RISK_HA_DOMAINS = new Set(['lock', 'alarm_control_panel'])
const HIGH_RISK_HA_SERVICES = new Set(['unlock', 'lock', 'open', 'close', 'alarm_disarm', 'alarm_trigger'])

function isHighRiskHaAction(domain, service) {
  return HIGH_RISK_HA_DOMAINS.has(domain) || HIGH_RISK_HA_SERVICES.has(service)
}


export function registerHaFacade(registry) {
  // ha_execute_service — the single entry point for ALL device control actions.
  // The model tends to know the HA service name (e.g. light.turn_on) but may not
  // know which underlying MCP tool name maps to it. This facade bridges that gap.
  registry.register(
    'ha_execute_service',
    'Execute a Home Assistant service call to control a device — turn lights on/off, ' +
    'adjust brightness or colour, set thermostat temperature, run scripts or scenes, ' +
    'trigger automations, etc. ' +
    'Call this immediately when the user asks you to control a device — do NOT ask for ' +
    'confirmation first. Supply domain, service, and entity_id as top-level parameters. ' +
    'Examples: ' +
    '{domain:"light",service:"turn_on",entity_id:"light.living_room",data:{brightness_pct:80}} ' +
    '{domain:"switch",service:"turn_off",entity_id:"switch.fan"} ' +
    '{domain:"climate",service:"set_temperature",entity_id:"climate.office",data:{temperature:72}} ' +
    'For security-sensitive actions (lock/unlock, alarm) use the native Home Assistant MCP tools directly — they require approval.',
    {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'HA domain, e.g. "light", "switch", "climate", "scene", "script", "automation".',
        },
        service: {
          type: 'string',
          description: 'Service name within the domain, e.g. "turn_on", "turn_off", "set_temperature", "trigger".',
        },
        entity_id: {
          type: 'string',
          description: 'Target entity ID, e.g. "light.living_room", "switch.fan", "climate.office". Required for almost all device control calls.',
        },
        data: {
          type: 'object',
          description: 'Additional service parameters beyond entity_id, e.g. {"brightness_pct": 80} for lights, {"temperature": 72} for climate.',
        },
      },
      required: ['domain', 'service', 'entity_id'],
    },
    async ({ domain, service, entity_id, data, service_data }) => {
      const callTool = findTool(registry,
        'home-assistant__ha_call_service',
        'home-assistant__call_service',
        'home-assistant__ha_execute_service',
        'home-assistant__execute_service',
      )
      if (!callTool) {
        return 'Home Assistant service execution is not available — the ha-mcp server may not be connected.'
      }
      if (isHighRiskHaAction(domain, service)) {
        return `${domain}.${service} is a security-sensitive action. Use the native Home Assistant MCP tool for this domain/service — it will prompt for approval before executing.`
      }
      try {
        // Accept entity_id at top level (preferred) or nested in service_data (legacy)
        const resolvedEntityId = entity_id || service_data?.entity_id
        const resolvedData = data || (service_data ? (({ entity_id: _e, ...rest }) => Object.keys(rest).length ? rest : undefined)(service_data) : undefined)
        const input = {
          domain,
          service,
          ...(resolvedEntityId ? { entity_id: resolvedEntityId } : {}),
          ...(resolvedData ? { data: resolvedData } : {}),
        }
        const result = await registry.execute(callTool, input)
        return result || `${domain}.${service} executed successfully on ${resolvedEntityId}.`
      } catch (err) {
        return `Failed to execute ${domain}.${service} on ${entity_id}: ${err.message}. Do not retry with the same arguments — report this error to the user.`
      }
    },
    { kind: 'write', risk: 'low', timeoutMs: 15000 },
  )

  // ha_get_area_summary — area-level overview not directly offered by ha-mcp
  registry.register(
    'ha_get_area_summary',
    'Get a summary of all Home Assistant entities in a specific area or room, showing their current states.',
    {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Area name or area_id, e.g. "living room" or "bedroom".' },
      },
      required: ['area'],
    },
    async ({ area }) => {
      const searchTool = findTool(registry,
        'home-assistant__ha_search_entities',
        'home-assistant__ha_get_entity',
      )
      if (!searchTool) return 'Home Assistant is not connected.'

      try {
        const raw = await registry.execute(searchTool, { query: area })
        if (!raw) return `No entities found for area "${area}".`

        // ha_search_entities returns text — pass through with area header
        return `Area: ${area}\n${String(raw).slice(0, 1500)}`
      } catch (err) {
        return `Failed to get area summary: ${err.message}`
      }
    },
    { kind: 'read', risk: 'low', timeoutMs: 10000 },
  )
}
