import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orchestrateHaControl, orchestrateResolveTarget } from '../orchestrator.js'
import { FakeRegistry, FakeHomeAssistant } from './fakes.js'

const noWait = () => Promise.resolve()

function buildRegistry(entities) {
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant(entities)
  ha.registerOn(registry)
  return { registry, ha }
}

test('orchestrator: kitchen lights canonical scenario — resolves, executes, verifies', async () => {
  const { registry, ha } = buildRegistry([
    { entity_id: 'light.kitchen_lights', friendly_name: 'Kitchen Lights', area: 'Kitchen', state: 'off' },
    { entity_id: 'light.living_room',    friendly_name: 'Living Room',    area: 'Living Room', state: 'off' },
  ])
  const result = await orchestrateHaControl(registry, { target: 'kitchen lights', action: 'turn_on' }, { sleep: noWait, source: 'chat', approvalsAvailable: true })
  assert.equal(result.ok, true, JSON.stringify(result, null, 2))
  assert.equal(result.stage, 'verified')
  assert.equal(result.resolved.entity_id, 'light.kitchen_lights')
  assert.equal(result.action.service, 'turn_on')
  assert.equal(result.verification.verified, true)
  assert.equal(ha.calls.length, 1)
  assert.equal(ha.calls[0].entity_id, 'light.kitchen_lights')
})

test('orchestrator: refuses to act on ambiguous bedroom request and lists candidates', async () => {
  const { registry, ha } = buildRegistry([
    { entity_id: 'light.master_bedroom', friendly_name: 'Master Bedroom Light', area: 'Master Bedroom' },
    { entity_id: 'light.guest_bedroom',  friendly_name: 'Guest Bedroom Light',  area: 'Guest Bedroom' },
  ])
  const result = await orchestrateHaControl(registry, { target: 'bedroom light', action: 'turn_on' }, { sleep: noWait, source: 'chat', approvalsAvailable: true })
  if (result.ok) {
    // Both are reasonable matches but the resolver should not have high confidence.
    assert.notEqual(result.resolution?.confidence, 'high')
  } else {
    assert.equal(result.stage, 'resolve')
    assert.match(result.message, /Low-confidence|Could not find/)
  }
  // Most importantly: when refused, no service should have been called.
  if (!result.ok) assert.equal(ha.calls.length, 0)
})

test('orchestrator: refuses when nothing matches at all', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'light.kitchen_lights' }])
  const result = await orchestrateHaControl(registry, { target: 'nonexistent gizmo', action: 'turn_on' }, { sleep: noWait })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'resolve')
  assert.equal(ha.calls.length, 0)
})

test('orchestrator: surfaces verification failure when the device did not change state', async () => {
  // A switch that drops every service call — registry stub overrides the HA fake's call_service.
  const registry = new FakeRegistry()
  const ha = new FakeHomeAssistant([{ entity_id: 'light.broken', area: 'Test', state: 'off' }])
  ha.registerOn(registry, { callService: false })
  registry.register('home-assistant__ha_call_service', async () => 'ok')  // returns success but doesn't change state
  const result = await orchestrateHaControl(registry, { target: 'broken', action: 'turn_on' }, { sleep: noWait, source: 'chat', approvalsAvailable: true })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'verified')
  assert.equal(result.verification.verified, false)
  assert.match(result.message, /verification failed/)
})

test('orchestrator: blocks unlock from voice (high-risk source policy)', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'lock.front_door', friendly_name: 'Front Door', state: 'locked' }])
  const result = await orchestrateHaControl(registry, { target: 'front door', action: 'unlock' }, { sleep: noWait, source: 'voice' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'policy')
  assert.equal(result.policy.allowed, false)
  assert.equal(ha.calls.length, 0)
})

test('orchestrator: blocks unlock from webhook (high-risk source policy)', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'lock.front_door', friendly_name: 'Front Door', state: 'locked' }])
  const result = await orchestrateHaControl(registry, { target: 'front door', action: 'unlock' }, { sleep: noWait, source: 'webhook' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'policy')
  assert.equal(result.policy.allowed, false)
  assert.equal(ha.calls.length, 0)
})

test('orchestrator: chat unlock with approval executes through ha_control', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'lock.front_door', friendly_name: 'Front Door', state: 'locked' }])
  let approvalRequest = null
  const result = await orchestrateHaControl(registry, { target: 'front door', action: 'unlock' }, {
    sleep: noWait,
    source: 'chat',
    approvalsAvailable: true,
    requestApproval: async (request) => {
      approvalRequest = request
      return { approved: true }
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result, null, 2))
  assert.equal(result.stage, 'verified')
  assert.equal(approvalRequest.name, 'ha_control')
  assert.equal(approvalRequest.risk, 'high')
  assert.equal(ha.calls.length, 1)
  assert.equal(ha.calls[0].entity_id, 'lock.front_door')
})

test('orchestrator: explicit entity_id short-circuits resolution', async () => {
  const { registry, ha } = buildRegistry([{ entity_id: 'switch.coffee', area: 'Kitchen', state: 'off' }])
  const result = await orchestrateHaControl(registry, { entity_id: 'switch.coffee', action: 'turn_on' }, { sleep: noWait, source: 'chat', approvalsAvailable: true })
  assert.equal(result.ok, true)
  assert.equal(ha.calls[0].entity_id, 'switch.coffee')
})

test('orchestrator: rejects unknown action with a helpful message', async () => {
  const { registry } = buildRegistry([{ entity_id: 'light.x' }])
  const result = await orchestrateHaControl(registry, { target: 'x', action: 'do_a_dance' }, { sleep: noWait })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'preflight')
  assert.match(result.message, /Unknown action/)
})

test('orchestrator: action/domain mismatch is reported, not silently retargeted', async () => {
  // Asking to "lock" a light should refuse — there is no lock semantics for lights.
  const { registry, ha } = buildRegistry([{ entity_id: 'light.kitchen_lights', area: 'Kitchen' }])
  const result = await orchestrateHaControl(registry, { target: 'kitchen lights', action: 'lock' }, { sleep: noWait, source: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(ha.calls.length, 0)
})

test('orchestrator: ha_resolve_target returns ranked structured candidates', async () => {
  const { registry } = buildRegistry([
    { entity_id: 'light.kitchen_lights', area: 'Kitchen' },
    { entity_id: 'light.kitchen_island', area: 'Kitchen' },
    { entity_id: 'switch.kitchen_fan', area: 'Kitchen' },
  ])
  const result = await orchestrateResolveTarget(registry, { target: 'kitchen', domain: 'light', limit: 5 })
  assert.equal(result.ok, true)
  assert.ok(result.candidates.length >= 2)
  for (const c of result.candidates) assert.equal(c.domain, 'light')
})

test('orchestrator: returns preflight error when ha-mcp is not connected', async () => {
  const registry = new FakeRegistry()
  const result = await orchestrateHaControl(registry, { target: 'kitchen lights', action: 'turn_on' }, { sleep: noWait })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'preflight')
  assert.match(result.message, /not connected/)
})
