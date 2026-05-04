import { randomUUID } from 'node:crypto'

export class AgentSession {
  constructor(db) {
    this._db = db
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id, id);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        user_message TEXT NOT NULL,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_conv ON agent_runs(conversation_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS agent_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, id);

      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        name TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, id);

      CREATE TABLE IF NOT EXISTS agent_conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        summarized_through_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this._getHistory = db.prepare(
      'SELECT id, role, content FROM agent_messages WHERE conversation_id = ? ORDER BY id ASC',
    )
    this._getRecentHistory = db.prepare(
      'SELECT id, role, content FROM agent_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    )
    this._insert = db.prepare(
      'INSERT INTO agent_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    )
    this._copyMessages = db.prepare(`
      INSERT INTO agent_messages (conversation_id, role, content, created_at)
      SELECT ?, role, content, ?
      FROM agent_messages
      WHERE conversation_id = ?
      ORDER BY id ASC
    `)
    this._insertMany = db.transaction((convId, messages) => {
      const now = Date.now()
      for (const msg of messages) {
        // Responses API items use 'type' instead of 'role' (e.g. function_call, function_call_output)
        this._insert.run(convId, msg.role || msg.type || 'unknown', JSON.stringify(msg), now)
      }
    })
    this._insertRun = db.prepare(
      'INSERT INTO agent_runs (id, conversation_id, provider, model, status, user_message, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this._updateRun = db.prepare(
      'UPDATE agent_runs SET status = ?, error = ?, completed_at = ? WHERE id = ?',
    )
    this._insertRunEvent = db.prepare(
      'INSERT INTO agent_run_events (run_id, type, data, created_at) VALUES (?, ?, ?, ?)',
    )
    this._insertToolCall = db.prepare(
      'INSERT INTO agent_tool_calls (run_id, tool_call_id, name, input, started_at) VALUES (?, ?, ?, ?, ?)',
    )
    this._updateToolCall = db.prepare(
      'UPDATE agent_tool_calls SET result = ?, error = ?, completed_at = ? WHERE run_id = ? AND tool_call_id = ?',
    )
    this._getRunsWithTools = db.prepare(`
      SELECT r.id, r.started_at, t.name AS tool_name
      FROM agent_runs r
      LEFT JOIN agent_tool_calls t ON t.run_id = r.id
      WHERE r.conversation_id = ?
      ORDER BY r.started_at ASC, t.id ASC
    `)
    this._listConversations = db.prepare(`
      SELECT
        r.conversation_id AS id,
        MIN(r.started_at) AS createdAt,
        MAX(r.started_at) AS updatedAt,
        (SELECT user_message FROM agent_runs WHERE conversation_id = r.conversation_id ORDER BY started_at ASC LIMIT 1) AS firstMessage
      FROM agent_runs r
      WHERE r.conversation_id NOT LIKE 'auto_%'
      GROUP BY r.conversation_id
      ORDER BY MAX(r.started_at) DESC
      LIMIT ?
    `)
    this._getRecentRuns = db.prepare(`
      SELECT
        r.id,
        r.conversation_id AS conversationId,
        r.provider,
        r.model,
        r.status,
        r.error,
        r.started_at AS startedAt,
        r.completed_at AS completedAt,
        COUNT(t.id) AS toolCallCount
      FROM agent_runs r
      LEFT JOIN agent_tool_calls t ON t.run_id = r.id
      GROUP BY r.id
      ORDER BY r.started_at DESC
      LIMIT ?
    `)
    this._getSummary = db.prepare(
      'SELECT summary, summarized_through_id AS summarizedThroughId FROM agent_conversation_summaries WHERE conversation_id = ?',
    )
    this._upsertSummary = db.prepare(`
      INSERT INTO agent_conversation_summaries (conversation_id, summary, summarized_through_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        summarized_through_id = excluded.summarized_through_id,
        updated_at = excluded.updated_at
    `)
    this._copySummary = db.prepare(`
      INSERT INTO agent_conversation_summaries (conversation_id, summary, summarized_through_id, updated_at)
      SELECT ?, summary, summarized_through_id, ?
      FROM agent_conversation_summaries
      WHERE conversation_id = ?
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        summarized_through_id = excluded.summarized_through_id,
        updated_at = excluded.updated_at
    `)
    this._forkConversationTx = db.transaction((sourceId, targetId) => {
      const now = Date.now()
      this._copyMessages.run(targetId, now, sourceId)
      this._copySummary.run(targetId, now, sourceId)
    })
  }

  _deserializeRow(row) {
    const message = (() => {
      try {
        const parsed = JSON.parse(row.content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.role) {
          return parsed
        }
        return { role: row.role, content: parsed === null || parsed === undefined ? '' : parsed }
      } catch {
        return { role: row.role, content: row.content }
      }
    })()
    return { id: row.id, message }
  }

  _isValidMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false
    if (typeof message.role !== 'string') return false
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return false
    if (message.role === 'tool' && !message.tool_call_id) return false
    return true
  }

  getHistory(conversationId) {
    return this._getHistory
      .all(conversationId)
      .map(row => this._deserializeRow(row).message)
      .filter(message => this._isValidMessage(message))
  }

  getContext(conversationId, { maxMessages = 40, compactionEnabled = true } = {}) {
    const limit = Math.max(1, Number(maxMessages) || 40)
    const rows = this._getHistory.all(conversationId)
    if (!compactionEnabled || rows.length <= limit) {
      return {
        messages: rows
          .map(row => this._deserializeRow(row).message)
          .filter(message => this._isValidMessage(message)),
        summary: '',
        totalMessages: rows.length,
        needsSummary: false,
        rowsToSummarize: [],
        summarizeThroughId: null,
      }
    }

    const summaryRow = this._getSummary.get(conversationId)
    const fillRatio = rows.length / limit

    // Stage 4: emergency — keep only the last 10 messages, force re-summarize
    const keptCount = fillRatio > 1.9 ? 10 : limit
    const keptRows = this._getRecentHistory.all(conversationId, keptCount).reverse()
    const firstKeptId = keptRows[0]?.id || 0
    const rowsToSummarize = rows.filter(row => row.id < firstKeptId)
    const existingSummary = summaryRow?.summary || ''
    const summaryIsStale = rowsToSummarize.length > 0 &&
      (!summaryRow || summaryRow.summarizedThroughId < rowsToSummarize.at(-1).id)

    return {
      messages: keptRows
        .map(row => this._deserializeRow(row).message)
        .filter(message => this._isValidMessage(message)),
      summary: existingSummary,
      totalMessages: rows.length,
      needsSummary: summaryIsStale,
      rowsToSummarize: summaryIsStale
        ? rowsToSummarize.map(row => this._deserializeRow(row).message).filter(m => this._isValidMessage(m))
        : [],
      summarizeThroughId: summaryIsStale ? rowsToSummarize.at(-1).id : null,
    }
  }

  saveSummary(conversationId, summary, summarizedThroughId) {
    this._upsertSummary.run(conversationId, summary, summarizedThroughId, Date.now())
  }

  appendMessages(conversationId, messages) {
    this._insertMany(conversationId, messages)
  }

  startRun({ conversationId, provider, model, userMessage }) {
    const id = randomUUID()
    this._insertRun.run(id, conversationId, provider, model || null, 'running', userMessage, Date.now())
    return id
  }

  recordRunEvent(runId, type, data = {}) {
    this._insertRunEvent.run(runId, type, JSON.stringify(data), Date.now())
  }

  finishRun(runId, status, error = null) {
    this._updateRun.run(status, error, Date.now(), runId)
  }

  startToolCall(runId, { id, name, input }) {
    this._insertToolCall.run(runId, id || null, name, JSON.stringify(input || {}), Date.now())
  }

  finishToolCall(runId, { id, result = null, error = null }) {
    this._updateToolCall.run(result === null ? null : String(result), error, Date.now(), runId, id || null)
  }

  getRecentRuns(limit = 10) {
    return this._getRecentRuns.all(Math.max(1, Math.min(Number(limit) || 10, 50)))
  }

  getRunsWithToolCalls(conversationId) {
    const rows = this._getRunsWithTools.all(conversationId)
    const runMap = new Map()
    for (const row of rows) {
      if (!runMap.has(row.id)) runMap.set(row.id, { id: row.id, toolCalls: [] })
      if (row.tool_name) runMap.get(row.id).toolCalls.push({ name: row.tool_name })
    }
    return Array.from(runMap.values())
  }

  listConversations(limit = 50) {
    return this._listConversations.all(Math.max(1, Math.min(Number(limit) || 50, 200)))
  }

  forkConversation(sourceConversationId, targetConversationId) {
    this._forkConversationTx(sourceConversationId, targetConversationId)
  }

  deleteConversation(id) {
    const runIds = this._db.prepare(
      'SELECT id FROM agent_runs WHERE conversation_id = ?'
    ).all(id).map(r => r.id)

    this._db.transaction(() => {
      if (runIds.length) {
        const ph = runIds.map(() => '?').join(',')
        this._db.prepare(`DELETE FROM agent_run_events WHERE run_id IN (${ph})`).run(...runIds)
        this._db.prepare(`DELETE FROM agent_tool_calls WHERE run_id IN (${ph})`).run(...runIds)
      }
      this._db.prepare('DELETE FROM agent_runs WHERE conversation_id = ?').run(id)
      this._db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id)
      this._db.prepare('DELETE FROM agent_conversation_summaries WHERE conversation_id = ?').run(id)
    })()
  }

  _summarizeMessages(rows) {
    const lines = []
    for (const row of rows) {
      const { message } = this._deserializeRow(row)
      const text = this._messageText(message).replace(/\s+/g, ' ').trim()
      if (!text) continue
      lines.push(`${message.role}: ${text.slice(0, 280)}`)
    }

    const content = lines.slice(-24).join('\n')
    return content.length > 6000
      ? content.slice(content.length - 6000)
      : content
  }

  _messageText(message) {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content.map(part => part.text || part.content || JSON.stringify(part)).join(' ')
    }
    return JSON.stringify(message.content || '')
  }
}
