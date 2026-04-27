import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

let db = null

export function initDb(dbPath) {
  db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      trigger_type TEXT NOT NULL,
      cron_expr TEXT,
      timezone TEXT DEFAULT 'UTC',
      run_at INTEGER,
      webhook_secret TEXT,
      ha_entity_id TEXT,
      ha_condition TEXT,
      timeout_seconds INTEGER DEFAULT 120,
      last_run_at INTEGER,
      last_run_status TEXT,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT,
      error TEXT,
      tools_used TEXT DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_auto_runs ON automation_runs(automation_id, started_at DESC);
  `)
  console.log('[automations] DB initialized')
}

export function list() {
  return db.prepare(`
    SELECT a.*,
      r.status AS last_run_status_detail,
      r.started_at AS last_run_started_at,
      r.finished_at AS last_run_finished_at
    FROM automations a
    LEFT JOIN automation_runs r ON r.id = (
      SELECT id FROM automation_runs WHERE automation_id = a.id ORDER BY started_at DESC LIMIT 1
    )
    ORDER BY a.created_at DESC
  `).all()
}

export function get(id) {
  return db.prepare('SELECT * FROM automations WHERE id = ?').get(id) || null
}

export function create(data) {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO automations (id, name, description, prompt, enabled, trigger_type,
      cron_expr, timezone, run_at, webhook_secret, ha_entity_id, ha_condition,
      timeout_seconds, created_at, updated_at)
    VALUES (@id, @name, @description, @prompt, @enabled, @trigger_type,
      @cron_expr, @timezone, @run_at, @webhook_secret, @ha_entity_id, @ha_condition,
      @timeout_seconds, @created_at, @updated_at)
  `).run({
    id,
    name: data.name,
    description: data.description || '',
    prompt: data.prompt,
    enabled: data.enabled !== false ? 1 : 0,
    trigger_type: data.trigger_type,
    cron_expr: data.cron_expr || null,
    timezone: data.timezone || 'UTC',
    run_at: data.run_at || null,
    webhook_secret: data.webhook_secret || randomUUID().replace(/-/g, ''),
    ha_entity_id: data.ha_entity_id || null,
    ha_condition: data.ha_condition || null,
    timeout_seconds: data.timeout_seconds || 120,
    created_at: now,
    updated_at: now,
  })
  return id
}

export function update(id, data) {
  const now = Date.now()
  const fields = []
  const values = { id, updated_at: now }
  const allowed = ['name', 'description', 'prompt', 'enabled', 'trigger_type',
    'cron_expr', 'timezone', 'run_at', 'webhook_secret', 'ha_entity_id',
    'ha_condition', 'timeout_seconds', 'next_run_at']
  for (const k of allowed) {
    if (k in data) {
      fields.push(`${k} = @${k}`)
      values[k] = data[k]
    }
  }
  if (fields.length === 0) return
  db.prepare(`UPDATE automations SET ${fields.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(values)
}

export function remove(id) {
  db.prepare('DELETE FROM automations WHERE id = ?').run(id)
}

export function toggle(id, enabled) {
  db.prepare('UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id)
}

export function updateLastRun(id, status, nextRunAt = null) {
  db.prepare(`
    UPDATE automations SET last_run_at = ?, last_run_status = ?, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), status, nextRunAt, Date.now(), id)
}

export function startRun(automationId) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO automation_runs (id, automation_id, status, started_at)
    VALUES (?, ?, 'running', ?)
  `).run(id, automationId, Date.now())
  return id
}

export function finishRun(runId, { status, output, error, toolsUsed = [] }) {
  db.prepare(`
    UPDATE automation_runs SET status = ?, finished_at = ?, output = ?, error = ?, tools_used = ?
    WHERE id = ?
  `).run(status, Date.now(), output || null, error || null, JSON.stringify(toolsUsed), runId)
}

export function getRuns(automationId, limit = 20) {
  return db.prepare(`
    SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?
  `).all(automationId, limit)
}

export function getPendingOneOffs() {
  return db.prepare(`
    SELECT * FROM automations
    WHERE trigger_type = 'one_off' AND enabled = 1 AND run_at IS NOT NULL AND run_at <= ?
  `).all(Date.now())
}
