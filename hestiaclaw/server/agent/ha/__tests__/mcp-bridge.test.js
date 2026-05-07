import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEntitiesResult,
  parseEntityStateResult,
  searchEntities,
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
