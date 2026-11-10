// Confirms a purchase with Stripe. Used by api/verify.js (Vercel) and netlify/functions/verify.js.
// Needs the STRIPE_SECRET_KEY environment variable. Returns { pro, plan, until }.
const API = 'https://api.stripe.com/v1';

async function stripe(path, key, fetchFn = fetch) {
  const res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Stripe ${res.status}`);
  return res.json();
}

async function evaluate(session, key, fetchFn) {
  if (!session || session.status !== 'complete') return null;
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return null;
  if (session.mode === 'payment') return { pro: true, plan: 'lifetime', until: null };
  if (session.mode === 'subscription' && session.subscription) {
    const id = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    const sub = await stripe(`/subscriptions/${encodeURIComponent(id)}`, key, fetchFn);
    if (sub.status !== 'active' && sub.status !== 'trialing') return null;
    const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
    return { pro: true, plan: 'subscription', until: end ? end * 1000 : null };
  }
  return null;
}

export async function verifyPurchase({ sessionId, email }, key, fetchFn = fetch) {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const none = { pro: false, plan: null, until: null };
  if (sessionId) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return none;
    let session;
    try { session = await stripe(`/checkout/sessions/${sessionId}`, key, fetchFn); } catch { return none; }
    return (await evaluate(session, key, fetchFn)) || none;
  }
  if (email) {
    const q = `customer_details[email]=${encodeURIComponent(email.trim().toLowerCase())}&status=complete&limit=20`;
    const list = await stripe(`/checkout/sessions?${q}`, key, fetchFn);
    for (const session of list.data || []) {
      const r = await evaluate(session, key, fetchFn);
      if (r) return r;
    }
  }
  return none;
}
