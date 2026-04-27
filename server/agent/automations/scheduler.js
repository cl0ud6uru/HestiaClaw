import cron from 'node-cron'
import * as db from './db.js'
import { runAutomation } from './runner.js'

const jobs = new Map()

// runner.init() is called from index.js with the harness deps before syncAll()

export function syncAll() {
  const automations = db.list()
  for (const auto of automations) {
    if (auto.enabled) {
      register(auto)
    } else {
      unregister(auto.id)
    }
  }

  // Fire any one_off jobs that were missed while server was down
  const pending = db.getPendingOneOffs()
  for (const auto of pending) {
    console.log(`[automations] Firing missed one_off: "${auto.name}"`)
    runAutomation(auto.id).catch(err =>
      console.error(`[automations] Missed one_off error: ${err.message}`)
    )
    db.toggle(auto.id, false)
    unregister(auto.id)
  }

  console.log(`[automations] Scheduler synced — ${jobs.size} active job(s)`)
}

export function register(auto) {
  // Cancel any existing job for this id
  unregister(auto.id)

  if (!auto.enabled) return

  if (auto.trigger_type === 'cron') {
    if (!auto.cron_expr || !cron.validate(auto.cron_expr)) {
      console.warn(`[automations] Invalid cron_expr for "${auto.name}": ${auto.cron_expr}`)
      return
    }
    const task = cron.schedule(
      auto.cron_expr,
      () => {
        console.log(`[automations] Cron firing: "${auto.name}"`)
        runAutomation(auto.id).catch(err =>
          console.error(`[automations] Cron run error for "${auto.name}": ${err.message}`)
        )
      },
      { timezone: auto.timezone || 'UTC' }
    )
    jobs.set(auto.id, task)
    db.update(auto.id, { next_run_at: computeNextRun(auto.cron_expr, auto.timezone) })
    console.log(`[automations] Registered cron "${auto.name}" (${auto.cron_expr})`)
  } else if (auto.trigger_type === 'one_off') {
    if (!auto.run_at) return
    const delay = auto.run_at - Date.now()
    if (delay <= 0) {
      // Already past — fire immediately and disable
      runAutomation(auto.id).catch(err =>
        console.error(`[automations] One-off error for "${auto.name}": ${err.message}`)
      )
      db.toggle(auto.id, false)
      return
    }
    const timer = setTimeout(() => {
      console.log(`[automations] One-off firing: "${auto.name}"`)
      runAutomation(auto.id).catch(err =>
        console.error(`[automations] One-off error for "${auto.name}": ${err.message}`)
      )
      db.toggle(auto.id, false)
      jobs.delete(auto.id)
    }, delay)
    // Store as a plain object so unregister can clearTimeout
    jobs.set(auto.id, { _isTimeout: true, timer })
    console.log(`[automations] Registered one_off "${auto.name}" in ${Math.round(delay / 1000)}s`)
  } else if (auto.trigger_type === 'webhook' || auto.trigger_type === 'ha_event') {
    // No proactive job — triggered by HTTP POST; record as present with null task
    jobs.set(auto.id, null)
  }
}

export function unregister(id) {
  const job = jobs.get(id)
  if (job) {
    if (job._isTimeout) {
      clearTimeout(job.timer)
    } else if (typeof job.stop === 'function') {
      job.stop()
    }
  }
  jobs.delete(id)
}

export function triggerNow(id, triggerContext = '') {
  const auto = db.get(id)
  if (!auto) throw new Error(`Automation ${id} not found`)
  console.log(`[automations] Manual trigger: "${auto.name}"`)
  return runAutomation(id, triggerContext)
}

// node-cron doesn't expose next-fire calculation; UI computes it from the expression directly
function computeNextRun() { return null }
