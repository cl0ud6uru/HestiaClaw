import { readFileSync } from 'node:fs'
import { runAgentLoop, readDailyNotes } from '../loop.js'
import * as db from './db.js'

let _deps = null

export function init(deps) {
  _deps = deps
}

function createMockRes() {
  const events = []
  const res = {
    write(data) {
      const lines = String(data).split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { events.push(JSON.parse(trimmed)) } catch { /* ignore malformed */ }
      }
    },
    end() {},
    setHeader() {},
    flushHeaders() {},
    headersSent: false,
  }
  return { res, getEvents: () => events }
}

export async function runAutomation(automationId, triggerContext = '') {
  const automation = db.get(automationId)
  if (!automation) {
    console.error(`[automations] runAutomation: unknown id ${automationId}`)
    return
  }

  const runId = db.startRun(automationId)
  const { provider, session, registry, systemPrompt, settings, memoryPath, soulPath, notesDir } = _deps

  let memorySummary = ''
  if (memoryPath) {
    try { memorySummary = readFileSync(memoryPath, 'utf8') } catch { /* MEMORY.md may not exist */ }
  }

  let soulContent = ''
  if (soulPath) {
    try { soulContent = readFileSync(soulPath, 'utf8').trim() } catch { /* SOUL.md optional */ }
  }

  const dailyNotes = readDailyNotes(notesDir)

  let activeMemory = ''
  if (registry.has('graphiti__search_nodes')) {
    try {
      const recall = await Promise.race([
        registry.execute('graphiti__search_nodes', { query: automation.prompt, group_ids: ['hestia_user', 'hestia_home'], max_results: 5 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ])
      if (recall) activeMemory = String(recall).slice(0, 2000)
    } catch { /* fail silently */ }
  }

  const automationSystemPrompt = [
    soulContent ? `${soulContent}\n\n${systemPrompt}` : systemPrompt,
    'You are running an automated task. Complete the task described below and report results concisely. Do not ask for clarification — make reasonable assumptions and proceed.',
  ].filter(Boolean).join('\n\n')

  let userMessage = automation.prompt
  if (triggerContext) {
    userMessage += `\n\n[Trigger context: ${triggerContext}]`
  }

  const conversationId = `auto_${automationId}_${Date.now()}`
  const timeoutMs = (automation.timeout_seconds || 120) * 1000

  const { res: mockRes, getEvents } = createMockRes()

  try {
    await Promise.race([
      runAgentLoop(mockRes, {
        provider,
        session,
        registry,
        systemPrompt: automationSystemPrompt,
        conversationId,
        userMessage,
        approvals: null,
        events: null,
        memorySummary,
        dailyNotes,
        activeMemory,
        settings: {
          contextMaxMessages: 20,
          compactionEnabled: false,
          model: settings?.model || null,
          reasoningEffort: settings?.reasoningEffort || null,
          thinkingBudget: settings?.thinkingBudget || null,
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ])

    const events = getEvents()
    const output = events.filter(e => e.type === 'token').map(e => e.content).join('')
    const toolsUsed = [...new Set(events.filter(e => e.type === 'tool_start').map(e => e.name))]

    // Adaptive rescheduling: if agent returned {"next_run_in": "Xh"} parse it
    let nextRunAt = null
    const adaptiveMatch = output.match(/\{\s*"next_run_in"\s*:\s*"(\d+)([mhd])"\s*\}/)
    if (adaptiveMatch) {
      const val = parseInt(adaptiveMatch[1], 10)
      const unit = adaptiveMatch[2]
      const ms = unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000
      nextRunAt = Date.now() + ms
    }

    db.finishRun(runId, { status: 'success', output, toolsUsed })
    db.updateLastRun(automationId, 'success', nextRunAt)

    // If this automation was created as a conversation follow-up, post the result back
    if (automation.conversation_id && output) {
      try {
        _deps.session.appendMessages(automation.conversation_id, [
          { role: 'assistant', content: output },
        ])
        console.log(`[automations] Follow-up posted to conversation ${automation.conversation_id}`)
      } catch (err) {
        console.error(`[automations] Failed to post follow-up to conversation: ${err.message}`)
      }
    }

    console.log(`[automations] Run ${runId} completed for "${automation.name}"`)
  } catch (err) {
    const isTimeout = err.message === 'timeout'
    const events = getEvents()
    const output = events.filter(e => e.type === 'token').map(e => e.content).join('')
    const toolsUsed = [...new Set(events.filter(e => e.type === 'tool_start').map(e => e.name))]
    db.finishRun(runId, {
      status: isTimeout ? 'timeout' : 'failed',
      output: output || null,
      error: isTimeout ? `Timed out after ${automation.timeout_seconds}s` : err.message,
      toolsUsed,
    })
    db.updateLastRun(automationId, isTimeout ? 'timeout' : 'failed', null)
    console.error(`[automations] Run ${runId} ${isTimeout ? 'timed out' : 'failed'} for "${automation.name}": ${err.message}`)
  }
}
