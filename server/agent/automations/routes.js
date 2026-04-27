import { Router } from 'express'
import cron from 'node-cron'
import * as db from './db.js'
import * as scheduler from './scheduler.js'

function validateBody(body, isUpdate = false) {
  const { name, prompt, trigger_type, cron_expr } = body || {}
  if (!isUpdate) {
    if (!name?.trim())   return 'name is required.'
    if (!prompt?.trim()) return 'prompt is required.'
    if (!trigger_type)   return 'trigger_type is required.'
  }
  if (trigger_type === 'cron' || (isUpdate && cron_expr !== undefined)) {
    if (trigger_type === 'cron' && cron_expr !== undefined && cron_expr !== null) {
      if (!cron.validate(cron_expr)) return 'Invalid cron expression.'
    }
  }
  return null
}

// Protected CRUD router — mount with requireAuth
export function createAutomationsRouter() {
  const router = Router()

  router.get('/', (req, res) => {
    try {
      res.json(db.list())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', (req, res) => {
    const validationError = validateBody(req.body)
    if (validationError) return res.status(400).json({ error: validationError })

    const { name, description, prompt, trigger_type, cron_expr, timezone, run_at,
      webhook_secret, ha_entity_id, ha_condition, timeout_seconds } = req.body

    // Additional cron check
    if (trigger_type === 'cron' && !cron.validate(cron_expr || '')) {
      return res.status(400).json({ error: 'Invalid cron expression.' })
    }

    try {
      const id = db.create({
        name, description, prompt, trigger_type, cron_expr, timezone, run_at,
        webhook_secret, ha_entity_id, ha_condition, timeout_seconds,
      })
      const auto = db.get(id)
      scheduler.register(auto)
      res.status(201).json(auto)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:id', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    res.json({ ...auto, runs: db.getRuns(req.params.id) })
  })

  router.put('/:id', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })

    const body = req.body || {}

    // Validate cron expression if being updated
    const newTriggerType = body.trigger_type ?? auto.trigger_type
    const newCronExpr = body.cron_expr ?? auto.cron_expr
    if (newTriggerType === 'cron' && newCronExpr && !cron.validate(newCronExpr)) {
      return res.status(400).json({ error: 'Invalid cron expression.' })
    }

    // Never allow clearing webhook_secret to empty on a webhook/ha_event automation
    if (
      (newTriggerType === 'webhook' || newTriggerType === 'ha_event') &&
      'webhook_secret' in body && !body.webhook_secret?.trim()
    ) {
      delete body.webhook_secret // keep existing secret
    }

    try {
      db.update(req.params.id, body)
      scheduler.unregister(req.params.id)
      const updated = db.get(req.params.id)
      if (updated.enabled) scheduler.register(updated)
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:id', (req, res) => {
    if (!db.get(req.params.id)) return res.status(404).json({ error: 'Not found.' })
    try {
      scheduler.unregister(req.params.id)
      db.remove(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.patch('/:id/toggle', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    try {
      const enabled = !auto.enabled
      db.toggle(req.params.id, enabled)
      if (enabled) scheduler.register(db.get(req.params.id))
      else scheduler.unregister(req.params.id)
      res.json({ id: req.params.id, enabled })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:id/run', (req, res) => {
    if (!db.get(req.params.id)) return res.status(404).json({ error: 'Not found.' })
    try {
      scheduler.triggerNow(req.params.id).catch(err =>
        console.error(`[automations] Manual run error: ${err.message}`)
      )
      res.status(202).json({ ok: true, message: 'Run started.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:id/runs', (req, res) => {
    if (!db.get(req.params.id)) return res.status(404).json({ error: 'Not found.' })
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100)
    res.json(db.getRuns(req.params.id, limit))
  })

  return router
}

// Public webhook trigger handler — no requireAuth, validates secret
export function createTriggerHandler() {
  const router = Router()

  router.post('/:id', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    if (!auto.enabled) return res.status(409).json({ error: 'Automation is disabled.' })

    // Accept secret from header (preferred), body, or query param (legacy)
    const secret =
      req.headers['x-automation-secret'] ||
      req.body?.secret ||
      req.query.secret

    // Always require a matching secret — no bypass for empty secrets
    if (!auto.webhook_secret || secret !== auto.webhook_secret) {
      return res.status(401).json({ error: 'Invalid or missing secret.' })
    }

    const context = req.body?.context || ''
    try {
      scheduler.triggerNow(auto.id, context).catch(err =>
        console.error(`[automations] Webhook trigger error: ${err.message}`)
      )
      res.status(202).json({ ok: true, message: 'Automation triggered.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
