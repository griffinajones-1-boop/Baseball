// Anonymous usage counts: sends event names only (no game data, names or IDs) to /api/track.
// Turned off by the person in Settings, on localhost, and when the endpoint doesn't exist.
const KEY = 'atbatlog.usage';
let state = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
state.queue = Array.isArray(state.queue) ? state.queue : [];
let enabled = () => true;
let sending = false;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';

export function configure({ isEnabled }) { enabled = isEnabled; }

export function track(name) {
  if (isLocal || !enabled()) return;
  state.queue = [...state.queue, name].slice(-50);
  save();
  flush();
}

/** Once per device per day. */
export function trackOpen(installed) {
  const today = new Date().toISOString().slice(0, 10);
  if (!state.seen) { state.seen = today; track('new_device'); }
  if (state.day !== today) {
    state.day = today;
    track('open');
    if (installed) track('open_installed');
  }
  save();
}

export function flush() {
  if (sending || !state.queue.length || isLocal || !enabled() || navigator.onLine === false) return;
  sending = true;
  const events = state.queue.slice(0, 20);
  fetch('/api/track', {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }).then((r) => {
    // Sent, or the server doesn't have the endpoint (404/405): either way, drop them.
    if (r.ok || r.status === 404 || r.status === 405 || r.status === 400) {
      state.queue = state.queue.slice(events.length);
      return true;
    }
    return false;
  }).catch(() => false) // offline or blocked: keep them for later
    .then((done) => {
      sending = false; save();
      if (done && state.queue.length) flush(); // events added while this request was in flight
    });
}

export function clearQueue() { state.queue = []; save(); }

window.addEventListener('online', flush);
