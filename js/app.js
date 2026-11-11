import * as store from './store.js';
import * as pro from './pro.js';
import { CONFIG } from './config.js';
import {
  RESULTS, ZONES, ZONE_LABELS, CONTACT, TRAJ, OUTCOMES, PA_RESULTS, GRID, MIN_N, HITS,
  replayGame, buildReport, buildInsights, buildTrends, gameLine,
  defaultZoneForLoc, locName, toCSV, scaleScore,
} from './stats.js';
import { fieldSVG, pointToField } from './field.js';
import { renderSummary, shareOrDownload } from './share.js';

let db = store.load();
let installPrompt = null; // Android/desktop "install app" event
const ui = {
  sel: { zone: null, loc: null },
  ip: null, // in-play sheet state
  menu: false,
  report: { player: 'all', season: 'all', game: 'all' },
  heat: 'seen',
  heatPick: null,
  sprayPick: null,
  toast: null,
  countKey: '',
  busy: false,
};
const app = document.getElementById('app');
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const rate3 = (v) => (v == null ? '—' : v.toFixed(3).replace(/^0/, ''));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = (iso, withYear = true) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
};
const getGame = (id) => db.games.find((g) => g.id === id);
const sortedGames = () => [...db.games].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
const players = () => [...new Set(db.games.map((g) => g.player).filter(Boolean))].sort();
const seasons = () => [...new Set(db.games.map((g) => (g.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
function persist() {
  if (!store.save(db)) showToast('Could not save. Your phone storage may be full.', 4000);
}
function buzz(ms = 12) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ } }
function showToast(msg, ms = 2400) {
  ui.toast = msg;
  const el = document.getElementById('toast');
  if (el) { el.textContent = msg; el.classList.add('show'); }
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => {
    ui.toast = null;
    document.getElementById('toast')?.classList.remove('show');
  }, ms);
}
const saveFile = (name, text, type) => shareOrDownload(new Blob([text], { type }), name, CONFIG.appName);

// ---------- backups ----------
const BACKUP_EVERY = 3; // games logged since the last backup before we suggest one
const loggedGames = () => db.games.filter((g) => g.events.length).length;
function backupDue() {
  const n = loggedGames();
  const since = n - (db.prefs.backupGames || 0);
  return since >= BACKUP_EVERY && n > (db.prefs.backupSnoozeAt || 0);
}
async function doBackup() {
  const ok = await saveFile(`at-bat-log-backup-${today()}.json`, JSON.stringify(db, null, 1), 'application/json');
  if (!ok) return;
  db.prefs.backupGames = loggedGames();
  db.prefs.backupAt = Date.now();
  persist();
  showToast('Backup saved');
  render();
}
function describePA(pa) {
  if (pa.result === 'K') return pa.kLooking ? 'Strikeout looking' : 'Strikeout swinging';
  return PA_RESULTS[pa.result] || pa.result;
}
const backHeader = (title, href = '#/', right = '<span class="spacer"></span>') => `<header class="top"><a class="icon-btn" href="${href}" aria-label="Back">‹</a><h1>${title}</h1>${right}</header>`;

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  return { view: view || 'home', id };
}
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', () => {
  ui.ip = null; ui.menu = false; ui.sel = { zone: null, loc: null }; ui.countKey = '';
  render(); window.scrollTo(0, 0);
});

function render() {
  const r = route();
  let html;
  if (r.view === 'game' && getGame(r.id)) html = viewLive(getGame(r.id));
  else if (r.view === 'new') html = viewGameForm(null);
  else if (r.view === 'edit' && getGame(r.id)) html = viewGameForm(getGame(r.id));
  else if (r.view === 'report') {
    if (r.id && getGame(r.id)) {
      const g = getGame(r.id);
      ui.report = { player: g.player || 'all', season: (g.date || '').slice(0, 4) || 'all', game: g.id };
    }
    html = viewReport();
  } else if (r.view === 'settings') html = viewSettings();
  else if (r.view === 'pro' && pro.proEnabled()) html = viewPro();
  else html = viewHome();
  app.innerHTML = html + `<div id="toast" class="toast ${ui.toast ? 'show' : ''}" role="status" aria-live="polite">${esc(ui.toast || '')}</div>`;
  document.body.dataset.view = r.view;
}

// ---------- home ----------
function seasonCard() {
  const latest = sortedGames()[0];
  if (!latest) return '';
  const year = (latest.date || '').slice(0, 4);
  const games = db.games.filter((g) => g.player === latest.player && (g.date || '').startsWith(year));
  const rep = buildReport(games);
  if (!rep.paCount) return '';
  const sl = rep.slash;
  return `<a class="season-card" href="#/report" data-act="open-season" data-player="${esc(latest.player)}" data-season="${esc(year)}">
    <span class="sc-top">${esc(latest.player || 'Season')} · ${esc(year)}<span>Season report ›</span></span>
    <span class="sc-stats">
      <span><b>${rate3(sl.avg)}</b>AVG</span>
      <span><b>${rate3(sl.obp)}</b>OBP</span>
      <span><b>${pct(rep.stats.chase.value)}</b>Chase</span>
      <span><b>${rep.paCount}</b>PA</span>
    </span>
  </a>`;
}

