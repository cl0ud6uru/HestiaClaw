import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget, scoreCandidate, inferDomainHints } from '../resolver.js'
import { FakeRegistry, FakeHomeAssistant } from './fakes.js'

function buildRegistry(entities) {
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant(entities)
  ha.registerOn(registry)
  return { registry, ha }
}

test('inferDomainHints picks light for "lights"', () => {
  assert.deepEqual(inferDomainHints('turn on the kitchen lights').sort(), ['light'])
})

test('inferDomainHints picks climate for thermostat phrasing', () => {
  assert.deepEqual(inferDomainHints('set the thermostat to 72'), ['climate'])
})

test('inferDomainHints returns empty for ambiguous phrasing', () => {
  assert.deepEqual(inferDomainHints('do the thing'), [])
})

test('scoreCandidate gives full points for exact entity_id match', () => {
  const entity = { entity_id: 'light.kitchen', name: 'Kitchen', area: 'Kitchen', domain: 'light', state: 'off' }
  const { score, reasons } = scoreCandidate({ entity, target: 'light.kitchen' })
  assert.ok(score >= 200, `expected ≥200, got ${score}`)
  assert.ok(reasons.includes('exact_entity_id'))
})

test('resolveTarget picks light.kitchen_lights for "kitchen lights" — the canonical bug', async () => {
  // The model used to invent "light.kitchen" — but the actual entity is
  // "light.kitchen_lights". The resolver must surface the real one.
  const { registry } = buildRegistry([
    { entity_id: 'light.kitchen_lights', friendly_name: 'Kitchen Lights', area: 'Kitchen', state: 'off' },
    { entity_id: 'light.living_room', friendly_name: 'Living Room', area: 'Living Room', state: 'on' },
    { entity_id: 'switch.kitchen_fan', friendly_name: 'Kitchen Fan', area: 'Kitchen', state: 'off' },
  ])
  const result = await resolveTarget(registry, { target: 'kitchen lights' })
  assert.equal(result.candidates[0].entity_id, 'light.kitchen_lights')
  assert.ok(['high', 'medium'].includes(result.confidence), `unexpected confidence: ${result.confidence}`)
})

test('resolveTarget prefers domain match when ambiguous', async () => {
  const { registry } = buildRegistry([
    { entity_id: 'light.bedroom', area: 'Bedroom' },
    { entity_id: 'switch.bedroom', area: 'Bedroom' },
    { entity_id: 'fan.bedroom', area: 'Bedroom' },
  ])
  const result = await resolveTarget(registry, { target: 'bedroom', domain: 'light' })
  assert.equal(result.candidates[0].entity_id, 'light.bedroom')
})

test('resolveTarget surfaces ambiguous bedroom matches as multiple candidates', async () => {
  const { registry } = buildRegistry([
    { entity_id: 'light.master_bedroom', friendly_name: 'Master Bedroom', area: 'Master Bedroom' },
    { entity_id: 'light.guest_bedroom', friendly_name: 'Guest Bedroom', area: 'Guest Bedroom' },
  ])
  const result = await resolveTarget(registry, { target: 'bedroom light' })
  assert.ok(result.candidates.length >= 2)
})

test('resolveTarget returns empty candidates when nothing matches', async () => {
  const { registry } = buildRegistry([{ entity_id: 'light.kitchen' }])
  const result = await resolveTarget(registry, { target: 'nonexistent gadget' })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.confidence, 'none')
})

test('resolveTarget reports searchAvailable=false when ha-mcp is missing', async () => {
  const registry = new FakeRegistry()
  const result = await resolveTarget(registry, { target: 'kitchen' })
  assert.equal(result.searchAvailable, false)
  assert.equal(result.candidates.length, 0)
})

test('resolveTarget honours an explicit entity_id and confirms it exists', async () => {
  const { registry } = buildRegistry([{ entity_id: 'light.office' }])
  const result = await resolveTarget(registry, { target: '', entity_id: 'light.office' })
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].entity_id, 'light.office')
  assert.equal(result.confidence, 'high')
})

test('resolveTarget honours a typo entity_id but flags low confidence', async () => {
  const { registry } = buildRegistry([{ entity_id: 'light.office' }])
  const result = await resolveTarget(registry, { target: '', entity_id: 'light.offfice' })
  // Caller-supplied id but not found → still returned, confidence reduced
  assert.equal(result.candidates[0].entity_id, 'light.offfice')
  assert.notEqual(result.confidence, 'high')
})
