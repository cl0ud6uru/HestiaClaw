import { readFileSync } from 'node:fs'
import { Router } from 'express'
import { runAgentLoop, readDailyNotes } from './loop.js'

export function createWebhookRouter({ provider, session, registry, systemPrompt, approvals, events, settings = {}, memoryPath = null, soulPath = null, notesDir = null }) {
  const router = Router()
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null

  function checkAuth(req, res) {
    if (!WEBHOOK_SECRET) return true
    const auth = req.headers['authorization'] || ''
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
      const password = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded
      if (password === WEBHOOK_SECRET) return true
    }
    if (auth === `Bearer ${WEBHOOK_SECRET}`) return true
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

  router.post('/conversation', async (req, res) => {
    if (!checkAuth(req, res)) return

    const query = String(req.body?.query || '').trim()
    const conversationId = String(req.body?.conversation_id || '').trim()
    const stream = req.body?.stream === true

    if (!query) return res.status(400).json({ error: 'query is required.' })
    if (!conversationId) return res.status(400).json({ error: 'conversation_id is required.' })

    // Pinned memory
    let memorySummary = ''
    if (memoryPath) {
      try { memorySummary = readFileSync(memoryPath, 'utf8') } catch { /* may not exist yet */ }
    }

    // Daily notes — today's and yesterday's episodic log
    const dailyNotes = readDailyNotes(notesDir)

    // Soul — prepend persona to policy so systemPrompt stays policy-only in config
    let soulContent = ''
    if (soulPath) {
      try { soulContent = readFileSync(soulPath, 'utf8').trim() } catch { /* SOUL.md optional */ }
    }
    const fullSystemPrompt = soulContent ? `${soulContent}\n\n${systemPrompt}` : systemPrompt

    // Parse exposed_entities from HA — gives agent immediate entity awareness
    let entityContext = ''
    if (req.body?.exposed_entities) {
      try {
        const raw = req.body.exposed_entities
        const entities = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Array.isArray(entities) && entities.length > 0) {
          const lines = entities.map(e =>
            `- ${e.entity_id} (${e.name})${e.area_name ? ` — area: ${e.area_name}` : ''} — state: ${e.state}`
          )
          entityContext = `Available Home Assistant entities:\n${lines.join('\n')}`
        }
      } catch { /* ignore malformed JSON */ }
    }

    // Active memory recall (2s timeout)
    let activeMemory = entityContext
    if (registry.has('graphiti__search_nodes')) {
      try {
        const recall = await Promise.race([
          registry.execute('graphiti__search_nodes', { query, group_ids: ['hestia_user', 'hestia_home'], max_results: 5 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ])
        if (recall) {
          const recallText = String(recall).slice(0, 2000)
          activeMemory = entityContext ? `${entityContext}\n\n${recallText}` : recallText
        }
      } catch { /* fail silently — Graphiti may be slow or down */ }
    }

    const loopParams = {
      provider,
      session,
      registry,
      systemPrompt: fullSystemPrompt,
      conversationId,
      userMessage: query,
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

    if (stream) {
      res.setHeader('Content-Type', 'text/plain')
      res.setHeader('Transfer-Encoding', 'chunked')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()

      const proxyRes = {
        setHeader() {},
        flushHeaders() {},
        write(data) {
          const line = data.toString().trim()
          if (!line) return
          try {
            const event = JSON.parse(line)
            if (event.type === 'token') {
              res.write(JSON.stringify({ type: 'item', content: event.content }) + '\n')
            } else if (event.type === 'done') {
              res.write(JSON.stringify({ type: 'end' }) + '\n')
            }
          } catch { /* ignore */ }
        },
        end() {},
      }

      try {
        await runAgentLoop(proxyRes, loopParams)
      } catch (err) {
        console.error('[webhook] Agent loop error (streaming):', err.message)
        res.write(JSON.stringify({ type: 'end' }) + '\n')
      }
      return res.end()
    }

    // Non-streaming: collect all tokens then return { output }
    const collector = makeCollector()
    try {
      await runAgentLoop(collector, loopParams)
    } catch (err) {
      console.error('[webhook] Agent loop error:', err.message)
      return res.json({ output: 'I encountered an error processing your request.' })
    }
    return res.json({ output: collector.getText() })
  })

  return router
}
