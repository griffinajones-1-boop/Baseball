import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPurchase } from '../server/verify-core.js';
import { buildReport, buildInsights, buildTrends, gameLine, replayGame } from '../js/stats.js';

const fake = (routes) => async (url) => {
  const path = url.replace('https://api.stripe.com/v1', '');
  const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
  return hit ? { ok: true, json: async () => hit[1] } : { ok: false, status: 404, json: async () => ({}) };
};

test('verify: paid one-time session is lifetime Pro', async () => {
  const f = fake({ '/checkout/sessions/cs_test_1': { status: 'complete', payment_status: 'paid', mode: 'payment' } });
  assert.deepEqual(await verifyPurchase({ sessionId: 'cs_test_1' }, 'sk', f), { pro: true, plan: 'lifetime', until: null });
});

test('verify: subscription active vs canceled, unknown and malformed ids', async () => {
  const session = { status: 'complete', payment_status: 'paid', mode: 'subscription', subscription: 'sub_1' };
  const active = fake({ '/checkout/sessions/cs_a': session, '/subscriptions/sub_1': { status: 'active', current_period_end: 2000 } });
  assert.deepEqual(await verifyPurchase({ sessionId: 'cs_a' }, 'sk', active), { pro: true, plan: 'subscription', until: 2000000 });
  const canceled = fake({ '/checkout/sessions/cs_a': session, '/subscriptions/sub_1': { status: 'canceled' } });
  assert.equal((await verifyPurchase({ sessionId: 'cs_a' }, 'sk', canceled)).pro, false);
  assert.equal((await verifyPurchase({ sessionId: 'cs_missing' }, 'sk', active)).pro, false);
  assert.equal((await verifyPurchase({ sessionId: '../customers' }, 'sk', active)).pro, false);
  await assert.rejects(() => verifyPurchase({ sessionId: 'cs_a' }, '', active));
});

test('verify: restore by email finds a paid session', async () => {
  const f = fake({ '/checkout/sessions?customer_details[email]=a%40b.co': { data: [{ status: 'complete', payment_status: 'unpaid', mode: 'payment' }, { status: 'complete', payment_status: 'paid', mode: 'payment' }] } });
  assert.equal((await verifyPurchase({ email: ' A@b.co ' }, 'sk', f)).pro, true);
});

const P = (result, zone, extra = {}) => ({ type: 'pitch', zone, loc: null, result, t: 0, ...extra });
const mk = (id, date, events) => ({ id, date, opponent: 'X', player: 'Sam', createdAt: 1, events });

test('gameLine, trends and insights', () => {
  const g1 = mk('a', '2026-04-01', [P('IP', 'heart', { outcome: '2B' }), P('B', 'chase'), P('B', 'chase'), P('B', 'chase'), P('B', 'waste'), P('SS', 'heart'), P('SS', 'heart'), P('SS', 'chase')]);
  assert.equal(gameLine(replayGame(g1).pas), '1-for-2 · 2B · BB · K');
  const chasey = [];
  for (let i = 0; i < 30; i++) chasey.push(P('SS', 'chase'));
  const g2 = mk('b', '2026-04-08', chasey);
  const trends = buildTrends([g2, g1]);
  const chase = trends.find((t) => t.key === 'chase');
  assert.deepEqual(chase.points.map((p) => p.date), ['2026-04-01', '2026-04-08']);
  assert.equal(chase.points[1].value, 1);
  const titles = buildInsights(buildReport([g1, g2])).map((i) => i.title);
  assert.ok(titles.includes('Chasing pitches'));
  assert.ok(titles.includes('Swing and miss'));
  assert.deepEqual(buildInsights(buildReport([g1])), []); // small samples stay quiet
});
