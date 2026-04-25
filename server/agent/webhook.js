import { readFileSync } from 'node:fs'
import { Router } from 'express'
import { runAgentLoop } from './loop.js'

export function createWebhookRouter({ provider, session, registry, systemPrompt, approvals, events, settings = {}, memoryPath = null }) {
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

    // Active memory recall (2s timeout)
    let activeMemory = ''
    if (registry.has('graphiti__search_nodes')) {
      try {
        const recall = await Promise.race([
          registry.execute('graphiti__search_nodes', { query, group_ids: ['hestia_user', 'hestia_home'], max_results: 5 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ])
        if (recall) activeMemory = String(recall).slice(0, 2000)
      } catch { /* fail silently — Graphiti may be slow or down */ }
    }

    const loopParams = {
      provider,
      session,
      registry,
      systemPrompt,
      conversationId,
      userMessage: query,
      approvals: approvals ?? null,
      events,
      skills: [],
      memorySummary,
      activeMemory,
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
