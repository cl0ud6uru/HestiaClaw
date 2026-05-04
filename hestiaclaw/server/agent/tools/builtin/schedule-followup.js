import * as db from '../../automations/db.js'
import { register as schedulerRegister } from '../../automations/scheduler.js'

/**
 * Parse a human-friendly delay string into milliseconds.
 * Supports: "5 minutes", "1 hour", "2h", "30m", "45s", "1d", "1.5h"
 */
function parseDelay(delay) {
  const s = String(delay).trim().toLowerCase()

  // Match: optional number, optional unit
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(seconds?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?$/)
  if (!match) throw new Error(`Cannot parse delay: "${delay}". Use formats like "5 minutes", "1h", "30m".`)

  const val = parseFloat(match[1])
  const unit = (match[2] || 'm')[0]
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const ms = Math.round(val * (multipliers[unit] ?? 60_000))
  if (ms < 10_000) throw new Error('Delay must be at least 10 seconds.')
  if (ms > 7 * 86_400_000) throw new Error('Delay must be 7 days or less.')
  return ms
}

function humanDelay(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) !== 1 ? 's' : ''}`
  if (ms < 86_400_000) return `${+(ms / 3_600_000).toFixed(1)} hour${ms / 3_600_000 !== 1 ? 's' : ''}`
  return `${+(ms / 86_400_000).toFixed(1)} day${ms / 86_400_000 !== 1 ? 's' : ''}`
}

export function registerScheduleFollowup(registry) {
  registry.register(
    'schedule_followup',
    'Schedule a follow-up task to run automatically after a delay and post the result back into this conversation. Use when the user asks you to "check back in X minutes", "let me know in an hour", or similar.',
    {
      type: 'object',
      properties: {
        delay: {
          type: 'string',
          description: 'How long to wait before running. Examples: "5 minutes", "1h", "30m", "2 hours".',
        },
        task: {
          type: 'string',
          description: 'The follow-up prompt to run — what to check or do when the timer fires.',
        },
      },
      required: ['delay', 'task'],
    },
    async ({ delay, task, conversation_id }) => {
      const ms = parseDelay(delay)
      const run_at = Date.now() + ms
      const label = humanDelay(ms)

      const id = db.create({
        name: `Follow-up in ${label}: ${task.slice(0, 40)}`,
        description: conversation_id ? `Follow-up from conversation ${conversation_id}` : 'Scheduled follow-up',
        prompt: task,
        trigger_type: 'one_off',
        run_at,
        conversation_id: conversation_id || null,
        timeout_seconds: 120,
        enabled: true,
      })

      // Register the timer immediately (no server restart needed)
      schedulerRegister(db.get(id))

      return `Follow-up scheduled — I'll check back in ${label} and post the result here.`
    },
    { source: 'builtin', kind: 'write', risk: 'low', injectConversationId: true },
  )
}