function viewHome() {
  const games = sortedGames();
  const many = players().length > 1;
  if (!games.length) {
    return `<main class="page">
      <header class="top"><h1>${esc(CONFIG.appName)}</h1><a class="icon-btn" href="#/settings" aria-label="Settings">⚙</a></header>
      <section class="welcome">
        <img src="icons/icon.svg" alt="" width="72" height="72">
        <h2>Every pitch tells you something</h2>
        <p>Log your kid's at-bats in two taps a pitch. See what they swing at, what they miss, and how it changes over the season.</p>
        <ol class="steps">
          <li><b>Tap where the pitch was</b></li>
          <li><b>Tap what happened</b></li>
          <li><b>Read the report after the game</b></li>
        </ol>
      </section>
      <a class="btn primary huge" href="#/new">Start your first game</a>
      <p class="hint center">Free. No account. Works without signal.</p>
    </main>`;
  }
  const list = games.map((g) => {
    const { pas, current } = replayGame(g);
    const live = current.pitches.length > 0;
    const line = gameLine(pas);
    return `<li class="row">
      <a class="row-main" href="#/game/${g.id}">
        <b>vs ${esc(g.opponent || 'Opponent')}${live ? ' <i class="live-dot" title="At-bat in progress"></i>' : ''}</b>
        <span class="muted">${esc(fmtDate(g.date, false))}${many ? ` · ${esc(g.player)}` : ''}${line ? ` · ${esc(line)}` : ''}</span>
      </a>
      <a class="row-side" href="#/report/${g.id}">Report</a>
    </li>`;
  }).join('');
  return `<main class="page">
    <header class="top"><h1>${esc(CONFIG.appName)}</h1><a class="icon-btn" href="#/settings" aria-label="Settings">⚙</a></header>
    ${seasonCard()}
    <a class="btn primary huge" href="#/new">New game</a>
    ${backupDue() ? `<section class="nudge"><span><b>Back up your season</b><small>${loggedGames() - (db.prefs.backupGames || 0)} games since your last backup. They only live on this phone.</small></span>
      <span class="nudge-actions"><button class="link" data-act="backup-later">Later</button><button class="btn primary" data-act="backup">Save backup</button></span></section>` : ''}
    <h2 class="section">Games</h2>
    <ul class="list">${list}</ul>
  </main>`;
}

