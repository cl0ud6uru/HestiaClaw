import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyAction } from '../verifier.js'
import { FakeRegistry, FakeHomeAssistant } from './fakes.js'

const noWait = () => Promise.resolve()

function buildRegistry(entities) {
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant(entities)
  ha.registerOn(registry)
  return { registry, ha }
}

test('verifyAction confirms light.turn_on flipped state to on', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'light.kitchen', state: 'off' }])
  ha._applyServiceEffect(ha.get('light.kitchen'), 'light', 'turn_on', { brightness_pct: 80 })
  const result = await verifyAction(registry, {
    entity_id: 'light.kitchen',
    domain: 'light',
    service: 'turn_on',
    data: { brightness_pct: 80 },
    sleep: noWait,
  })
  assert.equal(result.verified, true)
  assert.equal(result.postState.state, 'on')
})

test('verifyAction reports failure when state did not change', async () => {
  const { registry } = buildRegistry([{ entity_id: 'light.kitchen', state: 'off' }])
  // No effect applied — state stays "off"
  const result = await verifyAction(registry, {
    entity_id: 'light.kitchen',
    domain: 'light',
    service: 'turn_on',
    sleep: noWait,
  })
  assert.equal(result.verified, false)
  assert.match(result.message, /did not reach/)
})

test('verifyAction is fire-and-forget for scenes', async () => {
  const { registry } = buildRegistry([])
  const result = await verifyAction(registry, {
    entity_id: 'scene.goodnight',
    domain: 'scene',
    service: 'turn_on',
    sleep: noWait,
  })
  assert.equal(result.verified, true)
  assert.equal(result.fireAndForget, true)
})

test('verifyAction validates climate.set_temperature attribute', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'climate.office', state: 'cool', attributes: { temperature: 68 } }])
  ha._applyServiceEffect(ha.get('climate.office'), 'climate', 'set_temperature', { temperature: 72 })
  const result = await verifyAction(registry, {
    entity_id: 'climate.office',
    domain: 'climate',
    service: 'set_temperature',
    data: { temperature: 72 },
    sleep: noWait,
  })
  assert.equal(result.verified, true)
  assert.equal(result.postState.attributes.temperature, 72)
})

test('verifyAction reports no_post_state when entity disappears', async () => {
  const { registry } = buildRegistry([])
  const result = await verifyAction(registry, {
    entity_id: 'light.ghost',
    domain: 'light',
    service: 'turn_on',
    sleep: noWait,
  })
  assert.equal(result.verified, false)
  assert.equal(result.reason, 'no_post_state')
})

test('verifyAction handles cover open with transitional states', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'cover.living_room_blinds', state: 'closed' }])
  ha._applyServiceEffect(ha.get('cover.living_room_blinds'), 'cover', 'open_cover', {})
  const result = await verifyAction(registry, {
    entity_id: 'cover.living_room_blinds',
    domain: 'cover',
    service: 'open_cover',
    sleep: noWait,
  })
  assert.equal(result.verified, true)
  assert.equal(result.postState.state, 'open')
})
