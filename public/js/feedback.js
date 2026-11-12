// Feedback goes to Netlify Forms (form "feedback", declared in index.html).
// Messages written offline are kept on the phone and sent when it's back online.
const KEY = 'atbatlog.feedback';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (q) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* ignore */ } };

async function post(item) {
  const body = new URLSearchParams({ 'form-name': 'feedback', 'bot-field': '', ...item });
  const r = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Returns 'sent' or 'queued'. */
export async function sendFeedback(item) {
  try {
    if (navigator.onLine === false) throw new Error('offline');
    await post(item);
    return 'sent';
  } catch {
    save([...load(), item].slice(-10));
    return 'queued';
  }
}

let flushing = false;
export async function flushFeedback() {
  if (flushing) return; // 'online' can fire more than once; never send a message twice
  const q = load();
  if (!q.length || navigator.onLine === false) return;
  flushing = true;
  try {
    for (const item of q) {
      try {
        await post(item);
        save(load().filter((x) => JSON.stringify(x) !== JSON.stringify(item)));
      } catch { /* keep it for next time */ }
    }
  } finally { flushing = false; }
}

export const pendingFeedback = () => load().length;

window.addEventListener('online', () => { flushFeedback(); });
