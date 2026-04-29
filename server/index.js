import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import Database from 'better-sqlite3'
import argon2 from 'argon2'
import SQLiteStoreFactory from 'connect-sqlite3'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import session from 'express-session'
import helmet from 'helmet'
import neo4j from 'neo4j-driver'
import { createAgentRouter } from './agent/index.js'
import { createWebhookRouter } from './agent/webhook.js'
import { ApprovalManager } from './agent/approvals.js'
import { AgentEventBus } from './agent/events.js'
import { createProvider } from './agent/providers/index.js'
import { AgentSession } from './agent/session.js'
import { ToolRegistry } from './agent/tools/registry.js'
import { registerWebSearch } from './agent/tools/builtin/web-search.js'
import { registerMemoryTools, registerDailyNoteTool } from './agent/tools/builtin/memory-file.js'
import { registerScheduleFollowup } from './agent/tools/builtin/schedule-followup.js'
import { registerSkillsManagerTools } from './agent/tools/builtin/skills-manager.js'
import { McpClientManager } from './agent/mcp/client.js'
import { runConsolidation } from './agent/memory-consolidation.js'
import { initDb as initAutomationsDb } from './agent/automations/db.js'
import { init as initAutomationsRunner } from './agent/automations/runner.js'
import { syncAll as syncAutomations } from './agent/automations/scheduler.js'
import { createAutomationsRouter, createTriggerHandler } from './agent/automations/routes.js'
import cron from 'node-cron'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT || 3001)
const IS_PROD = process.env.NODE_ENV === 'production'
const DEFAULT_N8N_WEBHOOK_URL = 'https://n8n.privatecloudconcepts.com/webhook/4e097a70-0ee5-453e-92d2-cfc9e05e6f234'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.resolve(ROOT_DIR, 'data')
const DATABASE_PATH = path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/hestia.sqlite')
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? '' : 'dev-session-secret-change-me')
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || (IS_PROD ? '' : DEFAULT_N8N_WEBHOOK_URL)
const BOOTSTRAP_ADMIN_USERNAME = process.env.BOOTSTRAP_ADMIN_USERNAME || (IS_PROD ? '' : 'admin')
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || (IS_PROD ? '' : 'change-me-now')
const TRUST_PROXY = process.env.TRUST_PROXY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''
const ELEVENLABS_DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || ''
const ELEVENLABS_TTS_MODEL_ID = process.env.ELEVENLABS_TTS_MODEL_ID || 'eleven_flash_v2_5'
const ELEVENLABS_STT_MODEL_ID = process.env.ELEVENLABS_STT_MODEL_ID || 'scribe_v2_realtime'
const NEO4J_URI = process.env.NEO4J_URI || ''
const NEO4J_USER = process.env.NEO4J_USER || ''
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || ''

const AGENT_CONFIG_PATH = path.resolve(ROOT_DIR, 'agent.config.json')
const MEMORY_PATH = path.resolve(DATA_DIR, 'MEMORY.md')
const MEMORY_HISTORY_PATH = path.resolve(DATA_DIR, 'memory-history.json')
const SOUL_PATH = path.resolve(DATA_DIR, 'SOUL.md')
const NOTES_DIR = path.resolve(DATA_DIR, 'notes')
const SKILLS_DIR = path.join(ROOT_DIR, 'skills')
let agentConfig = null
try {
  agentConfig = JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf8'))
} catch {
  // agent.config.json is optional; harness only activates when present
}

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production.')
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

if (!fs.existsSync(MEMORY_PATH)) {
  fs.writeFileSync(MEMORY_PATH, '# Hestia Memory\n\n*No pinned memories yet. The consolidation cron will populate this file.*\n', 'utf8')
  console.log('[memory] data/MEMORY.md created')
}

if (!fs.existsSync(SOUL_PATH)) {
  fs.writeFileSync(SOUL_PATH, 'You are Hestia, a smart home AI assistant. You are precise, helpful, and professional. Be concise but thorough.\n', 'utf8')
  console.log('[soul] data/SOUL.md created')
}

fs.mkdirSync(NOTES_DIR, { recursive: true })

if (TRUST_PROXY) {
  app.set('trust proxy', Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY))
}

