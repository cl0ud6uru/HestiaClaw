import { useEffect, useState } from 'react'
import './UsageDashboard.css'

function fmt(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat().format(value)
}

function fmtCost(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return `$${value.toFixed(4)}`
}

function fmtTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function stripServer(name) {
  return name.replace('__', ': ')
}

function BarChart({ data }) {
  if (!data || data.length === 0) return <div className="ud-empty">No activity data</div>

  const today = Math.floor(Date.now() / 86400000)
  const days  = Array.from({ length: 7 }, (_, i) => today - 6 + i)
  const byDay = new Map(data.map(d => [d.day, d.count]))
  const max   = Math.max(1, ...days.map(d => byDay.get(d) || 0))

  const todayDow = new Date().getDay()
  const labels   = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

  return (
    <div className="ud-bars">
      {days.map((day, i) => {
        const count  = byDay.get(day) || 0
        const height = Math.max(4, Math.round((count / max) * 100))
        const dow    = (todayDow - 6 + i + 7) % 7
        return (
          <div key={day} className="ud-bar-col">
            <div className="ud-bar-track">
              <div
                className={`ud-bar-fill${count > 0 ? ' ud-bar-fill--active' : ''}`}
                style={{ height: `${height}%` }}
                title={`${count} run${count !== 1 ? 's' : ''}`}
              />
            </div>
            <span className="ud-bar-label">{labels[dow]}</span>
          </div>
        )
      })}
    </div>
  )
}

async function fetchUsage() {
  const res  = await fetch('/api/usage/summary')
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error || 'Failed to load usage data.')
  return body
}

export default function UsageDashboard({ onClose }) {
  const [data, setData]          = useState(null)
  const [loading, setLoading]    = useState(true)
  const [error, setError]        = useState('')
  const [refreshKey, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(async () => {
      setLoading(true)
      setError('')
      try {
        const result = await fetchUsage()
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load usage data.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [refreshKey])

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const { statusBreakdown = {}, topTools = [], dailyActivity = [], provider = {}, openai = {} } = data || {}
  const completed  = statusBreakdown.completed || 0
  const errored    = statusBreakdown.error || 0
  const totalDone  = completed + errored
  const successPct = totalDone > 0 ? Math.round((completed / totalDone) * 100) : null
  const topCount   = topTools[0]?.count || 1

  return (
    <div
      className="ud-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Usage dashboard"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="ud-panel">
        <span className="bubble-corner tl" aria-hidden />
        <span className="bubble-corner tr" aria-hidden />
        <span className="bubble-corner bl" aria-hidden />
        <span className="bubble-corner br" aria-hidden />

        <div className="ud-header">
          <span className="ud-title">USAGE DASHBOARD</span>
          {data && !loading && <span className="ud-subtitle">7-DAY WINDOW</span>}
          <button className="ud-icon-btn" onClick={() => setRefresh(k => k + 1)} title="Refresh" aria-label="Refresh">↺</button>
          <button className="ud-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="ud-body">
          {loading && <div className="ud-status ud-loading">LOADING TELEMETRY...</div>}
          {error   && <div className="ud-status ud-error">{error}</div>}

          {!loading && !error && data && (
            <>
              <div className="ud-stats-grid">
                <div className="ud-card">
                  <span className="ud-card-label">RUNS</span>
                  <span className="ud-card-value ud-cyan">{fmt(data.runs7d)}</span>
                  <span className="ud-card-sub">last 7 days</span>
                </div>
                <div className="ud-card">
                  <span className="ud-card-label">TOOL CALLS</span>
                  <span className="ud-card-value ud-cyan">{fmt(data.toolCalls7d)}</span>
                  <span className="ud-card-sub">last 7 days</span>
                </div>
                <div className="ud-card">
                  <span className="ud-card-label">CONVERSATIONS</span>
                  <span className="ud-card-value ud-green">{fmt(data.conversationCount)}</span>
                  <span className="ud-card-sub">all time</span>
                </div>
                <div className="ud-card">
                  <span className="ud-card-label">SUCCESS RATE</span>
                  <span className={`ud-card-value ${successPct === null ? 'ud-muted' : successPct >= 90 ? 'ud-green' : successPct >= 70 ? 'ud-yellow' : 'ud-red'}`}>
                    {successPct !== null ? `${successPct}%` : '—'}
                  </span>
                  <span className="ud-card-sub">{totalDone > 0 ? `${completed} ok · ${errored} err` : 'no runs'}</span>
                </div>
              </div>

              <div className="ud-section">
                <div className="ud-section-title">ACTIVITY — LAST 7 DAYS</div>
                <BarChart data={dailyActivity} />
              </div>

              <div className="ud-bottom">
                <div className="ud-tools-col">
                  <div className="ud-section-title">TOP TOOLS (7D)</div>
                  {topTools.length === 0
                    ? <div className="ud-empty">No tool calls recorded</div>
                    : topTools.map(t => (
                      <div key={t.name} className="ud-tool-row">
                        <span className="ud-tool-name" title={t.name}>{stripServer(t.name)}</span>
                        <div className="ud-tool-bar-track">
                          <div className="ud-tool-bar" style={{ width: `${Math.round((t.count / topCount) * 100)}%` }} />
                        </div>
                        <span className="ud-tool-count">{t.count}</span>
                      </div>
                    ))
                  }
                </div>

                <div className="ud-billing-col">
                  <div className="ud-section-title">PROVIDER</div>
                  <div className="ud-billing-row">
                    <span className="ud-billing-key">TYPE</span>
                    <span className="ud-billing-val">{provider.type || '—'}</span>
                  </div>
                  <div className="ud-billing-row">
                    <span className="ud-billing-key">MODEL</span>
                    <span className="ud-billing-val ud-model">{provider.model || '—'}</span>
                  </div>
                  <div className="ud-billing-row">
                    <span className="ud-billing-key">LAST RUN</span>
                    <span className="ud-billing-val">{fmtTime(data.lastRunAt)}</span>
                  </div>

                  <div className="ud-section-title ud-billing-heading">COST — 30 DAYS</div>
                  {openai.available
                    ? <div className="ud-cost-value">{fmtCost(openai.costUsd30d)}</div>
                    : <div className="ud-empty">{openai.note || 'Billing unavailable'}</div>
                  }
                  {openai.available && (
                    <div className="ud-billing-note">{openai.note}</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
