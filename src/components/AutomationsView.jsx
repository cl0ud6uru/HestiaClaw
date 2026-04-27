import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import './AutomationsView.css'

// ── Schedule builder helpers ─────────────────────────────────────────────────

const HOURS   = ['12','1','2','3','4','5','6','7','8','9','10','11']
const MINUTES = ['00','05','10','15','20','25','30','35','40','45','50','55']
const DOW     = [
  { label: 'Sun', val: 0 }, { label: 'Mon', val: 1 }, { label: 'Tue', val: 2 },
  { label: 'Wed', val: 3 }, { label: 'Thu', val: 4 }, { label: 'Fri', val: 5 },
  { label: 'Sat', val: 6 },
]
const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney',
]

function parseCron(expr) {
  const def = { freq: 'daily', hour: 8, minute: 0, ampm: 'am', days: [], interval: 1, raw: expr || '' }
  if (!expr) return def
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return { ...def, freq: 'custom', raw: expr }
  const [min, hr, , , dow] = parts
  if (hr === '*') return { ...def, freq: 'hourly', interval: 1 }
  const ivMatch = hr.match(/^\*\/(\d+)$/)
  if (ivMatch) return { ...def, freq: 'hourly', interval: parseInt(ivMatch[1]) }
  const h24 = parseInt(hr), m = parseInt(min) || 0
  const ampm = h24 >= 12 ? 'pm' : 'am'
  const hour12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24
  if (dow === '*') return { ...def, freq: 'daily', hour: hour12, minute: m, ampm }
  let days = []
  if (dow === '1-5') days = [1,2,3,4,5]
  else if (dow === '0,6' || dow === '6,0') days = [0,6]
  else days = dow.split(',').map(Number).filter(n => !isNaN(n))
  return { ...def, freq: 'weekly', hour: hour12, minute: m, ampm, days }
}

function buildCron({ freq, hour, minute, ampm, days, interval }) {
  const m = String(minute).padStart(2, '0')
  const h24 = ampm === 'am' ? (hour === 12 ? 0 : hour) : (hour < 12 ? hour + 12 : 12)
  if (freq === 'hourly') return interval === 1 ? '0 * * * *' : `0 */${interval} * * *`
  if (freq === 'daily')  return `${m} ${h24} * * *`
  if (freq === 'weekly') {
    if (days.length === 0) return `${m} ${h24} * * *`
    return `${m} ${h24} * * ${[...days].sort((a, b) => a - b).join(',')}`
  }
  return null
}

function cronToHuman({ freq, hour, minute, ampm, days, interval }) {
  if (freq === 'hourly') return interval === 1 ? 'Every hour' : `Every ${interval} hours`
  const timeStr = `${hour}:${String(minute).padStart(2, '0')} ${ampm.toUpperCase()}`
  if (freq === 'daily') return `Every day at ${timeStr}`
  if (freq === 'weekly') {
    const sorted = [...days].sort((a, b) => a - b)
    if (sorted.length === 0 || sorted.length === 7) return `Every day at ${timeStr}`
    if (JSON.stringify(sorted) === JSON.stringify([1,2,3,4,5])) return `Weekdays at ${timeStr}`
    if (JSON.stringify(sorted) === JSON.stringify([0,6])) return `Weekends at ${timeStr}`
    return `${sorted.map(d => DOW[d]?.label).join(', ')} at ${timeStr}`
  }
  return ''
}

