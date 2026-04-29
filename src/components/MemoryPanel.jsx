import { useEffect, useState } from 'react'
import './MemoryPanel.css'

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function lineDiff(prev, next) {
  const prevLines = new Set((prev || '').split('\n').map(l => l.trim()).filter(Boolean))
  const nextLines = (next || '').split('\n').map(l => l.trim()).filter(Boolean)
  const added = nextLines.filter(l => !prevLines.has(l)).length
  const nextSet = new Set(nextLines)
  const removed = [...prevLines].filter(l => !nextSet.has(l)).length
  return { added, removed }
}

function SourceBadge({ source }) {
  return <span className={`memory-source-badge memory-source-${source}`}>{source}</span>
}

function HistoryEntry({ entry, onRestore, restoring }) {
  const [expanded, setExpanded] = useState(false)
  const { added, removed } = lineDiff(entry.previousContent, entry.newContent)

  return (
    <div className="memory-history-entry">
      <div className="memory-history-row" onClick={() => setExpanded(e => !e)}>
        <span className="memory-history-chevron">{expanded ? '▾' : '▸'}</span>
        <SourceBadge source={entry.source} />
        <span className="memory-history-time" title={new Date(entry.changedAt).toLocaleString()}>
          {timeAgo(entry.changedAt)}
        </span>
        {added > 0 && <span className="memory-diff-added">+{added}</span>}
        {removed > 0 && <span className="memory-diff-removed">−{removed}</span>}
        {entry.episodesDeleted?.length > 0 && (
          <span className="memory-diff-episodes">{entry.episodesDeleted.length} ep. deleted</span>
        )}
        <button
          className="memory-restore-btn"
          onClick={e => { e.stopPropagation(); onRestore(entry.id) }}
          disabled={restoring}
          title="Restore MEMORY.md to its state before this change"
        >
          {restoring ? 'restoring…' : 'RESTORE'}
        </button>
      </div>
      {expanded && (
        <div className="memory-history-diff">
          <div className="memory-diff-pane">
            <div className="memory-diff-label memory-diff-label-before">BEFORE</div>
            <pre className="memory-diff-content">{entry.previousContent || '(empty)'}</pre>
          </div>
          <div className="memory-diff-pane">
            <div className="memory-diff-label memory-diff-label-after">AFTER</div>
            <pre className="memory-diff-content">{entry.newContent || '(empty)'}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

export default function MemoryPanel({ onClose }) {
  const [tab, setTab] = useState('current')
  const [current, setCurrent] = useState('')
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [restoringId, setRestoringId] = useState(null)
  const [restoreMsg, setRestoreMsg] = useState('')
  const [loadTick, setLoadTick] = useState(0)

  const loadMemory = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/agent/memory')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setCurrent(json.current || '')
      setHistory(json.history || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void Promise.resolve().then(loadMemory)
  }, [loadTick])

  function fetchMemory() { setLoadTick(t => t + 1) }

  async function handleSave() {
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/agent/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setCurrent(draft)
      setEditing(false)
      setSaveMsg('Saved.')
      fetchMemory()
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  async function handleRestore(id) {
    setRestoringId(id)
    setRestoreMsg('')
    try {
      const res = await fetch(`/api/agent/memory/restore/${id}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRestoreMsg('Restored.')
      fetchMemory()
      setTab('current')
    } catch (err) {
      setRestoreMsg(`Error: ${err.message}`)
    } finally {
      setRestoringId(null)
      setTimeout(() => setRestoreMsg(''), 4000)
    }
  }

  return (
    <div className="memory-panel" role="dialog" aria-label="Memory Panel">
      <span className="bubble-corner tl" />
      <span className="bubble-corner tr" />
      <span className="bubble-corner bl" />
      <span className="bubble-corner br" />

      <div className="memory-panel-header">
        <span className="memory-panel-title">MEMORY</span>
        <div className="memory-panel-tabs">
          <button
            className={`memory-tab-btn${tab === 'current' ? ' active' : ''}`}
            onClick={() => setTab('current')}
          >CURRENT</button>
          <button
            className={`memory-tab-btn${tab === 'history' ? ' active' : ''}`}
            onClick={() => setTab('history')}
          >
            HISTORY
            {history.length > 0 && <span className="memory-history-count">{history.length}</span>}
          </button>
        </div>
        <button className="memory-close-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {loading && <div className="memory-loading">Loading…</div>}
      {error && <div className="memory-error">Error: {error}</div>}

      {!loading && !error && tab === 'current' && (
        <div className="memory-tab-content">
          {editing ? (
            <>
              <textarea
                className="memory-edit-textarea"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                spellCheck={false}
              />
              <div className="memory-edit-actions">
                <button className="memory-btn memory-btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'SAVE'}
                </button>
                <button className="memory-btn" onClick={() => setEditing(false)}>CANCEL</button>
                {saveMsg && <span className="memory-save-msg">{saveMsg}</span>}
              </div>
            </>
          ) : (
            <>
              <pre className="memory-current-content">{current || '(No pinned memory yet.)'}</pre>
              <div className="memory-edit-actions">
                <button className="memory-btn memory-btn-primary" onClick={() => { setDraft(current); setEditing(true) }}>
                  EDIT
                </button>
                {saveMsg && <span className="memory-save-msg">{saveMsg}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {!loading && !error && tab === 'history' && (
        <div className="memory-tab-content">
          {restoreMsg && <div className="memory-restore-msg">{restoreMsg}</div>}
          {history.length === 0 ? (
            <div className="memory-empty">No history yet. History is recorded each time MEMORY.md changes.</div>
          ) : (
            <div className="memory-history-list">
              {history.map(entry => (
                <HistoryEntry
                  key={entry.id}
                  entry={entry}
                  onRestore={handleRestore}
                  restoring={restoringId === entry.id}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
