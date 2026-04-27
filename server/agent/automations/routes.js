import { Router } from 'express'
import * as db from './db.js'
import * as scheduler from './scheduler.js'

// Protected CRUD router — mount with requireAuth
export function createAutomationsRouter() {
  const router = Router()

  router.get('/', (req, res) => {
    try {
      const automations = db.list()
      res.json(automations)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', (req, res) => {
    const { name, description, prompt, trigger_type, cron_expr, timezone, run_at,
      webhook_secret, ha_entity_id, ha_condition, timeout_seconds } = req.body || {}
    if (!name || !prompt || !trigger_type) {
      return res.status(400).json({ error: 'name, prompt, and trigger_type are required.' })
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
    const runs = db.getRuns(req.params.id)
    res.json({ ...auto, runs })
  })

  router.put('/:id', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    try {
      db.update(req.params.id, req.body || {})
      scheduler.unregister(req.params.id)
      const updated = db.get(req.params.id)
      if (updated.enabled) scheduler.register(updated)
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:id', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
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
      if (enabled) {
        scheduler.register(db.get(req.params.id))
      } else {
        scheduler.unregister(req.params.id)
      }
      res.json({ id: req.params.id, enabled })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:id/run', async (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    try {
      // Fire async — don't await so client gets immediate 202
      scheduler.triggerNow(req.params.id).catch(err =>
        console.error(`[automations] Manual run error: ${err.message}`)
      )
      res.status(202).json({ ok: true, message: 'Run started.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:id/runs', (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100)
    res.json(db.getRuns(req.params.id, limit))
  })

  return router
}

// Public webhook trigger handler — mount WITHOUT requireAuth
export function createTriggerHandler() {
  const router = Router()

  router.post('/:id', async (req, res) => {
    const auto = db.get(req.params.id)
    if (!auto) return res.status(404).json({ error: 'Not found.' })
    if (!auto.enabled) return res.status(409).json({ error: 'Automation is disabled.' })

    // Validate secret (query param or body field)
    const secret = req.query.secret || req.body?.secret
    if (auto.webhook_secret && secret !== auto.webhook_secret) {
      return res.status(401).json({ error: 'Invalid secret.' })
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
