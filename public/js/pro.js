// Pro entitlement. Stored on the device; optionally confirmed by a serverless endpoint.
import { CONFIG } from './config.js';

const KEY = 'atbatlog.pro';
const GRACE_MS = 7 * 24 * 3600 * 1000; // keep Pro working offline for a week past renewal

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function write(s) {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}
let state = read();

export const proEnabled = () => !!CONFIG.pro.enabled;
export const paymentsLive = () => CONFIG.pro.plans.some((p) => p.url);
export function isPro() {
  if (!proEnabled()) return true;
  if (!state || !state.active) return false;
  if (state.until && Date.now() > state.until + GRACE_MS) return false;
  return true;
}
export const proState = () => state;

async function verify(params) {
  const url = new URL(CONFIG.pro.verifyUrl, location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not reach the purchase check. Try again in a moment.');
  return res.json(); // { pro, plan, until }
}

function apply(result, extra) {
  if (result.pro) {
    state = { active: true, plan: result.plan || null, until: result.until || null, checkedAt: Date.now(), ...extra };
  } else if (state) {
    state = { ...state, active: false, checkedAt: Date.now() };
  }
  write(state);
  return isPro();
}

/** Called when checkout redirects back with ?session_id=... */
export async function activateFromSession(sessionId) {
  if (!CONFIG.pro.verifyUrl) return apply({ pro: true }, { sessionId });
  return apply(await verify({ session_id: sessionId }), { sessionId });
}

/** "Restore purchase" on a new phone. Needs the verify endpoint. */
export async function restoreByEmail(email) {
  if (!CONFIG.pro.verifyUrl) throw new Error('Restore is not available yet.');
  return apply(await verify({ email }), { email });
}

/** Re-check a subscription after its period ends (quietly; keeps Pro during the grace window). */
export async function refreshIfDue() {
  if (!state || !state.active || !state.until || !CONFIG.pro.verifyUrl) return;
  if (Date.now() < state.until || !navigator.onLine) return;
  try {
    const params = state.sessionId ? { session_id: state.sessionId } : state.email ? { email: state.email } : null;
    if (params) apply(await verify(params), {});
  } catch { /* offline or endpoint down: grace period covers it */ }
}

/** Local preview switch (used only on localhost). */
export function devSetPro(on) {
  state = on ? { active: true, plan: 'preview', until: null } : null;
  write(state);
}
