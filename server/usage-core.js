// Anonymous usage counts. No names, game data, IP addresses or device IDs are stored:
// only how many times each whitelisted event happened per day.
export const EVENTS = {
  open: 'Devices that opened the app (counted once per device per day)',
  open_installed: '…of those, opened from the home screen',
  new_device: 'New devices (first time ever opening the app)',
  start_basic: 'New users who chose Basic',
  start_standard: 'New users who chose Standard',
  start_advanced: 'New users who chose Advanced',
  game: 'Games started (first pitch logged)',
  game_done: 'Games ended with the End game button',
  first_game: 'Devices that logged their first game',
  game3: 'Devices that reached 3 games',
  game10: 'Devices that reached 10 games',
  share: 'Report images shared',
  backup: 'Backups saved',
  feedback: 'Feedback messages sent',
};
const MAX_EVENTS = 20;

/** Keep only known event names, at most MAX_EVENTS per request. */
export function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => typeof e === 'string' && Object.hasOwn(EVENTS, e)).slice(0, MAX_EVENTS);
}

export const dayKey = (d) => `day/${d.toISOString().slice(0, 10)}`;

/** store: anything with get(key, {type:'json'}) and setJSON(key, value), like a Netlify Blobs store. */
export async function record(store, events, now = new Date()) {
  if (!events.length) return null;
  const key = dayKey(now);
  const counts = (await store.get(key, { type: 'json' })) || {};
  for (const e of events) counts[e] = (counts[e] || 0) + 1;
  await store.setJSON(key, counts);
  return counts;
}

/** The last `days` days, newest first, each { date, counts }. Days with no events are included as zeros. */
export async function summary(store, days = 60, now = new Date()) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const counts = (await store.get(dayKey(d), { type: 'json' })) || {};
    rows.push({ date: d.toISOString().slice(0, 10), counts });
  }
  const totals = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] || 0) + v;
  return { events: EVENTS, days: rows, totals };
}