const db = new Database(DATABASE_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    username TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
`)

const SQLiteStore = SQLiteStoreFactory(session)
const sessionStore = new SQLiteStore({
  db: 'sessions.sqlite',
  dir: DATA_DIR,
})

const findUserByUsername = db.prepare('SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?')
const findUserById = db.prepare('SELECT id, username FROM users WHERE id = ?')
const createUser = db.prepare('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
const updateUserCredentials = db.prepare('UPDATE users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?')
const insertAuditLog = db.prepare('INSERT INTO audit_log (action, username, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

function writeAuditLog(req, action, username = null) {
  insertAuditLog.run(action, username, clientIp(req), req.get('user-agent') || null, Date.now())
}

async function ensureBootstrapAdmin() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
  if (userCount > 0) return

  if (!BOOTSTRAP_ADMIN_USERNAME || !BOOTSTRAP_ADMIN_PASSWORD) {
    throw new Error('No admin user exists. Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD.')
  }

  const now = Date.now()
  const passwordHash = await argon2.hash(BOOTSTRAP_ADMIN_PASSWORD)
  createUser.run(BOOTSTRAP_ADMIN_USERNAME, passwordHash, now, now)
  console.warn(
    `[auth] Bootstrapped admin "${BOOTSTRAP_ADMIN_USERNAME}". ` +
    'Change this password immediately from the authenticated settings panel.',
  )
}

function isAllowedOrigin(req) {
  const origin = req.get('origin')
  if (!origin) return true

  try {
    const originUrl = new URL(origin)
    const currentHostOrigin = `${req.protocol}://${req.get('host')}`

    if (!IS_PROD && originUrl.hostname === 'localhost') {
      return true
    }

    // Host-only match handles reverse proxies that terminate SSL (protocol mismatch)
    if (originUrl.host === req.get('host')) return true

    const allowedOrigins = new Set([
      FRONTEND_ORIGIN,
      currentHostOrigin,
    ])

    return allowedOrigins.has(originUrl.origin)
  } catch {
    return false
  }
}

function requireSameOrigin(req, res, next) {
  if (req.method !== 'POST') return next()
  if (isAllowedOrigin(req)) return next()
  return res.status(403).json({ error: 'Cross-site request rejected.' })
}

function requireAuth(req, res, next) {
  if (req.session.userId) return next()
  return res.status(401).json({ error: 'Authentication required.' })
}

function requireVoiceConfig(res) {
  if (!ELEVENLABS_API_KEY) {
    res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured.' })
    return false
  }

  if (!ELEVENLABS_DEFAULT_VOICE_ID) {
    res.status(500).json({ error: 'ELEVENLABS_DEFAULT_VOICE_ID is not configured.' })
    return false
  }

  return true
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 7,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
})

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
}))
app.use(express.json({ limit: '1mb' }))
app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}))

app.get('/api/auth/session', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false })
  }

  const user = findUserById.get(req.session.userId)
  if (!user) {
    req.session.destroy(() => {})
    return res.json({ authenticated: false })
  }

  return res.json({
    authenticated: true,
    user,
  })
})

app.post('/api/auth/login', requireSameOrigin, loginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const user = username ? findUserByUsername.get(username) : null

  if (!user) {
    writeAuditLog(req, 'login_failed', username || null)
    return res.status(401).json({ error: 'Invalid username or password.' })
  }

  const valid = await argon2.verify(user.passwordHash, password)
  if (!valid) {
    writeAuditLog(req, 'login_failed', username)
    return res.status(401).json({ error: 'Invalid username or password.' })
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ error: 'Unable to create session.' })
    }

    req.session.userId = user.id
    writeAuditLog(req, 'login_succeeded', user.username)
    return res.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    })
  })
})

app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
  const username = req.session.userId ? findUserById.get(req.session.userId)?.username : null
  req.session.destroy(() => {
    if (username) writeAuditLog(req, 'logout', username)
    res.clearCookie('connect.sid')
    res.json({ ok: true })
  })
})

app.post('/api/auth/change-password', requireSameOrigin, requireAuth, async (req, res) => {
  const user = findUserById.get(req.session.userId)
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  const newUsername = String(req.body?.newUsername || '').trim()

  if (!user) {
    req.session.destroy(() => {})
    return res.status(401).json({ error: 'Authentication required.' })
  }

  if (newUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' })
  }

  if (newPassword.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters.' })
  }

  const existing = findUserByUsername.get(user.username)
  const valid = existing ? await argon2.verify(existing.passwordHash, currentPassword) : false
  if (!valid) {
    writeAuditLog(req, 'change_password_failed', user.username)
    return res.status(401).json({ error: 'Current password is incorrect.' })
  }

  const duplicateUser = findUserByUsername.get(newUsername)
  if (duplicateUser && duplicateUser.id !== user.id) {
    return res.status(409).json({ error: 'That username is already in use.' })
  }

  const passwordHash = await argon2.hash(newPassword)
  updateUserCredentials.run(newUsername, passwordHash, Date.now(), user.id)
  writeAuditLog(req, 'change_password_succeeded', newUsername)

  return res.json({
    ok: true,
    user: { id: user.id, username: newUsername },
  })
})

