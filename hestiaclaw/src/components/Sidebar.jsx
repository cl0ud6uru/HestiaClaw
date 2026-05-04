import { useState } from 'react'
import './Sidebar.css'

function relativeDate(ts) {
  const now = new Date()
  const d = new Date(ts)
  const diffDays = Math.floor((now - d) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function Sidebar({ conversations, activeId, onNew, onSelect, onDelete, isOpen, onToggle, agentMode, onAgentModeChange }) {
  const [search, setSearch] = useState('')
  const sorted = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const filtered = search.trim()
    ? sorted.filter(c => c.title.toLowerCase().includes(search.toLowerCase()))
    : sorted

  return (
    <aside
      className={`sidebar ${isOpen ? '' : 'sidebar--collapsed'}`}
      aria-hidden={!isOpen}
      inert={!isOpen ? '' : undefined}
    >
      <div className="sidebar-header">
        <button className="new-chat-btn" onClick={onNew} title="New Chat">
          <span className="new-chat-icon">+</span>
          <span className="new-chat-label">NEW CHAT</span>
        </button>
        <button className="collapse-btn" onClick={onToggle} title={isOpen ? 'Collapse' : 'Expand'}>
          {isOpen ? '‹' : '›'}
        </button>
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-search">
        <input
          type="text"
          className="sidebar-search-input"
          placeholder="SEARCH SESSIONS"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button className="sidebar-search-clear" onClick={() => setSearch('')}>×</button>
        )}
      </div>

      <div className="sidebar-section-label">
        <span>SESSIONS</span>
      </div>

      <div className="sidebar-list">
        {conversations.length === 0 && (
          <div className="sidebar-empty">No sessions yet</div>
        )}
        {filtered.length === 0 && conversations.length > 0 && (
          <div className="sidebar-empty">No matches</div>
        )}
        {filtered.map(conv => (
          <div
            key={conv.id}
            className={`conv-item ${conv.id === activeId ? 'conv-item--active' : ''}`}
            onClick={() => onSelect(conv.id)}
          >
            <div className="conv-item-body">
              <div className="conv-title">{conv.title}</div>
              <div className="conv-date">{relativeDate(conv.updatedAt)}</div>
            </div>
            <button
              className="conv-delete"
              onClick={e => { e.stopPropagation(); onDelete(conv.id) }}
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-mode-toggle">
        <span className="sidebar-mode-label">BACKEND</span>
        <div className="mode-toggle-group">
          <button
            className={`mode-toggle-btn ${agentMode === 'n8n' ? 'mode-toggle-btn--active' : ''}`}
            onClick={() => onAgentModeChange('n8n')}
            title="Use N8N automation backend"
          >
            N8N
          </button>
          <button
            className={`mode-toggle-btn ${agentMode === 'agent' ? 'mode-toggle-btn--active' : ''}`}
            onClick={() => onAgentModeChange('agent')}
            title="Use native agent harness"
          >
            AGENT
          </button>
        </div>
      </div>

      <div className="sidebar-footer">
        <span>HestiaClaw</span>
        <span>{conversations.length} SESSION{conversations.length !== 1 ? 'S' : ''}</span>
      </div>
    </aside>
  )
}
