// Lightweight fakes for the HA orchestrator tests.
//
// FakeRegistry mirrors the surface area of ToolRegistry that the HA modules
// depend on (`has`, `execute`). FakeHomeAssistant simulates the underlying
// ha-mcp tool surface — search, get_entity, call_service — backed by an
// in-memory entity store that mutates on service calls so verification can
// observe changes.

export class FakeRegistry {
  constructor() {
    this._tools = new Map()
  }
  register(name, handler) {
    this._tools.set(name, handler)
  }
  unregister(name) {
    this._tools.delete(name)
  }
  has(name) { return this._tools.has(name) }
  async execute(name, input) {
    const handler = this._tools.get(name)
    if (!handler) throw new Error(`Tool "${name}" not found`)
    return handler(input)
  }
}

export class FakeHomeAssistant {
  constructor(entities = []) {
    this.entities = new Map()
    for (const e of entities) this.add(e)
    this.calls = []
  }

  add(entity) {
    const normalized = {
      entity_id: entity.entity_id,
      domain: entity.entity_id.split('.')[0],
      friendly_name: entity.friendly_name || entity.name || entity.entity_id.split('.')[1].replace(/_/g, ' '),
      area: entity.area || null,
      state: entity.state ?? 'off',
      attributes: entity.attributes ? { ...entity.attributes } : {},
    }
    this.entities.set(normalized.entity_id, normalized)
    return normalized
  }

  list() { return Array.from(this.entities.values()) }
  get(id) { return this.entities.get(id) || null }

  // Convert internal record to the JSON shape `parseEntitiesResult` expects.
  _serialize(e) {
    return {
      entity_id: e.entity_id,
      friendly_name: e.friendly_name,
      area: e.area,
      state: e.state,
      attributes: e.attributes,
    }
  }

  registerOn(registry, { search = true, getEntity = true, callService = true } = {}) {
    if (search) {
      registry.register('home-assistant__ha_search_entities', async ({ query = '' } = {}) => {
        const q = String(query || '').toLowerCase().trim()
        const tokens = q ? q.split(/\s+/).filter(t => t.length >= 2) : []
        const matches = this.list().filter(e => {
          if (!tokens.length) return true
          const hay = `${e.entity_id} ${e.friendly_name} ${e.area || ''} ${e.attributes?.area || ''}`.toLowerCase()
          return tokens.some(t => hay.includes(t))
        })
        return JSON.stringify(matches.map(e => this._serialize(e)))
      })
    }
    if (getEntity) {
      registry.register('home-assistant__ha_get_entity', async ({ entity_id }) => {
        const e = this.get(entity_id)
        if (!e) return JSON.stringify({})
        return JSON.stringify(this._serialize(e))
      })
    }
    if (callService) {
      registry.register('home-assistant__ha_call_service', async ({ domain, service, entity_id, data }) => {
        this.calls.push({ domain, service, entity_id, data })
        const e = entity_id ? this.get(entity_id) : null
        if (e) {
          this._applyServiceEffect(e, domain, service, data || {})
        }
        return `${domain}.${service} ok`
      })
    }
  }

  // Apply the simulated effect of a service call to an entity record so the
  // verifier can observe the change. Real HA does the same thing — we just
  // mirror enough surface for the tests.
  _applyServiceEffect(entity, domain, service, data) {
    if (service === 'turn_on') entity.state = 'on'
    if (service === 'turn_off') entity.state = 'off'
    if (service === 'toggle') entity.state = entity.state === 'on' ? 'off' : 'on'
    if (domain === 'lock' && service === 'lock') entity.state = 'locked'
    if (domain === 'lock' && service === 'unlock') entity.state = 'unlocked'
    if (domain === 'cover' && service === 'open_cover') entity.state = 'open'
    if (domain === 'cover' && service === 'close_cover') entity.state = 'closed'
    if (domain === 'climate' && service === 'set_temperature') {
      if (data.temperature != null) entity.attributes.temperature = Number(data.temperature)
    }
    if (domain === 'light' && service === 'turn_on') {
      entity.state = 'on'
      if (data.brightness != null) entity.attributes.brightness = Number(data.brightness)
      if (data.brightness_pct != null) entity.attributes.brightness = Math.round(Number(data.brightness_pct) * 255 / 100)
    }
  }
}