app.post('/api/chat/send', requireSameOrigin, requireAuth, async (req, res) => {
  if (!N8N_WEBHOOK_URL) {
    return res.status(500).json({ error: 'N8N_WEBHOOK_URL is not configured.' })
  }

  const chatInput = String(req.body?.chatInput || '').trim()
  const conversationId = String(req.body?.conversation_id || '').trim()

  if (!chatInput || !conversationId) {
    return res.status(400).json({ error: 'chatInput and conversation_id are required.' })
  }

  try {
    const upstream = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatInput,
        conversation_id: conversationId,
      }),
    })

    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) {
      res.setHeader('content-type', contentType)
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text()
      return res.send(text || JSON.stringify({ error: `Upstream error ${upstream.status}` }))
    }

    Readable.fromWeb(upstream.body).pipe(res)
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to reach upstream automation service.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get('/api/voice/voices', requireAuth, async (req, res) => {
  if (!requireVoiceConfig(res)) return

  try {
    const upstream = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    })

    if (!upstream.ok) {
      const text = await upstream.text()
      return res.status(502).json({
        error: 'Unable to load ElevenLabs voices.',
        detail: text || `HTTP ${upstream.status}`,
      })
    }

    const data = await upstream.json()
    const voices = Array.isArray(data?.voices)
      ? data.voices.map(voice => ({
        voiceId: voice.voice_id,
        name: voice.name,
        category: voice.category,
        description: voice.description || '',
      }))
      : []

    return res.json({
      voices,
      defaultVoiceId: ELEVENLABS_DEFAULT_VOICE_ID,
      ttsModelId: ELEVENLABS_TTS_MODEL_ID,
      sttModelId: ELEVENLABS_STT_MODEL_ID,
    })
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to reach ElevenLabs voice service.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/voice/token', requireSameOrigin, requireAuth, async (req, res) => {
  if (!requireVoiceConfig(res)) return

  const tokenType = String(req.body?.type || '').trim()
  if (tokenType !== 'realtime_scribe' && tokenType !== 'tts_websocket') {
    return res.status(400).json({ error: 'Unsupported voice token type.' })
  }

  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${tokenType}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    })

    if (!upstream.ok) {
      const text = await upstream.text()
      return res.status(502).json({
        error: 'Unable to create ElevenLabs token.',
        detail: text || `HTTP ${upstream.status}`,
      })
    }

    const data = await upstream.json()
    return res.json({
      token: data.token,
      defaultVoiceId: ELEVENLABS_DEFAULT_VOICE_ID,
      ttsModelId: ELEVENLABS_TTS_MODEL_ID,
      sttModelId: ELEVENLABS_STT_MODEL_ID,
    })
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to reach ElevenLabs token service.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/voice/transcribe', requireSameOrigin, requireAuth, async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured.' })
  }

  const audioBase64 = String(req.body?.audioBase64 || '')
  const mimeType = String(req.body?.mimeType || 'audio/webm')
  const fileName = String(req.body?.fileName || 'voice-input.webm')

  if (!audioBase64) {
    return res.status(400).json({ error: 'audioBase64 is required.' })
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64')
    const form = new FormData()
    form.append('model_id', 'scribe_v2')
    form.append('language_code', 'en')
    form.append('file', new Blob([audioBuffer], { type: mimeType }), fileName)

    const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: form,
    })

    if (!upstream.ok) {
      const text = await upstream.text()
      return res.status(502).json({
        error: 'Unable to create speech transcript.',
        detail: text || `HTTP ${upstream.status}`,
      })
    }

    const data = await upstream.json()
    return res.json({ text: String(data?.text || '').trim() })
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to reach ElevenLabs transcription service.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/voice/speak', requireSameOrigin, requireAuth, async (req, res) => {
  if (!requireVoiceConfig(res)) return

  const text = String(req.body?.text || '').trim()
  const voiceId = String(req.body?.voiceId || ELEVENLABS_DEFAULT_VOICE_ID).trim()

  if (!text) {
    return res.status(400).json({ error: 'text is required.' })
  }

  if (!voiceId) {
    return res.status(400).json({ error: 'voiceId is required.' })
  }

  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_TTS_MODEL_ID,
      }),
    })

    if (!upstream.ok || !upstream.body) {
      const textBody = await upstream.text()
      return res.status(502).json({
        error: 'Unable to generate assistant speech.',
        detail: textBody || `HTTP ${upstream.status}`,
      })
    }

    res.status(upstream.status)
    res.setHeader('content-type', upstream.headers.get('content-type') || 'audio/mpeg')
    Readable.fromWeb(upstream.body).pipe(res)
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to reach ElevenLabs speech service.',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