function CronBuilder({ value, timezone, onChange, onTimezoneChange }) {
  const [s, set] = useState(() => parseCron(value))

  const update = useCallback((patch) => {
    set(prev => {
      const next = { ...prev, ...patch }
      if (next.freq !== 'custom') {
        const expr = buildCron(next)
        if (expr) onChange(expr)
      }
      return next
    })
  }, [onChange])

  const human = s.freq !== 'custom' ? cronToHuman(s) : ''

  return (
    <div className="auto-trigger-fields">
      <div className="auto-field">
        <label className="auto-label">FREQUENCY</label>
        <div className="auto-freq-tabs">
          {['hourly','daily','weekly','custom'].map(f => (
            <button
              key={f}
              className={`auto-freq-tab ${s.freq === f ? 'auto-freq-tab--active' : ''}`}
              onClick={() => update({ freq: f })}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {s.freq === 'hourly' && (
        <div className="auto-field">
          <label className="auto-label">REPEAT EVERY</label>
          <div className="auto-pill-row">
            {[1,2,4,6,12].map(n => (
              <button
                key={n}
                className={`auto-pill ${s.interval === n ? 'auto-pill--active' : ''}`}
                onClick={() => update({ interval: n })}
              >
                {n === 1 ? '1 hr' : `${n} hrs`}
              </button>
            ))}
          </div>
        </div>
      )}

      {s.freq === 'weekly' && (
        <div className="auto-field">
          <label className="auto-label">DAYS</label>
          <div className="auto-pill-row">
            {DOW.map(d => (
              <button
                key={d.val}
                className={`auto-pill ${s.days.includes(d.val) ? 'auto-pill--active' : ''}`}
                onClick={() => update({
                  days: s.days.includes(d.val)
                    ? s.days.filter(x => x !== d.val)
                    : [...s.days, d.val],
                })}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {(s.freq === 'daily' || s.freq === 'weekly') && (
        <div className="auto-field">
          <label className="auto-label">TIME</label>
          <div className="auto-time-picker">
            <select
              className="auto-time-sel"
              value={String(s.hour)}
              onChange={e => update({ hour: parseInt(e.target.value) })}
            >
              {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            <span className="auto-time-colon">:</span>
            <select
              className="auto-time-sel"
              value={String(s.minute).padStart(2, '0')}
              onChange={e => update({ minute: parseInt(e.target.value) })}
            >
              {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="auto-ampm-group">
              <button
                className={`auto-ampm-btn ${s.ampm === 'am' ? 'auto-ampm-btn--active' : ''}`}
                onClick={() => update({ ampm: 'am' })}
              >AM</button>
              <button
                className={`auto-ampm-btn ${s.ampm === 'pm' ? 'auto-ampm-btn--active' : ''}`}
                onClick={() => update({ ampm: 'pm' })}
              >PM</button>
            </div>
          </div>
        </div>
      )}

      {s.freq === 'custom' && (
        <div className="auto-field">
          <label className="auto-label">CRON EXPRESSION</label>
          <input
            className="auto-input auto-monospace"
            value={s.raw}
            onChange={e => { set(p => ({ ...p, raw: e.target.value })); onChange(e.target.value) }}
            placeholder="0 8 * * *"
          />
          <div className="auto-cron-hint">min · hour · day · month · weekday</div>
        </div>
      )}

      {human && <div className="auto-cron-preview">↻ {human}</div>}

      <div className="auto-field" style={{ marginTop: 10 }}>
        <label className="auto-label">TIMEZONE</label>
        <select
          className="auto-select"
          value={timezone}
          onChange={e => onTimezoneChange(e.target.value)}
        >
          {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
        </select>
      </div>
    </div>
  )
}

// ── List helpers ─────────────────────────────────────────────────────────────

function triggerSummary(auto) {
  if (auto.trigger_type === 'cron') {
    const s = parseCron(auto.cron_expr)
    return cronToHuman(s) || auto.cron_expr
  }
  if (auto.trigger_type === 'one_off') {
    if (!auto.run_at) return 'One-off'
    return 'Once: ' + new Date(auto.run_at).toLocaleString()
  }
  if (auto.trigger_type === 'ha_event') return `HA: ${auto.ha_entity_id || 'entity'}`
  return 'Webhook'
}

function statusColor(auto) {
  if (!auto.enabled) return '#444'
  if (auto.last_run_status === 'failed' || auto.last_run_status === 'timeout') return '#ff3366'
  if (auto.last_run_status === 'success') return '#00ffaa'
  return '#00d4ff'
}

function formatDuration(run) {
  if (!run.finished_at) return '—'
  const ms = run.finished_at - run.started_at
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Draft helpers ─────────────────────────────────────────────────────────────

function blankDraft() {
  return {
    name: '', description: '', prompt: '',
    trigger_type: 'cron',
    cron_expr: '0 8 * * *',
    timezone: 'UTC',
    run_at: '',
    webhook_secret: '',
    ha_entity_id: '',
    ha_condition: '',
    timeout_seconds: 120,
  }
}

function automationToDraft(auto) {
  return {
    name: auto.name || '',
    description: auto.description || '',
    prompt: auto.prompt || '',
    trigger_type: auto.trigger_type || 'cron',
    cron_expr: auto.cron_expr || '0 8 * * *',
    timezone: auto.timezone || 'UTC',
    run_at: auto.run_at ? new Date(auto.run_at).toISOString().slice(0, 16) : '',
    webhook_secret: auto.webhook_secret || '',
    ha_entity_id: auto.ha_entity_id || '',
    ha_condition: auto.ha_condition || '',
    timeout_seconds: auto.timeout_seconds || 120,
  }
}

function getWebhookUrl(auto) {
  return `${window.location.origin}/api/automations/trigger/${auto.id}?secret=${auto.webhook_secret || ''}`
}

// ── Reducer ───────────────────────────────────────────────────────────────────

const initialState = {
  automations: [],
  selectedId: null,
  editorActive: false,
  draft: blankDraft(),
  runs: [],
  loading: true,
  runningIds: new Set(),
  error: null,
  saved: false,
  expandedRunId: null,
}

function reducer(state, action) {
  switch (action.type) {
    case 'LOAD_START': return { ...state, loading: true, error: null }
    case 'LOAD_DONE':  return { ...state, loading: false, automations: action.automations }
    case 'LOAD_ERROR': return { ...state, loading: false, error: action.error }
    case 'SELECT': return {
      ...state,
      selectedId: action.id,
      editorActive: true,
      draft: automationToDraft(action.automation),
      runs: [],
      saved: false,
      expandedRunId: null,
    }
    case 'NEW': return {
      ...state,
      selectedId: null,
      editorActive: true,
      draft: blankDraft(),
      runs: [],
      saved: false,
      expandedRunId: null,
    }
    case 'DRAFT': return { ...state, draft: { ...state.draft, ...action.patch }, saved: false }
    case 'RUNS_LOADED': return { ...state, runs: action.runs }
    case 'RUN_START': return { ...state, runningIds: new Set([...state.runningIds, action.id]) }
    case 'RUN_END': {
      const s = new Set(state.runningIds); s.delete(action.id)
      return { ...state, runningIds: s }
    }
    case 'SAVED': return {
      ...state,
      saved: true,
      selectedId: action.id,
      draft: automationToDraft(action.automation),
      automations: state.selectedId
        ? state.automations.map(a => a.id === action.id ? action.automation : a)
        : [action.automation, ...state.automations],
    }
    case 'DELETED': return {
      ...state,
      automations: state.automations.filter(a => a.id !== action.id),
      selectedId: null,
      editorActive: false,
      draft: blankDraft(),
      runs: [],
    }
    case 'TOGGLED': return {
      ...state,
      automations: state.automations.map(a =>
        a.id === action.id ? { ...a, enabled: action.enabled ? 1 : 0 } : a
      ),
    }
    case 'EXPAND_RUN': return {
      ...state,
      expandedRunId: state.expandedRunId === action.id ? null : action.id,
    }
    default: return state
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AutomationsView({ onClose }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const pollRef = useRef(null)

  const loadAutomations = useCallback(async () => {
    dispatch({ type: 'LOAD_START' })
    try {
      const res = await fetch('/api/automations')
      if (!res.ok) throw new Error(await res.text())
      dispatch({ type: 'LOAD_DONE', automations: await res.json() })
    } catch (err) {
      dispatch({ type: 'LOAD_ERROR', error: err.message })
    }
  }, [])

  const loadRuns = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/automations/${id}/runs`)
      if (!res.ok) return
      dispatch({ type: 'RUNS_LOADED', runs: await res.json() })
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadAutomations() }, [loadAutomations])

  useEffect(() => {
    if (state.runningIds.size > 0 && state.selectedId) {
      pollRef.current = setInterval(() => loadRuns(state.selectedId), 3000)
    } else {
      clearInterval(pollRef.current)
    }
    return () => clearInterval(pollRef.current)
  }, [state.runningIds, state.selectedId, loadRuns])

  const handleSelect = useCallback(async (auto) => {
    dispatch({ type: 'SELECT', id: auto.id, automation: auto })
    await loadRuns(auto.id)
  }, [loadRuns])

  const handleNew = () => dispatch({ type: 'NEW' })
  const handleDraft = (patch) => dispatch({ type: 'DRAFT', patch })

  const handleSave = async () => {
    const { draft, selectedId } = state
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      trigger_type: draft.trigger_type,
      cron_expr: draft.trigger_type === 'cron' ? draft.cron_expr : null,
      timezone: draft.timezone,
      run_at: (draft.trigger_type === 'one_off' && draft.run_at) ? new Date(draft.run_at).getTime() : null,
      webhook_secret: draft.webhook_secret || undefined,
      ha_entity_id: draft.ha_entity_id || null,
      ha_condition: draft.ha_condition || null,
      timeout_seconds: parseInt(draft.timeout_seconds, 10) || 120,
    }
    try {
      const res = await fetch(
        selectedId ? `/api/automations/${selectedId}` : '/api/automations',
        { method: selectedId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      )
      if (!res.ok) throw new Error(await res.text())
      const automation = await res.json()
      dispatch({ type: 'SAVED', id: automation.id, automation })
    } catch (err) {
      dispatch({ type: 'LOAD_ERROR', error: err.message })
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this automation?')) return
    try {
      const res = await fetch(`/api/automations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      dispatch({ type: 'DELETED', id })
    } catch (err) {
      dispatch({ type: 'LOAD_ERROR', error: err.message })
    }
  }

  const handleToggle = async (id) => {
    try {
      const res = await fetch(`/api/automations/${id}/toggle`, { method: 'PATCH' })
      if (!res.ok) throw new Error(await res.text())
      const { enabled } = await res.json()
      dispatch({ type: 'TOGGLED', id, enabled })
    } catch (err) {
      dispatch({ type: 'LOAD_ERROR', error: err.message })
    }
  }

  const handleRunNow = async (id) => {
    dispatch({ type: 'RUN_START', id })
    try {
      await fetch(`/api/automations/${id}/run`, { method: 'POST' })
      setTimeout(() => loadRuns(id), 1000)
    } catch (err) {
      dispatch({ type: 'LOAD_ERROR', error: err.message })
    } finally {
      setTimeout(() => dispatch({ type: 'RUN_END', id }), 5000)
    }
  }

  const copyToClipboard = (text) => navigator.clipboard?.writeText(text).catch(() => {})

  const { automations, selectedId, editorActive, draft, runs, loading, runningIds, error, saved, expandedRunId } = state
  const selectedAuto = automations.find(a => a.id === selectedId)

  return (
    <div className="auto-overlay" role="dialog" aria-modal="true">
      <div className="auto-panel">
        <span className="auto-corner tl" /><span className="auto-corner tr" />
        <span className="auto-corner bl" /><span className="auto-corner br" />

        <div className="auto-header">
          <div className="auto-header-title">
            <span className="auto-pulse-dot" />
            <span className="auto-title-text">AUTOMATIONS</span>
          </div>
          <button className="auto-close-btn" onClick={onClose}>✕ CLOSE</button>
        </div>

        {error && <div className="auto-error-bar">{error}</div>}

        <div className="auto-body">
          {/* LEFT: list */}
          <div className="auto-list-pane">
            <button className="auto-new-btn" onClick={handleNew}>+ NEW AUTOMATION</button>
            {loading && <div className="auto-list-empty">Loading...</div>}
            {!loading && automations.length === 0 && (
              <div className="auto-list-empty">No automations yet.<br />Create one to get started.</div>
            )}
            {automations.map(auto => (
              <div
                key={auto.id}
                className={`auto-list-item ${selectedId === auto.id ? 'auto-list-item--selected' : ''}`}
                onClick={() => handleSelect(auto)}
              >
                <span
                  className="auto-status-dot"
                  style={{ background: runningIds.has(auto.id) ? '#00d4ff' : statusColor(auto) }}
                />
                <div className="auto-list-info">
                  <div className="auto-list-name">{auto.name}</div>
                  <div className="auto-list-meta">{triggerSummary(auto)}</div>
                </div>
                {runningIds.has(auto.id) && <span className="auto-spinner" />}
              </div>
            ))}
          </div>

          {/* RIGHT: editor + history */}
          <div className="auto-detail-pane">
            {!editorActive ? (
              <div className="auto-empty-state">
                <div className="auto-empty-icon">◈</div>
                <div className="auto-empty-title">SCHEDULED TASKS</div>
                <div className="auto-empty-sub">
                  Create automations that run on a schedule, trigger from Home Assistant events,
                  or fire via webhook. Select an automation to edit, or create a new one.
                </div>
              </div>
            ) : (
              <>
                <div className="auto-editor">
                  <div className="auto-field">
                    <label className="auto-label">NAME</label>
                    <input
                      className="auto-input"
                      value={draft.name}
                      onChange={e => handleDraft({ name: e.target.value })}
                      placeholder="Morning briefing"
                    />
                  </div>

                  <div className="auto-field">
                    <label className="auto-label">DESCRIPTION</label>
                    <input
                      className="auto-input"
                      value={draft.description}
                      onChange={e => handleDraft({ description: e.target.value })}
                      placeholder="Optional notes"
                    />
                  </div>

                  <div className="auto-field">
                    <label className="auto-label">PROMPT</label>
                    <textarea
                      className="auto-textarea"
                      value={draft.prompt}
                      onChange={e => handleDraft({ prompt: e.target.value })}
                      placeholder="Describe what the agent should do. Be specific about the expected output."
                      rows={4}
                    />
                  </div>

                  <div className="auto-field">
                    <label className="auto-label">TRIGGER TYPE</label>
                    <div className="auto-trigger-tabs">
                      {[
                        { value: 'cron',     label: 'SCHEDULE' },
                        { value: 'one_off',  label: 'ONE-OFF' },
                        { value: 'webhook',  label: 'WEBHOOK' },
                        { value: 'ha_event', label: 'HA EVENT' },
                      ].map(t => (
                        <button
                          key={t.value}
                          className={`auto-trigger-tab ${draft.trigger_type === t.value ? 'auto-trigger-tab--active' : ''}`}
                          onClick={() => handleDraft({ trigger_type: t.value })}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {draft.trigger_type === 'cron' && (
                    <CronBuilder
                      key={selectedId || '__new__'}
                      value={draft.cron_expr}
                      timezone={draft.timezone}
                      onChange={cron_expr => handleDraft({ cron_expr })}
                      onTimezoneChange={timezone => handleDraft({ timezone })}
                    />
                  )}

                  {draft.trigger_type === 'one_off' && (
                    <div className="auto-trigger-fields">
                      <div className="auto-field">
                        <label className="auto-label">RUN AT</label>
                        <input
                          className="auto-input"
                          type="datetime-local"
                          value={draft.run_at}
                          onChange={e => handleDraft({ run_at: e.target.value })}
                        />
                      </div>
                      <div className="auto-field">
                        <label className="auto-label">TIMEZONE</label>
                        <select
                          className="auto-select"
                          value={draft.timezone}
                          onChange={e => handleDraft({ timezone: e.target.value })}
                        >
                          {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                        </select>
                      </div>
                    </div>
                  )}

                  {(draft.trigger_type === 'webhook' || draft.trigger_type === 'ha_event') && (
                    <div className="auto-trigger-fields">
                      {draft.trigger_type === 'ha_event' && (
                        <>
                          <div className="auto-field">
                            <label className="auto-label">HA ENTITY ID</label>
                            <input
                              className="auto-input auto-monospace"
                              value={draft.ha_entity_id}
                              onChange={e => handleDraft({ ha_entity_id: e.target.value })}
                              placeholder="binary_sensor.front_door"
                            />
                          </div>
                          <div className="auto-field">
                            <label className="auto-label">CONDITION (optional)</label>
                            <input
                              className="auto-input auto-monospace"
                              value={draft.ha_condition}
                              onChange={e => handleDraft({ ha_condition: e.target.value })}
                              placeholder="new_state == 'on'"
                            />
                          </div>
                        </>
                      )}
                      <div className="auto-field">
                        <label className="auto-label">WEBHOOK SECRET</label>
                        <input
                          className="auto-input auto-monospace"
                          value={draft.webhook_secret}
                          onChange={e => handleDraft({ webhook_secret: e.target.value })}
                          placeholder="Auto-generated on save"
                        />
                      </div>
                      {selectedAuto && (
                        <div className="auto-webhook-url-block">
                          <label className="auto-label">TRIGGER URL</label>
                          <div className="auto-webhook-url-row">
                            <code className="auto-webhook-url">{getWebhookUrl(selectedAuto)}</code>
                            <button
                              className="auto-copy-btn"
                              onClick={() => copyToClipboard(getWebhookUrl(selectedAuto))}
                            >COPY</button>
                          </div>
                          {draft.trigger_type === 'ha_event' && (
                            <div className="auto-ha-instructions">
                              In Home Assistant: create an automation with a <strong>State Changed</strong> trigger
                              {draft.ha_entity_id && ` on ${draft.ha_entity_id}`}, then add a
                              <strong> Webhook</strong> action that POSTs to the URL above.
                              Optional body: <code>{`{"context": "..."}`}</code>
                            </div>
                          )}
                        </div>
                      )}
                      {!selectedAuto && (
                        <div className="auto-ha-instructions">Save this automation first to generate the trigger URL.</div>
                      )}
                    </div>
                  )}

                  <div className="auto-field auto-field--narrow" style={{ marginTop: 14 }}>
                    <label className="auto-label">TIMEOUT (seconds)</label>
                    <input
                      className="auto-input"
                      type="number"
                      min="10"
                      max="3600"
                      value={draft.timeout_seconds}
                      onChange={e => handleDraft({ timeout_seconds: e.target.value })}
                    />
                  </div>

                  <div className="auto-actions">
                    {selectedId && (
                      <button
                        className={`auto-btn auto-btn--run ${runningIds.has(selectedId) ? 'auto-btn--busy' : ''}`}
                        onClick={() => handleRunNow(selectedId)}
                        disabled={runningIds.has(selectedId)}
                      >
                        {runningIds.has(selectedId) ? '⟳ RUNNING' : '▶ RUN NOW'}
                      </button>
                    )}
                    {selectedId && (
                      <button className="auto-btn auto-btn--toggle" onClick={() => handleToggle(selectedId)}>
                        {selectedAuto?.enabled ? '◉ DISABLE' : '◎ ENABLE'}
                      </button>
                    )}
                    <button
                      className={`auto-btn auto-btn--save ${saved ? 'auto-btn--saved' : ''}`}
                      onClick={handleSave}
                      disabled={!draft.name || !draft.prompt}
                    >
                      {saved ? '✓ SAVED' : 'SAVE'}
                    </button>
                    {selectedId && (
                      <button className="auto-btn auto-btn--delete" onClick={() => handleDelete(selectedId)}>
                        ✕ DELETE
                      </button>
                    )}
                  </div>
                </div>

                {selectedId && (
                  <div className="auto-history">
                    <div className="auto-history-title">RUN HISTORY</div>
                    {runs.length === 0 ? (
                      <div className="auto-history-empty">No runs yet.</div>
                    ) : (
                      <div className="auto-history-table">
                        <div className="auto-history-header">
                          <span>TIME</span><span>DURATION</span><span>STATUS</span><span>TOOLS</span>
                        </div>
                        {runs.map(run => (
                          <div key={run.id}>
                            <div
                              className={`auto-history-row ${expandedRunId === run.id ? 'auto-history-row--expanded' : ''}`}
                              onClick={() => dispatch({ type: 'EXPAND_RUN', id: run.id })}
                            >
                              <span className="auto-run-time">{new Date(run.started_at).toLocaleString()}</span>
                              <span className="auto-run-dur">{formatDuration(run)}</span>
                              <span className={`auto-run-status auto-run-status--${run.status}`}>
                                {run.status === 'success' ? '✓' : run.status === 'running' ? '⟳' : '✗'}{' '}{run.status}
                              </span>
                              <span className="auto-run-tools">
                                {(() => {
                                  try {
                                    return JSON.parse(run.tools_used || '[]').map(t => (
                                      <span key={t} className="auto-tool-badge">{t.replace('__', ': ')}</span>
                                    ))
                                  } catch { return null }
                                })()}
                              </span>
                            </div>
                            {expandedRunId === run.id && (
                              <div className="auto-run-output">
                                {run.error && <div className="auto-run-error">{run.error}</div>}
                                {run.output && <pre className="auto-run-text">{run.output}</pre>}
                                {!run.output && !run.error && <div className="auto-run-empty">(no output)</div>}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
