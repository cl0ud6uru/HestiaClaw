function findTool(registry, ...candidates) {
  for (const name of candidates) {
    if (registry.has(name)) return name
  }
  return null
}


export function registerHaFacade(registry) {
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
