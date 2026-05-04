import { useState } from 'react'
import './AccountPanel.css'

export default function AccountPanel({
  user,
  isBusy,
  error,
  success,
  voiceError,
  voiceLoading,
  voices,
  selectedVoiceId,
  defaultVoiceId,
  onClose,
  onSubmit,
  onVoiceChange,
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState(user.username)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState('')
  const voiceOptions = voices || []

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLocalError('')

    if (newPassword !== confirmPassword) {
      setLocalError('New password confirmation does not match.')
      return
    }

    const ok = await onSubmit({ currentPassword, newUsername, newPassword })
    if (ok) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    }
  }

  return (
    <div className="account-panel">
      <div className="account-panel__header">
        <div>
          <div className="account-panel__label">ADMIN ACCOUNT</div>
          <div className="account-panel__user">{user.username}</div>
        </div>
        <button className="account-panel__close" onClick={onClose} type="button">×</button>
      </div>

      <div className="account-panel__voice">
        <div className="account-panel__voice-header">
          <div className="account-panel__label">VOICE OUTPUT</div>
          <div className="account-panel__voice-note">Streaming ElevenLabs playback</div>
        </div>

        <label className="account-panel__field">
          <span>Assistant voice</span>
          <select
            value={selectedVoiceId || defaultVoiceId}
            onChange={e => onVoiceChange(e.target.value)}
            disabled={voiceLoading || !voiceOptions.length}
          >
            {voiceOptions.map(voice => (
              <option key={voice.voiceId} value={voice.voiceId}>
                {voice.name}{voice.voiceId === defaultVoiceId ? ' — default' : ''}
              </option>
            ))}
          </select>
        </label>

        {voiceError && <p className="account-panel__message account-panel__message--error">{voiceError}</p>}
      </div>

      <form className="account-panel__form" onSubmit={handleSubmit}>
        <label className="account-panel__field">
          <span>New username</span>
          <input
            type="text"
            value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            disabled={isBusy}
          />
        </label>

        <label className="account-panel__field">
          <span>Current password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            disabled={isBusy}
          />
        </label>

        <label className="account-panel__field">
          <span>New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={isBusy}
          />
        </label>

        <label className="account-panel__field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={isBusy}
          />
        </label>

        {(error || localError) && <p className="account-panel__message account-panel__message--error">{error || localError}</p>}
        {success && <p className="account-panel__message account-panel__message--success">{success}</p>}

        <button
          className="account-panel__submit"
          type="submit"
          disabled={isBusy || !currentPassword || !newUsername.trim() || !newPassword || !confirmPassword}
        >
          {isBusy ? 'UPDATING…' : 'UPDATE CREDENTIALS'}
        </button>
      </form>
    </div>
  )
}