// ---------- new / edit game ----------
function viewGameForm(g) {
  const opts = players().map((p) => `<option value="${esc(p)}">`).join('');
  return `<main class="page">
    ${backHeader(g ? 'Edit game' : 'New game', g ? `#/game/${g.id}` : '#/')}
    <form id="game-form" class="form" data-id="${g ? g.id : ''}">
      <label>Player<input name="player" list="players" required maxlength="40" autocomplete="off" value="${esc(g ? g.player : db.prefs.lastPlayer)}" placeholder="Your kid's name"></label>
      <datalist id="players">${opts}</datalist>
      <label>Opponent<input name="opponent" maxlength="40" autocomplete="off" value="${esc(g ? g.opponent : '')}" placeholder="Tigers"></label>
      <label>Date<input name="date" type="date" required value="${esc(g ? g.date : today())}"></label>
      <button class="btn primary huge" type="submit">${g ? 'Save' : 'Start logging'}</button>
      ${g ? `<button class="btn danger-link block" type="button" data-act="delete-game" data-id="${g.id}">Delete this game</button>` : ''}
    </form>
  </main>`;
}

// ---------- live logging ----------
function viewLive(g) {
  const { current, pitches } = replayGame(g);
  const b = current.balls, s = current.strikes;
  const dots = (n, max) => Array.from({ length: max }, (_, i) => `<i class="dot ${i < n ? 'on' : ''}"></i>`).join('');
  const last = g.events[g.events.length - 1];
  let lastText = 'Tap where the pitch was, then what happened';
  if (last && last.type === 'end') lastText = `PA ended · ${PA_RESULTS[last.reason]}`;
  else if (last) {
    const lp = pitches[pitches.length - 1];
    lastText = `${lp.balls}-${lp.strikes} ${RESULTS[lp.result]}${lp.result === 'IP' && lp.outcome ? ` · ${OUTCOMES[lp.outcome]}` : ''} · ${ZONE_LABELS[lp.zone]}`;
  }
  const countKey = `${current.num}:${b}-${s}`;
  const pop = ui.countKey && ui.countKey !== countKey ? 'pop' : '';
  ui.countKey = countKey;

  const cells = Array.from({ length: GRID * GRID }, (_, i) => {
    const z = defaultZoneForLoc(i);
    return `<button class="cell z-${z} ${ui.sel.loc === i ? 'sel' : ''}" data-act="loc" data-loc="${i}" aria-label="${esc(locName(i))}"></button>`;
  }).join('');
  const zoneBtns = ZONES.map((z) => `<button class="zbtn ${ui.sel.zone === z ? 'sel' : ''}" data-act="zone" data-zone="${z}">${ZONE_LABELS[z]}</button>`).join('');
  const resBtns = [
    ['B', 'Ball'], ['CS', 'Called<br>strike'], ['SS', 'Swinging<br>strike'],
    ['F', 'Foul'], ['IP', 'In play'], ['HBP', 'HBP'],
  ].map(([k, label]) => `<button class="rbtn r-${k}" data-act="result" data-r="${k}">${label}</button>`).join('');

  return `<main class="live">
    <header class="live-top">
      <a class="icon-btn" href="#/" aria-label="Back to games">‹</a>
      <div class="live-title">${esc(g.player || 'Batter')} <span class="muted">vs ${esc(g.opponent || 'Opp')}</span></div>
      <button class="icon-btn" data-act="menu" aria-label="Game menu">⋯</button>
    </header>
    <section class="countbar" aria-label="Count ${b} balls ${s} strikes">
      <div class="count-num ${pop}">${b}–${s}</div>
      <div class="count-dots"><div>${dots(b, 3)}</div><div>${dots(s, 2)}</div></div>
      <div class="count-pa">PA ${current.num}<span>Pitch ${current.pitches.length + 1}</span></div>
    </section>
    <section class="zone-wrap">
      <div class="locgrid" aria-label="Pitch location, catcher's view">${cells}<div class="sz-outline" aria-hidden="true"></div></div>
      <div class="zbtns" id="zbtns">${zoneBtns}</div>
    </section>
    <section class="laststrip">
      <span class="last-text">${esc(lastText)}</span>
      <button class="undo" data-act="undo" ${g.events.length ? '' : 'disabled'}>↶ Undo</button>
    </section>
    <section class="results">${resBtns}</section>
    ${ui.ip ? viewInPlay() : ''}
    ${ui.menu ? viewMenu(g, current) : ''}
  </main>`;
}

function viewMenu(g, current) {
  const { pas } = replayGame(g);
  const recent = [...pas].reverse().map((pa) => `<li><span>PA ${pa.num}</span>${esc(describePA(pa))}<span class="muted">${pa.pitches.length}p</span></li>`).join('');
  return `<div class="sheet-bg" data-act="close-menu"></div>
  <div class="sheet" role="dialog" aria-label="Game menu">
    <div class="sheet-head"><h2>${esc(g.player || 'Batter')} vs ${esc(g.opponent || 'Opp')}</h2><button class="link" data-act="close-menu">Done</button></div>
    <a class="btn primary block" href="#/report/${g.id}">Game report</a>
    <p class="label">End PA ${current.num} without a pitch</p>
    <div class="optrow two">
      <button class="opt" data-act="end-pa" data-reason="IBB">Intentional walk</button>
      <button class="opt" data-act="end-pa" data-reason="OTHER">Other</button>
    </div>
    <p class="hint">“Other” is for a runner out, game over, or a substitution. It isn't counted in the stats.</p>
    ${recent ? `<p class="label">This game</p><ol class="mini-log">${recent}</ol>` : ''}
    <div class="sheet-links"><a class="link" href="#/edit/${g.id}">Edit game</a></div>
  </div>`;
}

function viewInPlay() {
  const ip = ui.ip;
  const opt = (group, key, label) => `<button class="opt ${ip[group] === key ? 'sel' : ''}" data-act="ip-${group}" data-v="${key}">${label}</button>`;
  const dot = ip.spray ? `<circle class="spray-pick" cx="${ip.spray.x * 200}" cy="${ip.spray.y * 200}" r="6"/>` : '';
  return `<div class="sheet-bg"></div>
  <div class="sheet" role="dialog" aria-label="Ball in play">
    <div class="sheet-head"><h2>Ball in play</h2><button class="link" data-act="ip-cancel">Cancel</button></div>
    <div class="optrow three">${CONTACT.map((c) => opt('contact', c, c[0].toUpperCase() + c.slice(1))).join('')}</div>
    <div class="optrow four">${Object.entries(TRAJ).map(([k, v]) => opt('traj', k, v.replace(' ball', '').replace('Line drive', 'Liner'))).join('')}</div>
    <div class="field-input" data-act="ip-field">${fieldSVG(dot)}${ip.spray ? '' : '<span class="field-hint">Tap where it went</span>'}</div>
    <p class="label">Result</p>
    <div class="optrow outcomes">${Object.keys(OUTCOMES).map((k) => `<button class="opt" data-act="ip-outcome" data-v="${k}">${k === 'OUT' ? 'Out' : k === 'E' ? 'Error' : k}</button>`).join('')}</div>
  </div>`;
}

function logPitch(result, extra = {}) {
  const g = getGame(route().id);
  if (!g) return false;
  let zone = ui.sel.zone;
  if (!zone && result === 'HBP') zone = 'waste';
  if (!zone) {
    const zb = document.getElementById('zbtns');
    zb?.classList.remove('need'); void zb?.offsetWidth; zb?.classList.add('need');
    showToast('Pick a zone first', 1600);
    buzz(40);
    return false;
  }
  const before = replayGame(g).current.num;
  g.events.push({ type: 'pitch', t: Date.now(), zone, loc: ui.sel.loc, result, ...extra });
  persist();
  ui.sel = { zone: null, loc: null };
  ui.ip = null;
  const after = replayGame(g);
  if (after.current.num !== before) {
    const pa = after.pas[after.pas.length - 1];
    showToast(`${describePA(pa)}${HITS.has(pa.result) ? '!' : ''}`);
    buzz(HITS.has(pa.result) ? [15, 60, 15] : 25);
  } else buzz();
  render();
  return true;
}

// ---------- reports ----------
function filteredGames() {
  const f = ui.report;
  return db.games.filter((g) =>
    (f.player === 'all' || g.player === f.player)
    && (f.season === 'all' || (g.date || '').startsWith(f.season))
    && (f.game === 'all' || g.id === f.game));
}

// Colors are mixed here in plain JS (not CSS color-mix) so they also work on older phones.
const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
// Blue (needs work) -> gray -> red (great), like a scouting slider.
function scaleColor(t) {
  const [lo, mid, hi] = isDark() ? ['#3987e5', '#6f6e68', '#e66767'] : ['#2a78d6', '#b9b7af', '#e34948'];
  return t < 0.5 ? mixHex(lo, mid, t * 2) : mixHex(mid, hi, (t - 0.5) * 2);
}
function heatColor(t) {
  const [lo, hi] = isDark() ? ['#1f2a3a', '#9ec5f4'] : ['#e3eefb', '#0d366b'];
  return mixHex(lo, hi, 0.12 + t * 0.88);
}
function statRow(key, label, m, def, fmt = pct) {
  const n = !m.den ? 'No data' : fmt === pct ? `${m.num} of ${m.den}` : `${m.den} PA`;
  const small = m.small && m.den;
  const tiny = m.den < 5; // too few to even hint at a rating
  const t = scaleScore(key, m);
  const word = t == null ? '' : t >= 0.8 ? 'Great' : t >= 0.6 ? 'Good' : t > 0.4 ? 'Average' : t > 0.2 ? 'Below average' : 'Needs work';
  const bar = t == null ? '' : `<span class="meter ${small ? 'is-small' : ''}" role="img" aria-label="${tiny ? 'Too few pitches to rate' : small ? `Early read: ${word}` : word}" style="--t:${(t * 100).toFixed(0)}%;--c:${tiny ? 'var(--div-mid)' : scaleColor(t)}"><i></i><b></b></span>`;
  return `<details class="stat ${small ? 'is-small' : ''}"><summary>
    <span class="stat-label">${label}<small>${n}${small ? ` · ${tiny ? 'too few to rate' : `early read${t != null ? `: ${word.toLowerCase()}` : ''}`}` : t != null ? ` · ${word.toLowerCase()}` : ''}</small></span>
    <span class="stat-val">${fmt(m.value)}</span>${bar}</summary>
    <p class="stat-def">${def}</p></details>`;
}

function viewReport() {
  const f = ui.report;
  const ps = players(); const ss = seasons();
  if (f.player !== 'all' && !ps.includes(f.player)) f.player = 'all';
  if (f.season !== 'all' && !ss.includes(f.season)) f.season = 'all';
  const gamesForPick = sortedGames().filter((g) => (f.player === 'all' || g.player === f.player) && (f.season === 'all' || (g.date || '').startsWith(f.season)));
  if (f.game !== 'all' && !gamesForPick.some((g) => g.id === f.game)) f.game = 'all';
  // A filter with only one real choice is noise: hide it.
  const sel = (name, cur, options) => (options.length <= 2 && name !== 'game' ? '' : `<select data-filter="${name}" aria-label="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
  const filters = `<div class="filters">
    ${sel('player', f.player, [['all', 'All players'], ...ps.map((p) => [p, p])])}
    ${sel('season', f.season, [['all', 'All seasons'], ...ss.map((s) => [s, `${s} season`])])}
    ${sel('game', f.game, [['all', 'All games'], ...gamesForPick.map((g) => [g.id, `${fmtDate(g.date)} vs ${g.opponent || 'Opp'}`])])}
  </div>`;

  const games = filteredGames();
  const rep = buildReport(games);
  const S = rep.stats;
  const single = f.game !== 'all' ? getGame(f.game) : null;
  const isPro = pro.isPro();
  const deep = !!single || isPro; // game reports are always complete; the season deep-dive is Pro

  const canShare = rep.pitchCount > 0;
  const header = backHeader(single ? 'Game report' : 'Season report', single ? `#/game/${single.id}` : '#/', canShare ? '<button class="link share-btn" data-act="share-report">Share</button>' : '<span class="spacer"></span>');
  if (!rep.pitchCount && !rep.allPAs.length) {
    return `<main class="page report">${header}${filters}<p class="empty">Nothing logged for this selection yet.</p></main>`;
  }
  const sl = rep.slash;
  const outcomeList = Object.entries(rep.outcomes).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${esc(PA_RESULTS[k] || k)} ${n}`).join(' · ');

  return `<main class="page report">${header}${filters}
    <section class="hero ${sl.small ? 'is-small' : ''}">
      <div class="hero-num">${rate3(sl.avg)} / ${rate3(sl.obp)} / ${rate3(sl.slg)}</div>
      <div class="muted">AVG / OBP / SLG${sl.small && sl.pa ? ' · small sample' : ''}</div>
      <div class="hero-meta">${single ? esc(gameLine(rep.allPAs)) : `${games.length} game${games.length === 1 ? '' : 's'}`} · ${rep.paCount} PA · ${rep.pitchCount} pitches</div>
      <div class="hint">${outcomeList}</div>
    </section>

    ${!single && isPro && CONFIG.features.insights ? viewInsights(rep) : ''}

    <div class="scale-key" aria-hidden="true"><span>Needs work</span><i></i><span>Great</span></div>
    <h2 class="section">Swing decisions</h2>
    <div class="stats">
      ${statRow('chase', 'Chase rate', S.chase, 'Swings at Chase + Waste pitches ÷ Chase + Waste pitches.')}
      ${statRow('zoneSwing', 'Zone swing rate', S.zoneSwing, 'Swings at Heart + Edge pitches ÷ Heart + Edge pitches.')}
      ${statRow('heartTake', 'Heart take rate', S.heartTake, 'Heart pitches taken ÷ Heart pitches. Lower is better.')}
      ${statRow('firstPitchSwing', 'First-pitch swing', S.firstPitchSwing, 'Swings at the first pitch of a PA ÷ first pitches.')}
      ${statRow('twoStrikeChase', 'Two-strike chase', S.twoStrikeChase, 'Chase rate with two strikes.')}
    </div>
    <h2 class="section">Contact</h2>
    <div class="stats">
      ${statRow('whiff', 'Whiff rate', S.whiff, 'Swinging strikes ÷ swings.')}
      ${statRow('zoneContact', 'Zone contact', S.zoneContact, 'Fouls + balls in play ÷ swings at Heart + Edge pitches.')}
      ${statRow('swStr', 'Swinging-strike rate', S.swStr, 'Swinging strikes ÷ all pitches.')}
      ${statRow('hardHit', 'Hard-hit rate', S.hardHit, 'Hard contact ÷ balls in play.')}
    </div>
    <h2 class="section">Plate appearances</h2>
    <div class="stats">
      ${statRow('kRate', 'K rate', S.kRate, 'Strikeouts ÷ plate appearances.')}
      ${statRow('pPerPA', 'Pitches per PA', S.pPerPA, 'Average pitches seen per plate appearance.', (v) => (v == null ? '—' : v.toFixed(1)))}
    </div>

    ${!single && isPro && CONFIG.features.trends ? viewTrends(games) : ''}
    ${deep ? `
    <h2 class="section">By count</h2>
    ${viewSplits(rep.splits)}
    <h2 class="section">Heat map</h2>
    ${viewHeat(rep)}
    <h2 class="section">Spray chart</h2>
    ${viewSpray(rep, games)}` : viewUpsell()}

    ${single ? `<h2 class="section">Pitch by pitch</h2>${viewPALog(rep.allPAs)}` : ''}
    <p class="footnote">“Early read” means there aren't many pitches behind a number yet, so it can swing a lot from game to game. The blue-to-red scale is a general guide for youth hitters, not a ranking against other players. Tap any stat for its definition. In zone = Heart + Edge.</p>
  </main>`;
}

const PRO_FEATURES = [
  ...(CONFIG.features.insights ? [['Insights', 'Plain-language takeaways about what to work on']] : []),
  ...(CONFIG.features.trends ? [['Trends', 'Chase, whiff and hard-hit rates, game by game']] : []),
  ['Season heat map and spray chart', 'Every pitch and every ball in play in one picture'],
  ['Count splits', 'How the approach changes ahead and behind'],
];

function viewUpsell() {
  return `<a class="upsell" href="#/pro">
    <b>See the whole season with Pro</b>
    <span>The season-long heat map, spray chart and count splits. Every game report stays free.</span>
    <span class="upsell-cta">Take a look ›</span>
  </a>`;
}

function viewInsights(rep) {
  const items = buildInsights(rep);
  const body = items.length
    ? items.map((i) => `<li><b>${esc(i.title)}</b><span>${esc(i.text)}</span></li>`).join('')
    : `<li><span>Keep logging. Insights show up once there are about ${MIN_N.chase} pitches behind a stat.</span></li>`;
  return `<h2 class="section">Insights</h2><ul class="insights">${body}</ul>`;
}

function spark(points) {
  const w = 96, h = 28, pad = 4;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const xy = points.map((p, i) => [
    pad + (i * (w - pad * 2)) / (points.length - 1),
    max === min ? h / 2 : h - pad - ((p.value - min) / span) * (h - pad * 2),
  ]);
  const [lx, ly] = xy[xy.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3"/></svg>`;
}

