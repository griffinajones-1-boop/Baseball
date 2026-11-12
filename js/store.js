// Local-only persistence (localStorage). Everything stays on this device.
const KEY = 'atbatlog.v1';

function empty() {
  return { version: 1, games: [], prefs: { lastPlayer: '' } };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    if (!Array.isArray(data.games)) return empty();
    data.prefs = data.prefs || { lastPlayer: '' };
    return data;
  } catch (e) {
    console.error('Could not read saved data', e);
    return empty();
  }
}

export function save(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch (e) {
    console.error('Could not save', e);
    return false;
  }
}

/** Validate a backup file before replacing local data. */
export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.games)) throw new Error('Not a Bleacher Stats backup file');
  for (const g of data.games) {
    if (!g.id || !Array.isArray(g.events)) throw new Error('Backup file has a malformed game');
  }
  data.prefs = data.prefs || { lastPlayer: '' };
  data.version = 1;
  return data;
}

export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
