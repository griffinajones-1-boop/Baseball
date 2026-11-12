import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanEvents, record, summary, dayKey } from '../server/usage-core.js';

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
  };
}

test('only known events are kept, capped at 20', () => {
  assert.deepEqual(cleanEvents(['open', 'nope', 42, 'game', '__proto__', 'toString']), ['open', 'game']);
  assert.equal(cleanEvents(Array(50).fill('open')).length, 20);
  assert.deepEqual(cleanEvents('open'), []);
  assert.deepEqual(cleanEvents(null), []);
});

test('record adds to the day bucket and summary totals it', async () => {
  const s = memStore();
  const d1 = new Date('2026-11-10T15:00:00Z'), d2 = new Date('2026-11-11T02:00:00Z');
  await record(s, ['open', 'game', 'game'], d1);
  await record(s, ['open'], d1);
  await record(s, ['open', 'first_game'], d2);
  assert.deepEqual(await s.get(dayKey(d1)), { open: 2, game: 2 });
  const sum = await summary(s, 3, new Date('2026-11-11T12:00:00Z'));
  assert.deepEqual(sum.days.map((x) => x.date), ['2026-11-11', '2026-11-10', '2026-11-09']);
  assert.deepEqual(sum.totals, { open: 3, game: 2, first_game: 1 });
  assert.ok(sum.events.open);
  assert.equal(await record(s, [], d1), null);
});
