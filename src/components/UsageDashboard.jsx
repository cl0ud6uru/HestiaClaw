import { useEffect, useState } from 'react'
import './UsageDashboard.css'

function money(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return `$${value.toFixed(4)}`
}

function number(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  return new Intl.NumberFormat().format(value)
}

function time(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export default function UsageDashboard({ onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/usage/summary')
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error || 'Failed to load usage dashboard.')
      setData(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage dashboard.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetch('/api/usage/summary')
      .then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error || 'Failed to load usage dashboard.')
        setData(body)
        setError('')
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load usage dashboard.')
      })
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="usage-overlay" role="dialog" aria-modal="true" aria-label="Usage dashboard">
      <div className="usage-panel">
        <div className="usage-header">
          <h2>Usage & Cost Dashboard</h2>
          <div className="usage-actions">
            <button type="button" className="usage-btn" onClick={() => void load()}>Refresh</button>
            <button type="button" className="usage-btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {loading && <p className="usage-muted">Loading dashboard…</p>}
        {error && <p className="usage-error">{error}</p>}

        {!loading && !error && data && (
          <>
            <div className="usage-grid">
              <div className="usage-card"><span>Runs (7d)</span><strong>{number(data.runs7d)}</strong></div>
              <div className="usage-card"><span>Tool Calls (7d)</span><strong>{number(data.toolCalls7d)}</strong></div>
              <div className="usage-card"><span>Conversations</span><strong>{number(data.conversationCount)}</strong></div>
              <div className="usage-card"><span>Last Agent Run</span><strong>{time(data.lastRunAt)}</strong></div>
            </div>

            <div className="usage-provider">
              <h3>Provider Billing</h3>
              <p><strong>Active Provider:</strong> {data.provider?.type || 'unknown'}</p>
              <p><strong>Model:</strong> {data.provider?.model || 'default'}</p>
              <p><strong>30d OpenAI Cost:</strong> {money(data.openai?.costUsd30d)}</p>
              <p className="usage-muted">{data.openai?.note || 'No provider billing note.'}</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
