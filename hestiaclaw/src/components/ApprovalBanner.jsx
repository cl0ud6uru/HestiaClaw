import { useState } from 'react'
import './ApprovalBanner.css'

export default function ApprovalBanner({ pending, onDecision }) {
  const [busy, setBusy] = useState(false)
  if (!pending || pending.length === 0) return null

  const current = pending[pending.length - 1]
  const riskClass = current.risk === 'high'
    ? 'approval-banner__risk--high'
    : current.risk === 'medium'
      ? 'approval-banner__risk--medium'
      : ''

  const decide = (approved) => {
    if (busy) return
    setBusy(true)
    try { onDecision(current.approvalId, approved) } finally {
      setTimeout(() => setBusy(false), 250)
    }
  }

  return (
    <div className="approval-banner" role="alert" aria-live="assertive">
      <span className="bubble-corner tl" />
      <span className="bubble-corner tr" />
      <span className="bubble-corner bl" />
      <span className="bubble-corner br" />
      <div className="approval-banner__row">
        <div className="approval-banner__pulse" />
        <div className="approval-banner__text">
          <span className="approval-banner__label">APPROVAL NEEDED</span>
          <span className={`approval-banner__risk ${riskClass}`}>
            {(current.risk || 'risky').toUpperCase()}
          </span>
          <span className="approval-banner__tool">{current.toolName}</span>
          {pending.length > 1 && (
            <span className="approval-banner__queue">+{pending.length - 1} more</span>
          )}
        </div>
        <div className="approval-banner__actions">
          <button
            className="approval-banner__btn approval-banner__btn--approve"
            onClick={() => decide(true)}
            disabled={busy}
          >
            APPROVE
          </button>
          <button
            className="approval-banner__btn approval-banner__btn--deny"
            onClick={() => decide(false)}
            disabled={busy}
          >
            DENY
          </button>
        </div>
      </div>
    </div>
  )
}
