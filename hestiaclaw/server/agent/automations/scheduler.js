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

/**
 * Compute the next UTC timestamp (ms) at which a cron expression will fire,
 * evaluated in the given IANA timezone. Uses Intl.DateTimeFormat — no extra deps.
 * Returns null for unsupported / invalid expressions.
 */
function computeNextRun(cronExpr, timezone = 'UTC') {
  try {
    const parts = cronExpr.trim().split(/\s+/)
    if (parts.length !== 5) return null
    const [min, hr, , , dow] = parts
    const now = Date.now()

    // Helper: get wall-clock {year,month,day,hour,minute} in target TZ for a UTC ms value
    function wallClock(utcMs) {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      })
      const p = {}
      for (const { type, value } of fmt.formatToParts(new Date(utcMs))) {
        if (type !== 'literal') p[type] = parseInt(value, 10)
      }
      return p
    }

    // Helper: find the UTC ms for a specific wall-clock time in the target TZ.
    // Bisects between (approxUtc - 26h) and (approxUtc + 26h) to handle DST.
    function wallToUTC(year, month, day, hour, minute) {
      // ISO string as if it were UTC — serves as the starting pivot
      const pivot = Date.UTC(year, month - 1, day, hour, minute)
      // Binary search: find utcMs such that wallClock(utcMs) == target
      let lo = pivot - 26 * 3600000
      let hi = pivot + 26 * 3600000
      for (let i = 0; i < 40; i++) {
        const mid = Math.floor((lo + hi) / 2)
        const wc = wallClock(mid)
        const midMin = wc.hour * 60 + wc.minute
        const targetMin = hour * 60 + minute
        if (midMin < targetMin) lo = mid + 1
        else hi = mid
      }
      return lo
    }

    // Hourly: "0 * * * *"
    if (hr === '*') {
      const wc = wallClock(now)
      const base = wallToUTC(wc.year, wc.month, wc.day, wc.hour + 1, 0)
      return base > now ? base : base + 3600000
    }

    // Every N hours: "0 */N * * *"
    const ivMatch = hr.match(/^\*\/(\d+)$/)
    if (ivMatch) {
      const interval = parseInt(ivMatch[1])
      const wc = wallClock(now)
      const curHour = wc.hour
      const nextHour = Math.ceil((curHour + (wc.minute > 0 ? 1 : 0)) / interval) * interval % 24
      const dayOffset = nextHour <= curHour ? 1 : 0
      const base = wallToUTC(wc.year, wc.month, wc.day + dayOffset, nextHour, 0)
      return base
    }

    // Daily or weekly with specific H:M
    const targetHour = parseInt(hr)
    const targetMin  = parseInt(min) || 0
    if (isNaN(targetHour)) return null

    let targetDays = null // null = any day
    if (dow !== '*') {
      if (dow === '1-5') targetDays = new Set([1,2,3,4,5])
      else if (dow === '0,6' || dow === '6,0') targetDays = new Set([0,6])
      else targetDays = new Set(dow.split(',').map(Number))
    }

    const wc = wallClock(now)
    for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
      const candidate = wallToUTC(wc.year, wc.month, wc.day + daysAhead, targetHour, targetMin)
      if (candidate <= now) continue
      if (targetDays !== null) {
        const candidateDow = new Date(candidate).getDay()
        if (!targetDays.has(candidateDow)) continue
      }
      return candidate
    }
    return null
  } catch {
    return null
  }
}
