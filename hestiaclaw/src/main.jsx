import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// When served through HA ingress, absolute /api/ paths resolve to HA's own API
// instead of this add-on. Prefer the server-injected base, but fall back to the
// first path segment because local HA ingress may not forward X-Ingress-Path.
function resolveIngressBase() {
  if (window.__BASE__) return String(window.__BASE__).replace(/\/$/, '')

  const firstSegment = window.location.pathname.match(/^\/([^/]+)/)?.[0] || ''
  if (!firstSegment || firstSegment === '/api') return ''
  return firstSegment
}

const ingressBase = resolveIngressBase()
if (ingressBase) {
  const _fetch = window.fetch.bind(window)
  window.fetch = (url, ...args) => {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      url = `${ingressBase}${url}`
    }
    return _fetch(url, ...args)
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