function viewTrends(games) {
  if (games.length < 2) return '';
  const rows = buildTrends(games).filter((t) => t.points.length >= 2).map((t) => {
    const first = t.points[0], last = t.points[t.points.length - 1];
    return `<div class="trend"><span class="stat-label">${t.label}<small>${pct(first.value)} on ${fmtDate(first.date, false)} → ${pct(last.value)} on ${fmtDate(last.date, false)}</small></span>${spark(t.points)}</div>`;
  }).join('');
  if (!rows) return '';
  return `<h2 class="section">Trends, game by game</h2><div class="stats">${rows}</div>
    <p class="hint">Single games bounce around a lot. Look for the direction over several games.</p>`;
}

async function shareReport() {
  const f = ui.report;
  const games = filteredGames();
  const rep = buildReport(games);
  const single = f.game !== 'all' ? getGame(f.game) : null;
  const S = rep.stats, sl = rep.slash;
  const names = [...new Set(games.map((g) => g.player).filter(Boolean))];
  const who = names.length === 1 ? names[0] : 'Season';
  const stat = (label, m) => ({ label, value: pct(m.value), sub: m.den ? `${m.num} of ${m.den}` : 'no data', small: m.small });
  const canvas = renderSummary({
    title: single ? `${single.player || 'Batter'} vs ${single.opponent || 'Opponent'}` : `${who}${f.season !== 'all' ? ` · ${f.season} season` : ''}`,
    subtitle: single ? fmtDate(single.date) : `${games.length} game${games.length === 1 ? '' : 's'} · ${rep.paCount} PA · ${rep.pitchCount} pitches`,
    headline: single ? (gameLine(rep.allPAs) || `${rep.pitchCount} pitches`) : `${rate3(sl.avg)} / ${rate3(sl.obp)} / ${rate3(sl.slg)}`,
    headlineLabel: single ? `${rep.paCount} PA · ${rep.pitchCount} pitches seen` : 'AVG / OBP / SLG',
    stats: [stat('Chase rate', S.chase), stat('Zone swing', S.zoneSwing), stat('Whiff rate', S.whiff), stat('Hard-hit rate', S.hardHit)],
    spray: rep.spray,
    footer: `Made with ${CONFIG.appName} · ${location.host}`,
  });
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { showToast('Could not create the image'); return; }
  const slug = (single ? `${single.player}-vs-${single.opponent}-${single.date}` : `${who}-season`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await shareOrDownload(blob, `at-bat-log-${slug || 'report'}.png`, CONFIG.appName);
}

function viewSplits(sp) {
  const row = (k, label) => {
    const s = sp[k];
    const cell = (m) => `<td class="${m.small ? 'is-small' : ''}">${pct(m.value)}<small>${m.den ? `${m.num}/${m.den}` : ''}</small></td>`;
    const sl = s.slash;
    return `<tr><th>${label}<small>${s.pitches} pitches</small></th>${cell(s.swing)}${cell(s.chase)}${cell(s.whiff)}
      <td class="${sl.small ? 'is-small' : ''}">${s.pas}<small>${s.pas ? `${sl.h} H · ${s.k} K · ${s.bb} BB` : ''}</small></td>
      <td class="${sl.small ? 'is-small' : ''}">${rate3(sl.avg)}<small>${s.bip ? `${s.hard}/${s.bip} hard` : ''}</small></td></tr>`;
  };
  return `<div class="table-wrap"><table class="splits">
    <thead><tr><th>Count</th><th>Swing</th><th>Chase</th><th>Whiff</th><th>PA ended</th><th>AVG</th></tr></thead>
    <tbody>${row('ahead', 'Ahead')}${row('even', 'Even')}${row('behind', 'Behind')}</tbody></table></div>
    <p class="hint">Ahead = more balls than strikes. Even includes 0-0 and 3-2. “PA ended” and AVG use the count before the last pitch.</p>`;
}

function viewHeat(rep) {
  const mode = ui.heat;
  const cw = 44, ch = 50, gap = 2;
  const vals = rep.heat.map((c) => {
    if (mode === 'seen') return { v: c.seen, den: c.seen, text: c.seen ? String(c.seen) : '' };
    if (mode === 'swing') return { v: c.seen ? c.swings / c.seen : null, den: c.seen, text: c.seen ? pct(c.swings / c.seen) : '' };
    return { v: c.swings ? c.whiffs / c.swings : null, den: c.swings, text: c.swings ? pct(c.whiffs / c.swings) : '' };
  });
  const max = mode === 'seen' ? Math.max(1, ...vals.map((x) => x.v || 0)) : 1;
  const cells = vals.map((x, i) => {
    const r = Math.floor(i / GRID), c = i % GRID;
    const t = x.v == null ? null : x.v / max;
    const small = x.den < MIN_N.heatCell;
    const fill = t == null || (mode === 'seen' && !x.v) ? 'var(--heat-empty)' : heatColor(t);
    return `<g class="hcell ${t != null && t > 0.55 ? 'hot' : ''} ${small && x.den ? 'small' : ''} ${ui.heatPick === i ? 'picked' : ''}" data-act="heat-pick" data-i="${i}">
      <rect x="${c * cw + gap / 2}" y="${r * ch + gap / 2}" width="${cw - gap}" height="${ch - gap}" rx="4" fill="${fill}"/>
      <text x="${c * cw + cw / 2}" y="${r * ch + ch / 2 + 5}" text-anchor="middle">${x.text}</text></g>`;
  }).join('');
  const pick = ui.heatPick != null ? rep.heat[ui.heatPick] : null;
  const caption = pick
    ? `<b>${esc(locName(ui.heatPick))}</b>: ${pick.seen} pitch${pick.seen === 1 ? '' : 'es'}, ${pick.swings} swing${pick.swings === 1 ? '' : 's'}${pick.seen ? ` (${pct(pick.swings / pick.seen)})` : ''}, ${pick.whiffs} whiff${pick.whiffs === 1 ? '' : 's'}${pick.seen < MIN_N.heatCell && pick.seen ? ' · small sample' : ''}`
    : 'Catcher’s view. Tap a box for details.';
  const tab = (k, l) => `<button class="seg ${mode === k ? 'sel' : ''}" data-act="heat-mode" data-v="${k}">${l}</button>`;
  return `<div class="segs">${tab('seen', 'Pitches seen')}${tab('swing', 'Swing %')}${tab('whiff', 'Whiff %')}</div>
    <div class="heat-wrap"><svg class="heat" viewBox="0 0 ${cw * GRID} ${ch * GRID}" role="img" aria-label="Zone heat map, catcher's view">
      ${cells}<rect class="sz" x="${cw}" y="${ch}" width="${cw * 3}" height="${ch * 3}" rx="3"/></svg></div>
    <p class="hint heat-caption">${caption}</p>
    ${rep.noLoc ? `<p class="hint center">${rep.noLoc} pitch${rep.noLoc === 1 ? '' : 'es'} logged without a location</p>` : ''}`;
}

function viewSpray(rep, games) {
  const R = { weak: 4.5, medium: 5.5, hard: 7 };
  const dots = rep.spray.map((p, i) => `<circle class="spray c-${p.contact || 'none'} ${ui.sprayPick === i ? 'picked' : ''}" cx="${(p.x * 200).toFixed(1)}" cy="${(p.y * 200).toFixed(1)}" r="${R[p.contact] || 4.5}" data-act="spray-pick" data-i="${i}"/>`).join('');
  const pick = ui.sprayPick != null ? rep.spray[ui.sprayPick] : null;
  let caption = rep.spray.length ? 'Tap a dot for details.' : 'No balls in play yet.';
  if (pick) {
    const g = games.find((x) => x.id === pick.gameId);
    caption = `<b>${esc(pick.contact ? pick.contact[0].toUpperCase() + pick.contact.slice(1) : 'Unrated')}</b> ${esc(pick.traj ? TRAJ[pick.traj].toLowerCase() : 'contact')} → ${esc(OUTCOMES[pick.outcome] || '')}${g ? ` · ${esc(fmtDate(g.date))} PA ${pick.paNum}` : ''}`;
  }
  const n = (c) => rep.spray.filter((p) => p.contact === c).length;
  return `<div class="spray-wrap">${fieldSVG(dots, 'data-spray="1"')}</div>
    <div class="legend">
      <span><i class="lg c-weak"></i>Weak (${n('weak')})</span>
      <span><i class="lg c-medium"></i>Medium (${n('medium')})</span>
      <span><i class="lg c-hard"></i>Hard (${n('hard')})</span>
    </div>
    <p class="hint center">${caption}</p>`;
}

function viewPALog(pas) {
  const code = { B: 'B', CS: 'K', SS: 'S', F: 'F', IP: 'X', HBP: 'H' };
  return `<ol class="palog">${pas.map((pa) => `<li><b>${esc(describePA(pa))}</b>
    <span class="seq">${pa.pitches.map((p) => `<i class="pc r-${p.result}" title="${esc(RESULTS[p.result])} · ${esc(ZONE_LABELS[p.zone])}">${code[p.result]}</i>`).join('')}</span>
    ${(() => { const lp = pa.pitches[pa.pitches.length - 1]; return lp && lp.result === 'IP' ? `<small>${esc([lp.contact, lp.traj && TRAJ[lp.traj].toLowerCase()].filter(Boolean).join(' '))}</small>` : ''; })()}
  </li>`).join('')}</ol>
  <p class="hint">B ball · K called strike · S swinging strike · F foul · X in play · H hit by pitch</p>`;
}

// ---------- Pro ----------
function viewPro() {
  const st = pro.proState();
  if (pro.isPro()) {
    const until = st && st.until ? `Renews or ends ${new Date(st.until).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.` : '';
    return `<main class="page">${backHeader('Pro')}
      <section class="pro-hero"><div class="pro-badge">PRO</div><h2>You're all set. Thank you!</h2>
      <p class="muted">The full season report is unlocked on this phone. ${esc(until)}</p></section>
      <a class="btn primary block" href="#/report">Open season report</a>
      ${CONFIG.pro.manageUrl ? `<a class="btn secondary block" href="${esc(CONFIG.pro.manageUrl)}" target="_blank" rel="noopener">Manage subscription</a>` : ''}
      ${isLocal ? '<p class="hint center"><button class="link" data-act="dev-pro" data-v="0">Turn off Pro preview (local only)</button></p>' : ''}
    </main>`;
  }
  const feats = PRO_FEATURES.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join('');
  const plans = CONFIG.pro.plans.map((p, i) => `<button class="plan ${i === 0 ? 'best' : ''}" data-act="buy" data-plan="${esc(p.id)}">
      <span><b>${esc(p.name)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}</span>
      <span class="plan-price">${esc(p.price)}<small>/${esc(p.per)}</small></span></button>`).join('');
  return `<main class="page">${backHeader('Pro')}
    <section class="pro-hero"><div class="pro-badge">PRO</div><h2>See the whole season</h2>
      <p class="muted">Logging, game reports and exports are free and stay free. Pro adds the season-long view.</p></section>
    <ul class="features">${feats}</ul>
    <div class="plans">${plans}</div>
    <p class="hint center">Cancel anytime. Your data stays on your phone either way.</p>
    ${CONFIG.pro.verifyUrl ? `<form id="restore-form" class="restore"><p class="label">Already subscribed?</p>
      <div class="restore-row"><input type="email" name="email" required placeholder="Email used at checkout" autocomplete="email"><button class="btn secondary" type="submit">Restore</button></div></form>` : ''}
    ${isLocal ? '<p class="hint center"><button class="link" data-act="dev-pro" data-v="1">Preview Pro (local only)</button></p>' : ''}
  </main>`;
}

// ---------- settings ----------
function viewSettings() {
  const n = db.games.reduce((a, g) => a + g.events.filter((e) => e.type === 'pitch').length, 0);
  const proRow = !pro.proEnabled() ? '' : `<a class="row-link" href="#/pro"><span><b>${esc(CONFIG.appName)} Pro</b><small>${pro.isPro() ? 'Active on this phone' : 'The full season view'}</small></span><span class="chev">›</span></a>`;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const install = standalone ? '' : installPrompt
    ? '<button class="btn secondary block" data-act="install">Install on this phone</button>'
    : '<p class="hint">To install: on iPhone tap Share, then “Add to Home Screen”. On Android tap ⋮, then “Install app”.</p>';
  return `<main class="page">${backHeader('Settings')}
    ${proRow}
    <h2 class="section">Your data</h2>
    <p class="muted small">${db.games.length} game${db.games.length === 1 ? '' : 's'} · ${n} pitches, stored only on this phone.</p>
    <button class="btn secondary block" data-act="csv">Export all pitches (CSV)</button>
    <button class="btn secondary block" data-act="backup">Download backup</button>
    <label class="btn secondary block file-btn">Restore from backup<input type="file" accept="application/json,.json" id="restore"></label>
    <p class="hint">${db.prefs.backupAt ? `Last backup: ${new Date(db.prefs.backupAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. ` : ''}Save a backup now and then (email it to yourself or keep it in Files). Clearing browser data or removing the app erases the log.</p>
    <h2 class="section">App</h2>
    ${install}
    <div class="about"><a class="link" href="privacy.html">Privacy</a>${CONFIG.supportEmail ? `<a class="link" href="mailto:${esc(CONFIG.supportEmail)}">Contact</a>` : ''}<span class="muted">Version ${esc(CONFIG.version)}</span></div>
    <button class="btn danger-link block" data-act="wipe">Erase all data on this phone</button>
  </main>`;
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const g = getGame(route().id);
  switch (act) {
    case 'open-season':
      ui.report = { player: el.dataset.player || 'all', season: el.dataset.season || 'all', game: 'all' };
      break; // the link itself navigates
    case 'loc': {
      const loc = Number(el.dataset.loc);
      if (ui.sel.loc === loc) ui.sel = { zone: null, loc: null };
      else ui.sel = { loc, zone: defaultZoneForLoc(loc) };
      buzz(6); render(); break;
    }
    case 'zone':
      ui.sel.zone = ui.sel.zone === el.dataset.zone ? null : el.dataset.zone;
      buzz(6); render(); break;
    case 'result': {
      const r = el.dataset.r;
      if (r === 'IP') {
        if (!ui.sel.zone) { logPitch('IP'); return; } // shows the "pick a zone" prompt
        ui.ip = { contact: null, traj: null, spray: null };
        render();
      } else logPitch(r);
      break;
    }
    case 'ip-contact': case 'ip-traj': {
      const k = act.slice(3);
      ui.ip[k] = ui.ip[k] === el.dataset.v ? null : el.dataset.v;
      render(); break;
    }
    case 'ip-field': {
      const svg = el.querySelector('svg');
      if (!svg) break;
      ui.ip.spray = pointToField(svg, e);
      buzz(6); render(); break;
    }
    case 'ip-outcome': {
      const { contact, traj, spray } = ui.ip;
      logPitch('IP', { contact, traj, spray, outcome: el.dataset.v });
      break;
    }
    case 'ip-cancel': ui.ip = null; render(); break;
    case 'undo': {
      if (!g || !g.events.length) break;
      const ev = g.events.pop();
      persist();
      buzz(25);
      showToast(ev.type === 'end' ? 'Undid PA end' : `Undid ${RESULTS[ev.result].toLowerCase()}`, 1600);
      ui.sel = { zone: null, loc: null };
      render(); break;
    }
    case 'menu': ui.menu = true; render(); break;
    case 'close-menu': ui.menu = false; render(); break;
    case 'end-pa': {
      if (!g) break;
      g.events.push({ type: 'end', t: Date.now(), reason: el.dataset.reason });
      persist();
      ui.menu = false;
      showToast(PA_RESULTS[el.dataset.reason]);
      render(); break;
    }
    case 'delete-game': {
      const gg = getGame(el.dataset.id);
      if (gg && confirm(`Delete the game vs ${gg.opponent || 'opponent'} on ${fmtDate(gg.date)}? This can't be undone.`)) {
        db.games = db.games.filter((x) => x.id !== gg.id);
        persist(); go('#/');
      }
      break;
    }
    case 'heat-mode': ui.heat = el.dataset.v; render(); break;
    case 'heat-pick': { const i = Number(el.dataset.i); ui.heatPick = ui.heatPick === i ? null : i; render(); break; }
    case 'spray-pick': { const i = Number(el.dataset.i); ui.sprayPick = ui.sprayPick === i ? null : i; render(); break; }
    case 'csv': {
      if (!db.games.length) { showToast('No games to export yet'); break; }
      saveFile(`at-bat-log-pitches-${today()}.csv`, toCSV(db.games), 'text/csv');
      break;
    }
    case 'backup': doBackup(); break;
    case 'backup-later':
      db.prefs.backupSnoozeAt = loggedGames(); // ask again after the next game
      persist(); render(); break;
    case 'share-report':
      if (!ui.busy) { ui.busy = true; shareReport().catch(() => showToast('Could not share the report')).finally(() => { ui.busy = false; }); }
      break;
    case 'wipe':
      if (confirm('Erase every game and pitch on this phone? Download a backup first if you might want them.') && confirm('Really erase everything?')) {
        db = { version: 1, games: [], prefs: { lastPlayer: '' } };
        persist(); showToast('All data erased'); go('#/');
      }
      break;
    case 'install':
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; render(); }
      break;
    case 'buy': {
      const plan = CONFIG.pro.plans.find((p) => p.id === el.dataset.plan);
      if (plan && plan.url) location.href = plan.url;
      else showToast('Pro isn\'t on sale yet. Check back soon.', 3000);
      break;
    }
    case 'dev-pro':
      if (isLocal) { pro.devSetPro(el.dataset.v === '1'); render(); }
      break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.filter) {
    ui.report[t.dataset.filter] = t.value;
    if (t.dataset.filter !== 'game') ui.report.game = 'all';
    ui.heatPick = null; ui.sprayPick = null;
    if (route().id) history.replaceState(null, '', '#/report');
    render();
  } else if (t.id === 'restore' && t.files[0]) {
    t.files[0].text().then((text) => {
      const data = store.parseBackup(text);
      if (!confirm(`Replace the data on this phone with the backup (${data.games.length} games)?`)) return;
      db = data; db.prefs.backupGames = loggedGames(); persist(); showToast('Backup restored'); go('#/');
    }).catch((err) => showToast(`Restore failed: ${err.message}`, 4000));
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'restore-form') {
    e.preventDefault();
    if (ui.busy) return;
    ui.busy = true;
    const email = String(new FormData(e.target).get('email') || '');
    pro.restoreByEmail(email)
      .then((ok) => { showToast(ok ? 'Pro restored. Thank you!' : 'No active purchase found for that email', 3500); render(); })
      .catch((err) => showToast(err.message, 3500))
      .finally(() => { ui.busy = false; });
    return;
  }
  if (e.target.id !== 'game-form') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const player = String(fd.get('player') || '').trim();
  const opponent = String(fd.get('opponent') || '').trim();
  const date = String(fd.get('date') || today());
  const id = e.target.dataset.id;
  db.prefs.lastPlayer = player;
  if (id) {
    Object.assign(getGame(id), { player, opponent, date });
    persist(); go(`#/game/${id}`);
  } else {
    const g = { id: store.uid(), player, opponent, date, createdAt: Date.now(), events: [] };
    db.games.push(g);
    persist(); go(`#/game/${g.id}`);
  }
});

// Data changed in another tab: reload it.
window.addEventListener('storage', (e) => { if (e.key === 'atbatlog.v1') { db = store.load(); render(); } });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (route().view === 'settings') render(); });

// ---------- boot ----------
async function boot() {
  // Returning from checkout: ?session_id=cs_... (set as the Payment Link's success URL)
  const sessionId = new URLSearchParams(location.search).get('session_id');
  if (sessionId && pro.proEnabled()) {
    history.replaceState(null, '', `${location.pathname}#/pro`);
    try {
      const ok = await pro.activateFromSession(sessionId);
      showToast(ok ? 'Welcome to Pro. Thank you!' : 'We couldn\'t confirm that purchase yet', 4000);
    } catch (err) { showToast(err.message, 4000); }
  }
  render();
  store.requestPersistence();
  pro.refreshIfDue().then(() => { if (route().view === 'report' || route().view === 'pro') render(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}
boot();
