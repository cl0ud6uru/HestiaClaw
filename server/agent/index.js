import { Router } from 'express'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { runAgentLoop } from './loop.js'
import { createProvider } from './providers/index.js'
import { loadSkills } from './skills.js'

export function createAgentRouter({ provider, session, registry, systemPrompt, mcpManager, approvals, events, settings = {}, skillsDir = null, configPath = null, memoryPath = null, onConsolidate = null }) {
  const getSkills = skillsDir ? () => loadSkills(skillsDir) : () => Promise.resolve([])
  const router = Router()
  let currentProvider = provider

  const runtimeSettings = {
    approvalsEnabled: Boolean(approvals),
    systemPrompt,
    model: null,                                       // null = use provider default
    reasoningEffort: settings.reasoningEffort || null,
    thinkingBudget: settings.thinkingBudget || null,
    contextMaxMessages: settings.contextMaxMessages || 40,
    compactionEnabled: settings.compactionEnabled !== false,
  }

  router.post('/chat', async (req, res) => {
    const message = String(req.body?.message || '').trim()
    const conversationId = String(req.body?.conversation_id || '').trim()

    if (!message || !conversationId) {
      return res.status(400).json({ error: 'message and conversation_id are required.' })
    }

    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Transfer-Encoding', 'chunked')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()

    const skills = await getSkills()

    // Detect /skill-name invocation
    let userMessage = message
    if (message.startsWith('/')) {
      const [slashName, ...argParts] = message.slice(1).split(/\s+/)
      const matched = skills.find(s => s.name === slashName && s.userInvocable !== false)
      if (matched) {
        const args = argParts.join(' ').trim()
        userMessage = args
          ? `${matched.content}\n\nAdditional context: ${args}`
          : matched.content
        res.write(JSON.stringify({ type: 'skill_invoked', name: matched.name }) + '\n')
      }
    }

    // Read pinned memory
    let memorySummary = ''
    if (memoryPath) {
      try { memorySummary = readFileSync(memoryPath, 'utf8') } catch { /* file may not exist yet */ }
    }

    // Active memory recall — fast Graphiti search keyed on user message (2s timeout)
    let activeMemory = ''
    if (registry.has('graphiti__search_nodes')) {
      try {
        const recall = await Promise.race([
          registry.execute('graphiti__search_nodes', { query: message, group_ids: ['hestia_user', 'hestia_home'], max_results: 5 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
        ])
        if (recall) activeMemory = String(recall).slice(0, 2000)
      } catch { /* fail silently — Graphiti may be slow or down */ }
    }

    await runAgentLoop(res, {
      provider: currentProvider,
      session,
      registry,
      systemPrompt: runtimeSettings.systemPrompt,
      conversationId,
      userMessage,
      approvals: runtimeSettings.approvalsEnabled ? approvals : null,
      events,
      skills,
      memorySummary,
      activeMemory,
      settings: {
        contextMaxMessages: runtimeSettings.contextMaxMessages,
        compactionEnabled: runtimeSettings.compactionEnabled,
        model: runtimeSettings.model,
        reasoningEffort: runtimeSettings.reasoningEffort,
        thinkingBudget: runtimeSettings.thinkingBudget,
      },
    })

    res.end()
  })

  router.get('/config', async (req, res) => {
    const skills = await getSkills()
    res.json({
      provider: currentProvider.name,
      model: runtimeSettings.model || currentProvider.model,
      availableProviders: ['anthropic', 'openai'],
      toolCount: registry.size,
      tools: registry.listTools(),
      mcpServers: mcpManager?.getServers() || [],
      recentRuns: session.getRecentRuns(10),
      skills,
      features: {
        tracing: true,
        toolMetadata: true,
        mcpHttp: true,
        approvals: runtimeSettings.approvalsEnabled,
        approvalsConfigured: Boolean(approvals),
        compaction: runtimeSettings.compactionEnabled,
        branching: true,
        skills: skills.length > 0,
        reasoning: Boolean(runtimeSettings.reasoningEffort || runtimeSettings.thinkingBudget),
      },
      settings: {
        approvalTimeoutMs: approvals?.timeoutMs || null,
        contextMaxMessages: runtimeSettings.contextMaxMessages,
        compactionEnabled: runtimeSettings.compactionEnabled,
        approvalsEnabled: runtimeSettings.approvalsEnabled,
        systemPrompt: runtimeSettings.systemPrompt,
        model: runtimeSettings.model,
        reasoningEffort: runtimeSettings.reasoningEffort,
        thinkingBudget: runtimeSettings.thinkingBudget,
        providerDefault: currentProvider.model,
        providerName: currentProvider.name,
      },
      hooks: events?.getHandlerCounts() || [],
    })
  })

  router.get('/tools', (req, res) => {
    res.json({ tools: registry.listTools() })
  })

  router.get('/runs', (req, res) => {
    res.json({ runs: session.getRecentRuns(Number(req.query.limit) || 20) })
  })

  router.get('/approvals', (req, res) => {
    res.json({ approvals: approvals?.listPending() || [] })
  })

  router.post('/approvals/:id', (req, res) => {
    if (!approvals) return res.status(404).json({ error: 'Approvals are not enabled.' })
    const approved = req.body?.approved === true
    const reason = String(req.body?.reason || '').trim()
    const ok = approvals.resolve(req.params.id, approved, reason)
    if (!ok) return res.status(404).json({ error: 'Approval request not found or already resolved.' })
    return res.json({ ok: true })
  })

  const modelsCache = new Map()
  const MODELS_CACHE_TTL = 5 * 60 * 1000

  router.get('/models', async (req, res) => {
    const providerName = String(req.query.provider || currentProvider.name)
    if (!['anthropic', 'openai'].includes(providerName)) {
      return res.status(400).json({ error: 'Unknown provider.' })
    }
    const cached = modelsCache.get(providerName)
    if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL) {
      return res.json({ models: cached.models })
    }
    try {
      const p = providerName === currentProvider.name
        ? currentProvider
        : createProvider({ type: providerName })
      const models = await p.listModels()
      modelsCache.set(providerName, { models, fetchedAt: Date.now() })
      return res.json({ models })
    } catch (err) {
      console.error(`[agent] listModels(${providerName}) failed:`, err.message)
      return res.status(502).json({ error: 'Failed to fetch models from provider.', detail: err.message })
    }
  })

  async function persistProviderModel(type, model) {
    if (!configPath) return
    try {
      const raw = await readFile(configPath, 'utf8')
      const cfg = JSON.parse(raw)
      cfg.provider = { ...cfg.provider, type, model }
      await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    } catch (err) {
      console.warn('[agent] Could not persist provider/model to config:', err.message)
    }
  }

  router.post('/settings', async (req, res) => {
    const body = req.body || {}
    let providerChanged = false
    let modelChanged = false

    if (typeof body.provider === 'string' && ['anthropic', 'openai'].includes(body.provider)) {
      if (body.provider !== currentProvider.name) {
        currentProvider = createProvider({ type: body.provider, model: runtimeSettings.model || undefined })
        runtimeSettings.model = null
        providerChanged = true
      }
    }

    if (typeof body.approvals === 'boolean') {
      if (!approvals) return res.status(409).json({ error: 'Approvals were disabled in agent.config.json and cannot be toggled at runtime.' })
      runtimeSettings.approvalsEnabled = body.approvals
    }
    if (typeof body.systemPrompt === 'string') {
      runtimeSettings.systemPrompt = body.systemPrompt
    }
    if (typeof body.model === 'string') {
      const newModel = body.model || null
      if (newModel !== runtimeSettings.model) { runtimeSettings.model = newModel; modelChanged = true }
    }
    if (body.reasoningEffort !== undefined) {
      runtimeSettings.reasoningEffort = body.reasoningEffort || null
    }
    if (body.thinkingBudget !== undefined) {
      runtimeSettings.thinkingBudget = body.thinkingBudget ? Number(body.thinkingBudget) : null
    }
    if (typeof body.contextMaxMessages === 'number' && body.contextMaxMessages > 0) {
      runtimeSettings.contextMaxMessages = body.contextMaxMessages
    }
    if (typeof body.compactionEnabled === 'boolean') {
      runtimeSettings.compactionEnabled = body.compactionEnabled
    }

    if (providerChanged || modelChanged) {
      persistProviderModel(currentProvider.name, runtimeSettings.model || currentProvider.model)
    }

    return res.json({ ok: true, settings: { ...runtimeSettings } })
  })

  router.post('/conversations/fork', (req, res) => {
    const sourceConversationId = String(req.body?.source_conversation_id || '').trim()
    const targetConversationId = String(req.body?.target_conversation_id || '').trim()
    if (!sourceConversationId || !targetConversationId) {
      return res.status(400).json({ error: 'source_conversation_id and target_conversation_id are required.' })
    }
    session.forkConversation(sourceConversationId, targetConversationId)
    return res.json({ ok: true })
  })

  router.post('/consolidate', async (req, res) => {
    if (!onConsolidate) {
      return res.status(503).json({ error: 'Memory consolidation is not configured.' })
    }
    try {
      const result = await onConsolidate()
      return res.json({ ok: true, ...result })
    } catch (err) {
      console.error('[agent] Consolidation error:', err.message)
      return res.status(500).json({ error: 'Consolidation failed.', detail: err.message })
    }
  })

  return router
}
