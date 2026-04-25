import { useState } from 'react'
import './LoginScreen.css'

export default function LoginScreen({ onLogin, isLoading = false, error = '' }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (isLoading) return
    onLogin({ username, password })
  }

  return (
    <div className="auth-shell">
      <div className="auth-grid" aria-hidden />
      <div className="auth-glow" aria-hidden />

      <div className="auth-panel">
        <span className="auth-corner tl" />
        <span className="auth-corner tr" />
        <span className="auth-corner bl" />
        <span className="auth-corner br" />

        <div className="auth-header">
          <div className="status-pip" />
          <h1 className="auth-title">HestiaClaw</h1>
        </div>
        <p className="auth-subtitle">LOCAL COMMAND AUTHORIZATION REQUIRED</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              disabled={isLoading}
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={isLoading}
            />
          </label>

          {error && <p className="auth-message auth-message--error">{error}</p>}
          {isLoading && <p className="auth-message">Establishing secure channel…</p>}

          <button className="auth-submit" type="submit" disabled={isLoading || !username.trim() || !password}>
            {isLoading ? 'AUTHORIZING…' : 'AUTHORIZE'}
          </button>
        </form>
      </div>
    </div>
  )
}