const neo4jDriver = (NEO4J_URI && NEO4J_USER && NEO4J_PASSWORD)
  ? neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
  : null

process.on('exit', () => neo4jDriver?.close())

app.get('/api/graph', requireAuth, async (req, res) => {
  if (!neo4jDriver) {
    return res.status(503).json({ error: 'Neo4j is not configured. Add NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD to .env.' })
  }

  const limit = Math.min(Number(req.query.limit) || 500, 2000)
  const session = neo4jDriver.session()

  try {
    const result = await session.run(
      `MATCH (n:Entity)-[r:RELATES_TO]->(m:Entity)
       RETURN n, r, m
       LIMIT $limit`,
      { limit: neo4j.int(limit) },
    )

    const nodeMap = new Map()
    const edges = []

    for (const record of result.records) {
      const n = record.get('n')
      const m = record.get('m')
      const r = record.get('r')

      for (const node of [n, m]) {
        if (!nodeMap.has(node.elementId)) {
          const props = node.properties
          nodeMap.set(node.elementId, {
            id: node.elementId,
            label: String(props.name || props.label || node.elementId).slice(0, 40),
            community: neo4j.isInt(props.community) ? props.community.toNumber() : (Number(props.community) || 0),
            degree: neo4j.isInt(props.degree) ? props.degree.toNumber() : (Number(props.degree) || 1),
          })
        }
      }

      edges.push({
        from: r.startNodeElementId,
        to: r.endNodeElementId,
        label: String(r.properties?.fact || '').slice(0, 60),
      })
    }

    return res.json({ nodes: Array.from(nodeMap.values()), edges })
  } catch (error) {
    return res.status(502).json({
      error: 'Unable to query Neo4j knowledge graph.',
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await session.close()
  }
})

app.post('/api/graph/recompute', requireSameOrigin, requireAuth, async (req, res) => {
  if (!neo4jDriver) {
    return res.status(503).json({ error: 'Neo4j is not configured.' })
  }

  const session = neo4jDriver.session()
  try {
    // Drop existing projection if one is lingering from a previous failed run
    await session.run(`
      CALL gds.graph.exists('hestia-graph') YIELD exists
      WITH exists WHERE exists = true
      CALL gds.graph.drop('hestia-graph') YIELD graphName
      RETURN graphName
    `).catch(() => {})

    const projectResult = await session.run(`
      CALL gds.graph.project('hestia-graph', '*', {RELATES_TO: {orientation: 'UNDIRECTED'}})
      YIELD graphName, nodeCount, relationshipCount
      RETURN graphName, nodeCount, relationshipCount
    `)

    const nodeCount = projectResult.records[0]?.get('nodeCount')
    const count = neo4j.isInt(nodeCount) ? nodeCount.toNumber() : Number(nodeCount ?? 0)

    if (count > 0) {
      await session.run(`
        CALL gds.louvain.write('hestia-graph', {writeProperty: 'community'})
        YIELD communityCount, modularity
        RETURN communityCount, modularity
      `)

      await session.run(`
        CALL gds.degree.write('hestia-graph', {writeProperty: 'degree'})
        YIELD nodePropertiesWritten
        RETURN nodePropertiesWritten
      `)
    }

    await session.run(`
      CALL gds.graph.drop('hestia-graph') YIELD graphName
      RETURN graphName
    `)

    return res.json({ ok: true, nodeCount: count })
  } catch (error) {
    return res.status(502).json({
      error: 'GDS recompute failed.',
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await session.close()
  }
})

const distPath = path.resolve(ROOT_DIR, 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    return res.sendFile(path.join(distPath, 'index.html'))
  })
}

await ensureBootstrapAdmin()

// Agent harness — only active when agent.config.json is present
let mcpManager = null
if (agentConfig) {
  const agentSession = new AgentSession(db)
  const registry = new ToolRegistry()
  registerWebSearch(registry)
  registerMemoryTools(registry, MEMORY_PATH, MEMORY_HISTORY_PATH)
  registerDailyNoteTool(registry, NOTES_DIR)
  registerScheduleFollowup(registry)
  registerSkillsManagerTools(registry, SKILLS_DIR)

  mcpManager = new McpClientManager(registry)
  await mcpManager.init(agentConfig.mcpServers || {})

  let provider
  try {
    provider = createProvider(agentConfig.provider || {})
    console.log(`[agent] Provider: ${provider.name} / ${agentConfig.provider?.model || 'default model'}`)
  } catch (err) {
    console.error('[agent] Failed to initialize provider:', err.message)
  }

  if (provider) {
    const systemPrompt = agentConfig.systemPrompt || ''
    const harnessSettings = {
      contextMaxMessages: Number(agentConfig.harness?.contextMaxMessages) || 40,
      compactionEnabled: agentConfig.harness?.compactionEnabled !== false,
      reasoningEffort: agentConfig.harness?.reasoningEffort || null,
      thinkingBudget: agentConfig.harness?.thinkingBudget || null,
      model: agentConfig.provider?.model || null,
    }
    const approvals = agentConfig.harness?.approvals === false
      ? null
      : new ApprovalManager({ timeoutMs: Number(agentConfig.harness?.approvalTimeoutMs) || 60000 })
    const events = new AgentEventBus()
    const consolidate = () => runConsolidation({ provider, registry, memoryPath: MEMORY_PATH, historyPath: MEMORY_HISTORY_PATH })
    const agentRouter = createAgentRouter({
      provider,
      session: agentSession,
      registry,
      systemPrompt,
      mcpManager,
      approvals,
      events,
      settings: harnessSettings,
      skillsDir: SKILLS_DIR,
      configPath: AGENT_CONFIG_PATH,
      memoryPath: MEMORY_PATH,
      historyPath: MEMORY_HISTORY_PATH,
      soulPath: SOUL_PATH,
      notesDir: NOTES_DIR,
      onConsolidate: consolidate,
    })
    app.use('/api/agent', requireSameOrigin, requireAuth, agentRouter)

    const webhookRouter = createWebhookRouter({
      provider,
      session: agentSession,
      registry,
      systemPrompt,
      events,
      settings: harnessSettings,
      skillsDir: SKILLS_DIR,
      memoryPath: MEMORY_PATH,
      soulPath: SOUL_PATH,
      notesDir: NOTES_DIR,
    })
    app.use('/api/webhook', webhookRouter)
    console.log('[agent] Webhook endpoint active at POST /api/webhook/conversation')
    console.log(`[agent] Harness ready — ${registry.size} tool(s) registered`)

    // Daily memory consolidation at 3 AM
    cron.schedule('0 3 * * *', () => {
      console.log('[consolidation] Running scheduled daily consolidation...')
      consolidate().catch(err => console.error('[consolidation] Scheduled run failed:', err.message))
    })
    console.log('[consolidation] Daily cron scheduled at 03:00')

    // Automations / scheduled tasks
    initAutomationsDb(DATABASE_PATH)
    initAutomationsRunner({ provider, session: agentSession, registry, systemPrompt, settings: harnessSettings, memoryPath: MEMORY_PATH, soulPath: SOUL_PATH, notesDir: NOTES_DIR })
    syncAutomations()

    // Public webhook trigger (no auth) — must be mounted before the protected router
    app.use('/api/automations/trigger', createTriggerHandler())
    app.use('/api/automations', requireSameOrigin, requireAuth, createAutomationsRouter())
    console.log('[automations] Routes mounted at /api/automations')
  }
} else {
  console.log('[agent] No agent.config.json found — native harness disabled. Using N8N mode only.')
}

process.on('SIGTERM', async () => {
  await mcpManager?.shutdown()
  process.exit(0)
})
process.on('SIGINT', async () => {
  await mcpManager?.shutdown()
  process.exit(0)
})

app.listen(PORT, () => {
  console.log(`[server] Hestia server listening on http://localhost:${PORT}`)
  if (!IS_PROD) {
    console.log(`[server] Frontend dev origin: ${FRONTEND_ORIGIN}`)
    if (!process.env.N8N_WEBHOOK_URL) {
      console.warn('[server] Using fallback development N8N webhook URL. Set N8N_WEBHOOK_URL in .env to override it.')
    }
  }
})
