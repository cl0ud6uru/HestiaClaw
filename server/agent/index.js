import { Router } from 'express'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { runAgentLoop, readDailyNotes } from './loop.js'
import { createProvider } from './providers/index.js'
import { loadSkills, parseSkillManifest } from './skills.js'

export function createAgentRouter({ provider, session, registry, systemPrompt, mcpManager, approvals, events, settings = {}, skillsDir = null, configPath = null, memoryPath = null, soulPath = null, notesDir = null, onConsolidate = null }) {
  const getSkills = skillsDir ? () => loadSkills(skillsDir) : () => Promise.resolve([])
  const router = Router()
  let currentProvider = provider

  const runtimeSettings = {
    approvalsEnabled: approvals !== null && (settings.approvalsEnabled !== false),
    systemPrompt,
    model: settings.model || null,
    reasoningEffort: settings.reasoningEffort || null,
    thinkingBudget: settings.thinkingBudget || null,
    contextMaxMessages: settings.contextMaxMessages || 40,
    compactionEnabled: settings.compactionEnabled !== false,
    allowedTools: Array.isArray(settings.allowedTools) ? settings.allowedTools : null,
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

    // Built-in /approvals toggle command
    if (/^\/approvals(\s|$)/i.test(message)) {
      if (!approvals) {
        res.write(JSON.stringify({ type: 'token', content: 'Approvals are disabled in agent.config.json and cannot be toggled at runtime.' }) + '\n')
      } else {
        const arg = (message.split(/\s+/)[1] || '').toLowerCase()
        if (arg === 'on') runtimeSettings.approvalsEnabled = true
        else if (arg === 'off') runtimeSettings.approvalsEnabled = false
        else runtimeSettings.approvalsEnabled = !runtimeSettings.approvalsEnabled
        persistSettings()
        const state = runtimeSettings.approvalsEnabled ? 'enabled' : 'disabled'
        res.write(JSON.stringify({ type: 'token', content: `Tool approvals ${state}.` }) + '\n')
        res.write(JSON.stringify({ type: 'config_changed' }) + '\n')
      }
      res.write(JSON.stringify({ type: 'done' }) + '\n')
      res.end()
      return
    }

    // Detect /skill-name invocation
    let userMessage = message
    let activatedSkill = null
    if (message.startsWith('/')) {
      const [slashName, ...argParts] = message.slice(1).split(/\s+/)
      const matched = skills.find(s => s.name === slashName && s.userInvocable !== false)
      if (matched) {
        const args = argParts.join(' ').trim()
        userMessage = args
          ? `${matched.content}\n\nAdditional context: ${args}`
          : matched.content
        activatedSkill = { name: matched.name, trigger: 'slash', args }
        res.write(JSON.stringify({ type: 'skill_invoked', name: matched.name }) + '\n')
      }
    }

    // Read pinned memory
    let memorySummary = ''
    if (memoryPath) {
      try { memorySummary = readFileSync(memoryPath, 'utf8') } catch { /* file may not exist yet */ }
    }

    // Daily notes — today's and yesterday's episodic log
    const dailyNotes = readDailyNotes(notesDir)

    // Soul — persona prepended to policy at turn time so runtimeSettings.systemPrompt stays policy-only
    let soulContent = ''
    if (soulPath) {
      try { soulContent = readFileSync(soulPath, 'utf8').trim() } catch { /* SOUL.md optional */ }
    }
    const fullSystemPrompt = soulContent
      ? `${soulContent}\n\n${runtimeSettings.systemPrompt}`
      : runtimeSettings.systemPrompt

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
      systemPrompt: fullSystemPrompt,
      conversationId,
      userMessage,
      approvals: runtimeSettings.approvalsEnabled ? approvals : null,
      events,
      skills,
      activatedSkill,
      memorySummary,
      dailyNotes,
      activeMemory,
      allowedTools: runtimeSettings.allowedTools,
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
        allowedTools: runtimeSettings.allowedTools,
        providerDefault: currentProvider.model,
        providerName: currentProvider.name,
      },
      hooks: events?.getHandlerCounts() || [],
    })
  })

  router.get('/tools', (req, res) => {
    res.json({ tools: registry.listTools() })
  })

  router.get('/conversations', (req, res) => {
    res.json({ conversations: session.listConversations(Number(req.query.limit) || 50) })
  })

  router.get('/conversations/:id/messages', (req, res) => {
    const conversationId = String(req.params.id || '').trim()
    if (!conversationId) return res.status(400).json({ error: 'conversation_id is required.' })

    const history = session.getHistory(conversationId)
    const runs = session.getRunsWithToolCalls(conversationId)

    // Match runs to assistant messages by position: run[n] corresponds to the (n+1)th user→assistant exchange
    let runIdx = -1
    const messages = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => {
        if (m.role === 'user') runIdx++
        let content = ''
        if (typeof m.content === 'string') {
          content = m.content
        } else if (Array.isArray(m.content)) {
          content = m.content.map(p => p.text || p.content || '').filter(Boolean).join('')
        }
        const msg = { id: i + 1, role: m.role, content, streaming: false }
        if (m.role === 'assistant' && runs[runIdx]?.toolCalls?.length) {
          msg.toolCalls = runs[runIdx].toolCalls.map(tc => ({
            name: tc.name.replace(/__/g, ': '),
            type: 'subagent',
          }))
        }
        return msg
      })
      .filter(m => m.content)
    res.json({ messages })
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

  async function persistSettings() {
    if (!configPath) return
    try {
      const raw = await readFile(configPath, 'utf8')
      const cfg = JSON.parse(raw)
      cfg.provider = {
        ...cfg.provider,
        type: currentProvider.name,
        model: runtimeSettings.model || currentProvider.model,
      }
      cfg.systemPrompt = runtimeSettings.systemPrompt
      cfg.harness = {
        ...cfg.harness,
        compactionEnabled: runtimeSettings.compactionEnabled,
        contextMaxMessages: runtimeSettings.contextMaxMessages,
        approvalsEnabled: runtimeSettings.approvalsEnabled,
        ...(runtimeSettings.reasoningEffort != null ? { reasoningEffort: runtimeSettings.reasoningEffort } : {}),
        ...(runtimeSettings.thinkingBudget != null ? { thinkingBudget: runtimeSettings.thinkingBudget } : {}),
        ...(runtimeSettings.allowedTools !== null ? { allowedTools: runtimeSettings.allowedTools } : { allowedTools: undefined }),
      }
      await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    } catch (err) {
      console.warn('[agent] Could not persist settings to config:', err.message)
    }
  }

  router.post('/settings', async (req, res) => {
    const body = req.body || {}

    if (typeof body.provider === 'string' && ['anthropic', 'openai'].includes(body.provider)) {
      if (body.provider !== currentProvider.name) {
        currentProvider = createProvider({ type: body.provider, model: runtimeSettings.model || undefined })
        runtimeSettings.model = null
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
      runtimeSettings.model = body.model || null
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
    if ('allowedTools' in body) {
      runtimeSettings.allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools : null
    }

    persistSettings()

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

  router.get('/soul', (req, res) => {
    if (!soulPath) return res.status(503).json({ error: 'Soul file not configured.' })
    try {
      const soul = readFileSync(soulPath, 'utf8')
      return res.json({ soul })
    } catch {
      return res.json({ soul: '' })
    }
  })

  router.post('/soul', (req, res) => {
    if (!soulPath) return res.status(503).json({ error: 'Soul file not configured.' })
    const soul = String(req.body?.soul ?? '')
    try {
      writeFileSync(soulPath, soul, 'utf8')
      return res.json({ ok: true })
    } catch (err) {
      return res.status(500).json({ error: 'Failed to write SOUL.md.', detail: err.message })
    }
  })

  // Skills CRUD — REST interface for the skills/ directory, intended for UI use.
  // Note on approval: PUT and DELETE here bypass the agent approval flow by design.
  // These routes are protected by requireAuth (mounted in server/index.js), so only
  // an authenticated admin user can reach them. The approval flow exists for unilateral
  // LLM tool calls; a deliberate API request from a logged-in user is itself the approval.
  const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/

  function guardSkillPath(name) {
    const resolvedDir = resolve(skillsDir)
    const skillDir = resolve(skillsDir, name)
    const rel = relative(resolvedDir, skillDir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return skillDir
  }

  router.get('/skills', async (req, res) => {
    const skills = await getSkills()
    res.json({ skills })
  })

  router.get('/skills/:name', async (req, res) => {
    if (!skillsDir) return res.status(503).json({ error: 'Skills directory not configured.' })
    const name = String(req.params.name || '').trim()
    if (!VALID_SKILL_NAME.test(name)) return res.status(400).json({ error: 'Invalid skill name.' })
    const skillFile = join(skillsDir, name, 'SKILL.md')
    try {
      const text = await readFile(skillFile, 'utf8')
      res.json({ name, raw: text })
    } catch {
      res.status(404).json({ error: `Skill "${name}" not found.` })
    }
  })

  router.put('/skills/:name', async (req, res) => {
    if (!skillsDir) return res.status(503).json({ error: 'Skills directory not configured.' })
    const name = String(req.params.name || '').trim()
    if (!VALID_SKILL_NAME.test(name) || name.length > 64) {
      return res.status(400).json({ error: 'Invalid skill name. Use lowercase letters, digits, and hyphens.' })
    }
    const raw = String(req.body?.raw || '').trim()
    if (!raw) return res.status(400).json({ error: 'raw SKILL.md content is required.' })

    const parsed = parseSkillManifest(raw, name)
    if (!parsed) return res.status(422).json({ error: 'Invalid SKILL.md — missing required name or description fields.' })
    if (parsed.name !== name) return res.status(422).json({ error: `Skill name in frontmatter ("${parsed.name}") must match the URL parameter ("${name}").` })

    const skillDir = guardSkillPath(name)
    if (!skillDir) return res.status(400).json({ error: 'Invalid skill name.' })

    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), raw + '\n', 'utf8')
    res.json({ ok: true, skill: parsed })
  })

  router.delete('/skills/:name', async (req, res) => {
    if (!skillsDir) return res.status(503).json({ error: 'Skills directory not configured.' })
    const name = String(req.params.name || '').trim()
    if (!VALID_SKILL_NAME.test(name)) return res.status(400).json({ error: 'Invalid skill name.' })

    const skillDir = guardSkillPath(name)
    if (!skillDir) return res.status(400).json({ error: 'Invalid skill name.' })

    try {
      await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    } catch {
      return res.status(404).json({ error: `Skill "${name}" not found.` })
    }

    await rm(skillDir, { recursive: true, force: true })
    res.json({ ok: true })
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
