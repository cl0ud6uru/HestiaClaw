import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEntitiesResult,
  parseEntityStateResult,
  searchEntities,
  listEntities,
  callService,
  isHaMcpAvailable,
} from '../mcp-bridge.js'
import { FakeRegistry, FakeHomeAssistant } from './fakes.js'

test('parseEntitiesResult parses a JSON array', () => {
  const raw = JSON.stringify([
    { entity_id: 'light.kitchen_lights', friendly_name: 'Kitchen Lights', area: 'Kitchen', state: 'off' },
    { entity_id: 'switch.fan', friendly_name: 'Fan', state: 'on' },
  ])
  const out = parseEntitiesResult(raw)
  assert.equal(out.length, 2)
  assert.equal(out[0].entity_id, 'light.kitchen_lights')
  assert.equal(out[0].domain, 'light')
  assert.equal(out[0].name, 'Kitchen Lights')
  assert.equal(out[0].area, 'Kitchen')
  assert.equal(out[1].state, 'on')
})

test('parseEntitiesResult parses a JSON object wrapper', () => {
  const raw = JSON.stringify({ entities: [{ entity_id: 'light.x', state: 'off' }] })
  const out = parseEntitiesResult(raw)
  assert.equal(out.length, 1)
  assert.equal(out[0].entity_id, 'light.x')
})

test('parseEntitiesResult parses fenced JSON', () => {
  const raw = '```json\n[{"entity_id":"light.foo","friendly_name":"Foo","state":"on"}]\n```'
  const out = parseEntitiesResult(raw)
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'Foo')
})

test('parseEntitiesResult falls back to text parsing for free-form output', () => {
  const raw = '- light.bedroom_lamp (Bedroom Lamp) — area: Bedroom — state: off\n- switch.coffee (Coffee Maker) state: on'
  const out = parseEntitiesResult(raw)
  assert.equal(out.length, 2)
  assert.equal(out[0].entity_id, 'light.bedroom_lamp')
  assert.equal(out[0].state, 'off')
  assert.equal(out[1].entity_id, 'switch.coffee')
  assert.equal(out[1].state, 'on')
})

test('parseEntitiesResult ignores blocks with no entity_id', () => {
  const out = parseEntitiesResult('Just a paragraph of text.')
  assert.equal(out.length, 0)
})

test('parseEntityStateResult returns a single entity', () => {
  const raw = JSON.stringify({ entity_id: 'climate.office', state: 'cool', attributes: { temperature: 72 } })
  const out = parseEntityStateResult(raw)
  assert.equal(out.entity_id, 'climate.office')
  assert.equal(out.state, 'cool')
  assert.equal(out.attributes.temperature, 72)
})

test('isHaMcpAvailable detects registered tools', () => {
  const registry = new FakeRegistry()
  assert.equal(isHaMcpAvailable(registry), false)
  const ha = new FakeHomeAssistant([])
  ha.registerOn(registry)
  assert.equal(isHaMcpAvailable(registry), true)
})

test('searchEntities returns parsed entities and reports availability', async () => {
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant([
    { entity_id: 'light.kitchen_lights', area: 'Kitchen' },
    { entity_id: 'light.living_room', area: 'Living Room' },
  ])
  ha.registerOn(registry)
  const result = await searchEntities(registry, { query: 'kitchen' })
  assert.equal(result.available, true)
  assert.equal(result.entities.length, 1)
  assert.equal(result.entities[0].entity_id, 'light.kitchen_lights')
})

test('searchEntities discovers noncanonical hidden HA tools by metadata', async () => {
  const registry = new FakeRegistry()
  registry.register(
    'addon_ha__LookupThings',
    'lookup',
    {},
    async ({ query }) => JSON.stringify([{ entity_id: 'light.master_lamp', friendly_name: `Master ${query}`, area: 'Master Bedroom', state: 'off' }]),
    {
      source: 'addon_ha',
      serverName: 'addon_ha',
      role: 'home-assistant',
      nativeName: 'ha_search_entities',
      internalOnly: true,
    },
  )
  const result = await searchEntities(registry, { query: 'master bedroom', area: 'Master Bedroom', domain: 'light' })
  assert.equal(result.available, true)
  assert.equal(result.entities.length, 1)
  assert.equal(result.entities[0].entity_id, 'light.master_lamp')
})

test('listEntities filters metadata-discovered HA inventory locally', async () => {
  const registry = new FakeRegistry()
  registry.register(
    'addon_ha__Inventory',
    'inventory',
    {},
    async () => JSON.stringify([
      { entity_id: 'light.master_lamp', friendly_name: 'Ceiling Light', area: 'Master Bedroom', state: 'off' },
      { entity_id: 'switch.master_fan', friendly_name: 'Fan', area: 'Master Bedroom', state: 'off' },
      { entity_id: 'light.kitchen_lights', friendly_name: 'Kitchen Lights', area: 'Kitchen', state: 'on' },
    ]),
    {
      source: 'addon_ha',
      serverName: 'addon_ha',
      role: 'home-assistant',
      nativeName: 'ha_list_entities',
      internalOnly: true,
    },
  )
  const result = await listEntities(registry, { area: 'Master Bedroom', domain: 'light' })
  assert.equal(result.available, true)
  assert.deepEqual(result.entities.map(e => e.entity_id), ['light.master_lamp'])
})

test('searchEntities reports unavailable when no search tool is registered', async () => {
  const registry = new FakeRegistry()
  const result = await searchEntities(registry, { query: 'x' })
  assert.equal(result.available, false)
  assert.deepEqual(result.entities, [])
})

test('callService throws when no call_service tool is available', async () => {
  const registry = new FakeRegistry()
  await assert.rejects(() => callService(registry, { domain: 'light', service: 'turn_on', entity_id: 'light.x' }))
})

test('callService dispatches via the underlying ha-mcp tool', async () => {
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant([{ entity_id: 'light.x' }])
  ha.registerOn(registry)
  const result = await callService(registry, { domain: 'light', service: 'turn_on', entity_id: 'light.x', data: { brightness_pct: 50 } })
  assert.match(String(result), /light.turn_on ok/)
  assert.equal(ha.calls.length, 1)
  assert.equal(ha.calls[0].entity_id, 'light.x')
  assert.equal(ha.calls[0].data.brightness_pct, 50)
})

test('callService discovers noncanonical hidden HA service tool by metadata', async () => {
  const registry = new FakeRegistry()
  const calls = []
  registry.register(
    'addon_ha__DoService',
    'call',
    {},
    async (input) => {
      calls.push(input)
      return 'ok'
    },
    {
      source: 'addon_ha',
      serverName: 'addon_ha',
      role: 'home-assistant',
      nativeName: 'ha_call_service',
      internalOnly: true,
    },
  )
  assert.equal(isHaMcpAvailable(registry), true)
  const result = await callService(registry, { domain: 'lock', service: 'lock', entity_id: 'lock.front_door' })
  assert.equal(result, 'ok')
  assert.equal(calls[0].entity_id, 'lock.front_door')
})
