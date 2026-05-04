import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// When served through HA ingress, absolute /api/ paths would resolve to HA's
// own API instead of this add-on. The server injects window.__BASE__ from the
// X-Ingress-Path header so we can rewrite those requests to the correct URL.
const ingressBase = window.__BASE__ || ''
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
