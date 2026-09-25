import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Register the PWA service worker (production only; the dev server serves modules
// that shouldn't be intercepted). Fails silently if unsupported.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
} else if ('serviceWorker' in navigator) {
  // Dev: remove any worker left over from a production build on this origin so
  // it can't serve cached (stale) modules, then reload once to load fresh code.
  navigator.serviceWorker.getRegistrations().then(async regs => {
    if (regs.length === 0) return
    await Promise.all(regs.map(r => r.unregister()))
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k.startsWith('foundit-')).map(k => caches.delete(k)))
    if (navigator.serviceWorker.controller) location.reload()
  })
}
