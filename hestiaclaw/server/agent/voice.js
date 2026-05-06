import { readFileSync } from 'node:fs'
import { Router } from 'express'
import { runAgentLoop, readDailyNotes } from './loop.js'

export function createVoiceAgentRouter({ provider, session, registry, systemPrompt, events, settings = {}, memoryPath = null, soulPath = null, notesDir = null }) {
  const router = Router()
  const HESTIA_VOICE_TOKEN = process.env.HESTIA_VOICE_TOKEN || null

  function checkAuth(req, res) {
    if (!HESTIA_VOICE_TOKEN) return true
    const auth = req.headers['authorization'] || ''
    if (auth === `Bearer ${HESTIA_VOICE_TOKEN}`) return true
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }

  function makeCollector() {
    let text = ''
    return {
      setHeader() {},
      flushHeaders() {},
      write(data) {
        const line = data.toString().trim()
        if (!line) return
        try {
          const event = JSON.parse(line)
          if (event.type === 'token') text += event.content
        } catch { /* ignore parse errors */ }
      },
      end() {},
      getText() { return text },
    }
  }

  // POST /api/ha-voice/process
  // Called by the Hestia Conversation HA custom component for each Assist pipeline turn.
  // Body: { text, conversation_id?, language? }
  // Response: { speech, conversation_id }
  router.post('/process', async (req, res) => {
    if (!checkAuth(req, res)) return

    const text = String(req.body?.text || '').trim()
    const conversationId = String(req.body?.conversation_id || `ha-${Date.now()}`).trim()
    const language = String(req.body?.language || 'en').trim()

    if (!text) return res.status(400).json({ error: 'text is required.' })

    let memorySummary = ''
    if (memoryPath) {
      try { memorySummary = readFileSync(memoryPath, 'utf8') } catch { /* may not exist yet */ }
    }

    const dailyNotes = readDailyNotes(notesDir)

    let soulContent = ''
    if (soulPath) {
      try { soulContent = readFileSync(soulPath, 'utf8').trim() } catch { /* SOUL.md optional */ }
    }
    const fullSystemPrompt = soulContent ? `${soulContent}\n\n${systemPrompt}` : systemPrompt

    // Active memory recall (2s timeout)
    let activeMemory = ''
    if (registry.has('graphiti__search_nodes')) {
      try {
        const recall = await Promise.race([
          registry.execute('graphiti__search_nodes', { query: text, group_ids: ['hestia_user', 'hestia_home'], max_results: 5 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ])
        if (recall) activeMemory = String(recall).slice(0, 2000)
      } catch { /* fail silently — Graphiti may be slow or down */ }
    }

    const loopParams = {
      provider,
      session,
      registry,
      systemPrompt: fullSystemPrompt,
      conversationId,
      userMessage: text,
      approvals: null,
      events,
      skills: [],
      memorySummary,
      dailyNotes,
      activeMemory,
      allowedTools: Array.isArray(settings.allowedTools) ? settings.allowedTools : null,
      settings: {
        contextMaxMessages: settings.contextMaxMessages || 40,
        compactionEnabled: settings.compactionEnabled !== false,
        model: settings.model || null,
        reasoningEffort: settings.reasoningEffort || null,
        thinkingBudget: settings.thinkingBudget || null,
      },
    }

    const collector = makeCollector()
    try {
      await runAgentLoop(collector, loopParams)
    } catch (err) {
      console.error('[ha-voice] Agent loop error:', err.message)
      return res.json({ speech: 'I encountered an error processing your request.', conversation_id: conversationId })
    }

    const speech = collector.getText()
    console.log(`[ha-voice] Processed turn for conversation ${conversationId} (lang: ${language}, ${speech.length} chars)`)
    return res.json({ speech, conversation_id: conversationId })
  })

  return router
}
