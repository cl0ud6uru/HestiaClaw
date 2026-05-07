import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRisk, evaluatePolicy } from '../policy.js'

test('classifyRisk returns low for light/switch/fan turn_on', () => {
  assert.equal(classifyRisk({ domain: 'light', service: 'turn_on' }), 'low')
  assert.equal(classifyRisk({ domain: 'switch', service: 'turn_off' }), 'low')
  assert.equal(classifyRisk({ domain: 'fan', service: 'set_percentage' }), 'low')
})

test('classifyRisk returns medium for climate set_temperature and cover open', () => {
  assert.equal(classifyRisk({ domain: 'climate', service: 'set_temperature' }), 'medium')
  assert.equal(classifyRisk({ domain: 'cover', service: 'open_cover', entity_id: 'cover.living_room_blinds' }), 'medium')
})

test('classifyRisk returns high for lock and alarm services', () => {
  assert.equal(classifyRisk({ domain: 'lock', service: 'unlock' }), 'high')
  assert.equal(classifyRisk({ domain: 'alarm_control_panel', service: 'alarm_disarm' }), 'high')
})

test('classifyRisk treats garage door covers as high risk', () => {
  assert.equal(classifyRisk({ domain: 'cover', service: 'open_cover', entity_id: 'cover.garage_door' }), 'high')
  assert.equal(classifyRisk({ domain: 'cover', service: 'close_cover', entity_id: 'cover.front_door' }), 'high')
})

test('classifyRisk treats automation.turn_off as high risk (disabling safety automations)', () => {
  assert.equal(classifyRisk({ domain: 'automation', service: 'turn_off' }), 'high')
})

test('evaluatePolicy: chat with approvals lets low/medium through and gates high', () => {
  const low = evaluatePolicy({ domain: 'light', service: 'turn_on', source: 'chat', approvalsAvailable: true })
  assert.equal(low.allowed, true)
  assert.equal(low.requiresApproval, false)

  const med = evaluatePolicy({ domain: 'climate', service: 'set_temperature', source: 'chat', approvalsAvailable: true })
  assert.equal(med.allowed, true)
  assert.equal(med.requiresApproval, false)

  const hi = evaluatePolicy({ domain: 'lock', service: 'unlock', source: 'chat', approvalsAvailable: true })
  assert.equal(hi.allowed, true)
  assert.equal(hi.requiresApproval, true)
})

test('evaluatePolicy: chat without approvals refuses high-risk actions', () => {
  const result = evaluatePolicy({ domain: 'lock', service: 'unlock', source: 'chat', approvalsAvailable: false })
  assert.equal(result.allowed, false)
  assert.equal(result.requiresApproval, true)
})

test('evaluatePolicy: voice and webhook block high-risk outright', () => {
  for (const source of ['voice', 'webhook', 'automation']) {
    const result = evaluatePolicy({ domain: 'lock', service: 'unlock', source })
    assert.equal(result.allowed, false, `source=${source}`)
    assert.match(result.reason, /not permitted/, `source=${source}`)
  }
})

test('evaluatePolicy: voice still permits low/medium actions', () => {
  const low = evaluatePolicy({ domain: 'light', service: 'turn_on', source: 'voice' })
  assert.equal(low.allowed, true)
  const med = evaluatePolicy({ domain: 'climate', service: 'set_temperature', source: 'voice' })
  assert.equal(med.allowed, true)
})
