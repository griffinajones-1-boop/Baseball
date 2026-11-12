import * as store from './store.js';
import * as pro from './pro.js';
import { CONFIG } from './config.js';
import {
  RESULTS, ZONES, ZONE_LABELS, CONTACT, TRAJ, OUTCOMES, PA_RESULTS, GRID, MIN_N, HITS,
  replayGame, buildReport, buildInsights, buildTrends, gameLine,
  defaultZoneForLoc, locName, toCSV, scaleScore, PITCH_TYPES, buildHeat,
} from './stats.js';
import { fieldSVG, pointToField } from './field.js';
import { renderSummary, shareOrDownload } from './share.js';
import * as usage from './usage.js';
import { sendFeedback, flushFeedback } from './feedback.js';

let db = store.load();
db.players = db.players || {};
let installPrompt = null; // Android/desktop "install app" event
const ui = {
  sel: { zone: null, loc: null },
  pitchType: null, // optional: FB / BR / CH for the pitch being logged
  heatType: 'all',
  feedback: null, // { kind, sending } while the feedback sheet is open
  playerEdit: null, // name of the player being edited
  zoneHelp: false,
  ip: null, // in-play sheet state
  menu: false,
  report: { player: 'all', season: 'all', game: 'all' },
  player: { name: '', season: '' },
  heat: 'avg',
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
const profile = (name) => db.players[name] || {};
const batsOf = (name) => profile(name).bats || null;
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
  const ok = await saveFile(`bleacher-stats-backup-${today()}.json`, JSON.stringify(db, null, 1), 'application/json');
  if (!ok) return;
  usage.track('backup');
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
const backHeader = (title, href = '#/', right = '<span class="spacer"></span>') => `<header class="top"><a class="icon-btn" href="${href}" data-act="back" aria-label="Back">‹</a><h1>${title}</h1>${right}</header>`;

// ---------- modes ----------
// What each mode logs and shows. Data is never deleted when switching; only the screens change.
const MODES = {
  basic: {
    label: 'Basic', taps: 'One tap a pitch', level: 1,
    blurb: 'Just what happened: ball, strike, foul or in play. Box score, strikeouts, walks and swing-and-miss.',
    good: 'Great for younger kids or a first season.',
    zone: false, contact: false, traj: false, field: false, pitchType: false,
  },
  standard: {
    label: 'Standard', taps: 'Two taps a pitch', level: 2,
    blurb: 'Where the pitch was and what happened. Adds chase rate, hot and cold zones and a spray chart.',
    good: 'Recommended for most parents.',
    zone: true, contact: true, traj: false, field: true, pitchType: false,
  },
  advanced: {
    label: 'Advanced', taps: 'Two taps, plus optional extras', level: 3,
    blurb: 'Everything: pitch type and ball flight, count splits, pitch-type splits and every stat.',
    good: 'For stat lovers and hitting coaches.',
    zone: true, contact: true, traj: true, field: true, pitchType: true,
  },
};
// People who logged games before modes existed keep everything they had (Advanced).
const modeId = () => (MODES[db.prefs.mode] ? db.prefs.mode : db.games.length ? 'advanced' : 'standard');
const M = () => MODES[modeId()];
const lvl = () => M().level;
function setMode(id) {
  if (!MODES[id]) return;
  db.prefs.mode = id; persist();
}
function modeSeg(note = true) {
  const cur = modeId();
  return `<div class="segs modeseg" role="radiogroup" aria-label="Mode">${Object.entries(MODES).map(([id, m]) =>
    `<button type="button" class="seg ${id === cur ? 'sel' : ''}" role="radio" aria-checked="${id === cur}" data-act="set-mode" data-v="${id}">${m.label}</button>`).join('')}</div>
    ${note ? `<p class="hint mode-note"><b>${M().taps}.</b> ${M().blurb}</p>` : ''}`;
}

// ---------- add to home screen ----------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function platform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|GSA\//.test(ua);
  const android = /Android/.test(ua);
  if (inApp) return ios ? 'ios-inapp' : 'android-inapp';
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (android) return 'android';
  return window.matchMedia('(pointer: coarse)').matches ? 'other-mobile' : 'desktop';
}
const pitchesLogged = () => db.games.reduce((a, g) => a + g.events.filter((e) => e.type === 'pitch').length, 0);
// Offer install only on phones, only once there's something worth keeping, and not after "don't show again".
const installOffer = () => !isStandalone() && platform() !== 'desktop' && pitchesLogged() >= 3 && !db.prefs.installDismissed;

const SHARE_ICON = '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const PLUS_ICON = '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>';
const DOTS_ICON = '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';

function installSteps() {
  const p = platform();
  const host = esc(location.host);
  if (p === 'ios-inapp' || p === 'android-inapp') {
    return `<ol class="isteps">
      <li><span class="inum">1</span><span>You're inside another app's browser. Tap <b>⋯</b> (usually top right) and choose <b>Open in ${p === 'ios-inapp' ? 'Safari' : 'browser'}</b>.</span></li>
      <li><span class="inum">2</span><span>Then come back here and follow the steps for your phone.</span></li></ol>`;
  }
  if (p === 'ios-safari') {
    return `<ol class="isteps">
      <li><span class="inum">1</span><span>Tap the <b>Share</b> button ${SHARE_ICON} in Safari's toolbar.</span></li>
      <li><span class="inum">2</span><span>Scroll down and tap <b>Add to Home Screen</b> ${PLUS_ICON}</span></li>
      <li><span class="inum">3</span><span>Tap <b>Add</b>. Then open ${esc(CONFIG.appName)} from your home screen from now on.</span></li></ol>`;
  }
  if (p === 'ios-other') {
    return `<ol class="isteps">
      <li><span class="inum">1</span><span>Tap the <b>Share</b> button ${SHARE_ICON} (in Chrome it's at the top, next to the address).</span></li>
      <li><span class="inum">2</span><span>Tap <b>Add to Home Screen</b> ${PLUS_ICON}, then <b>Add</b>.</span></li>
      <li><span class="inum">3</span><span>Don't see it? Open <b>${host}</b> in Safari and add it from there.</span></li></ol>`;
  }
  if (installPrompt) {
    return `<button class="btn primary block" data-act="install">Install ${esc(CONFIG.appName)}</button>
      <p class="hint center">It adds an icon to your home screen. No app store needed.</p>`;
  }
  return `<ol class="isteps">
    <li><span class="inum">1</span><span>Tap the browser menu ${DOTS_ICON} (top right in Chrome).</span></li>
    <li><span class="inum">2</span><span>Tap <b>Install app</b> or <b>Add to Home screen</b>.</span></li>
    <li><span class="inum">3</span><span>Open ${esc(CONFIG.appName)} from your home screen from now on.</span></li></ol>`;
}

function viewInstallSheet() {
  const ios = platform().startsWith('ios');
  return `<div class="sheet-bg" data-act="install-close"></div>
  <div class="sheet install-sheet" role="dialog" aria-label="Add to home screen">
    <div class="sheet-head"><h2>Keep ${esc(CONFIG.appName)} on your home screen</h2><button class="link" data-act="install-close">Close</button></div>
    <ul class="ibenefits">
      <li><b>Keeps your games safe.</b> ${ios ? 'Safari can clear saved data from websites you haven\'t opened in about a week. Home-screen apps are exempt.' : 'Your browser is less likely to clear an installed app\'s data.'}</li>
      <li><b>Works at the field with no signal,</b> full screen, one tap to open.</li>
    </ul>
    ${installSteps()}
    <button class="link block-link" data-act="install-never">Don't show this again</button>
  </div>`;
}

// ---------- feedback ----------
const FEEDBACK_KINDS = [['bug', 'Something broke'], ['idea', 'Idea'], ['other', 'Other']];
function viewFeedbackSheet() {
  const f = ui.feedback;
  return `<div class="sheet-bg" data-act="feedback-close"></div>
  <div class="sheet" role="dialog" aria-label="Send feedback">
    <div class="sheet-head"><h2>Send feedback</h2><button class="link" data-act="feedback-close">Cancel</button></div>
    <form id="feedback-form" class="form fb-form">
      <div class="optrow three">${FEEDBACK_KINDS.map(([k, l]) => `<button type="button" class="opt ${f.kind === k ? 'sel' : ''}" data-act="feedback-kind" data-v="${k}">${l}</button>`).join('')}</div>
      <label>What's on your mind?<textarea name="message" required maxlength="2000" rows="5" placeholder="${f.kind === 'bug' ? 'What were you doing, and what went wrong?' : 'Anything helps: what you like, what\'s confusing, what\'s missing.'}"></textarea></label>
      <label>Email <span class="muted">(optional, if you'd like a reply)</span><input name="email" type="email" maxlength="120" autocomplete="email" placeholder="you@example.com"></label>
      <button class="btn primary huge" type="submit" ${f.sending ? 'disabled' : ''}>${f.sending ? 'Sending…' : 'Send'}</button>
      <p class="hint center">We also get your app version, mode and phone type, to help fix problems. Never your games or player names.</p>
    </form>
  </div>`;
}
function feedbackContext() {
  return [`v${CONFIG.version}`, `mode ${modeId()}`, platform(), isStandalone() ? 'installed' : 'browser', `${window.innerWidth}x${window.innerHeight}`].join(' · ');
}

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  return { view: view || 'home', id };
}
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', () => {
  const next = route().view;
  ui.feedback = null; ui.playerEdit = null; ui.zoneHelp = false;
  if (ui.lastView === 'game' && next === 'home' && installOffer() && !db.prefs.installShown) {
    db.prefs.installShown = true; persist(); ui.installSheet = true;
  }
  ui.ip = null; ui.menu = false; ui.sel = { zone: null, loc: null }; ui.pitchType = null; ui.countKey = '';
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
  else if (r.view === 'player') html = viewPlayer();
  else if (r.view === 'fix' && getGame(r.id)) html = viewFix(getGame(r.id));
  else if (r.view === 'summary' && getGame(r.id)) html = viewSummary(getGame(r.id));
  else if (r.view === 'help') html = viewHelp();
  else { html = viewHome(); r.view = 'home'; }
  const tabs = ['home', 'player', 'settings'].includes(r.view);
  if (tabs) html += tabBar(r.view);
  if (ui.installSheet && tabs) html += viewInstallSheet();
  if (ui.feedback) html += viewFeedbackSheet();
  if (ui.playerEdit != null && r.view === 'player') html += viewPlayerEdit();
  app.innerHTML = html + `<div id="toast" class="toast ${ui.toast ? 'show' : ''}" role="status" aria-live="polite">${esc(ui.toast || '')}</div>`;
  document.body.dataset.view = r.view;
  ui.lastView = r.view;
  document.body.dataset.tabs = tabs ? '1' : '0';
}

// ---------- tab bar ----------
const TAB_ICONS = {
  home: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  player: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};
function tabBar(active) {
  const tab = (id, href, label) => `<a class="tab ${active === id ? 'on' : ''}" href="${href}" ${active === id ? 'aria-current="page"' : ''}>
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">${TAB_ICONS[id]}</svg>${label}</a>`;
  return `<nav class="tabbar" aria-label="Main">${tab('home', '#/', 'Games')}${tab('player', '#/player', 'Player')}${tab('settings', '#/settings', 'Settings')}</nav>`;
}

// ---------- player page ----------
const PROFILE_STATS = {
  1: [['whiff', 'Swing and miss'], ['swStr', 'Misses per pitch'], ['kRate', 'Strikeout rate']],
  2: [['chase', 'Chase rate'], ['zoneSwing', 'Zone swing'], ['heartTake', 'Heart take'], ['whiff', 'Whiff rate'], ['hardHit', 'Hard-hit rate'], ['kRate', 'K rate']],
  3: [['chase', 'Chase rate'], ['zoneSwing', 'Zone swing'], ['heartTake', 'Heart take'], ['twoStrikeChase', 'Two-strike chase'],
    ['whiff', 'Whiff rate'], ['zoneContact', 'Zone contact'], ['swStr', 'Swinging strikes'], ['hardHit', 'Hard-hit rate'], ['kRate', 'K rate']],
};
function profileRow(key, label, m) {
  const t = scaleScore(key, m);
  const tiny = m.den < 5, small = m.small;
  const word = t == null ? '' : t >= 0.8 ? 'Great' : t >= 0.6 ? 'Good' : t > 0.4 ? 'Average' : t > 0.2 ? 'Below average' : 'Needs work';
  const note = !m.den ? 'no data yet' : tiny ? 'too few to rate' : small ? `early read: ${word.toLowerCase()}` : word.toLowerCase();
  const bar = t == null ? '<span class="meter"></span>'
    : `<span class="meter ${small ? 'is-small' : ''}" style="--t:${(t * 100).toFixed(0)}%;--c:${tiny ? 'var(--div-mid)' : scaleColor(t)}"><i></i><b></b></span>`;
  return `<div class="prow ${small ? 'is-small' : ''}"><span class="prow-label">${label}<small>${note}</small></span><span class="prow-val">${pct(m.value)}</span>${bar}</div>`;
}

function viewPlayer() {
  const ps = players();
  if (!db.games.length || !ps.length) {
    return `<main class="page"><header class="top"><h1>Player</h1></header>
      <section class="welcome"><h2>Nothing here yet</h2><p>Log a game and this page fills in with your player's season: the slash line, how they rate, where the pitches and the hits go.</p></section>
      <a class="btn primary huge" href="#/new">New game</a></main>`;
  }
  if (!ps.includes(ui.player.name)) ui.player = { name: sortedGames()[0].player || ps[0], season: '' };
  const mine = db.games.filter((g) => g.player === ui.player.name);
  const years = [...new Set(mine.map((g) => (g.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  if (!years.includes(ui.player.season)) ui.player.season = years[0] || '';
  const games = mine.filter((g) => (g.date || '').startsWith(ui.player.season));
  const rep = buildReport(games);
  const S = rep.stats, sl = rep.slash;
  const deep = pro.isPro();
  const count = (r) => rep.allPAs.filter((pa) => pa.result === r).length;
  const chips = ps.length > 1 ? `<div class="chips-row">${ps.map((n) => `<button class="chipbtn ${n === ui.player.name ? 'sel' : ''}" data-act="pick-player" data-player="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : '';
  const seasonPick = years.length > 1 ? `<select class="season-pick" data-player-season="1" aria-label="Season">${years.map((y) => `<option value="${y}" ${y === ui.player.season ? 'selected' : ''}>${y} season</option>`).join('')}</select>` : '';
  const recent = [...games].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt).slice(0, 5).map((g) => {
    const line = gameLine(replayGame(g).pas);
    return `<li class="row"><a class="row-main" href="#/report/${g.id}"><b>vs ${esc(g.opponent || 'Opponent')}</b><span class="muted">${esc(fmtDate(g.date, false))}${line ? ` · ${esc(line)}` : ''}</span></a><span class="chev">›</span></li>`;
  }).join('');
  const tile = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;

  return `<main class="page player">
    <header class="top"><h1>Player</h1>${rep.pitchCount ? '<button class="link share-btn" data-act="share-player">Share</button>' : ''}</header>
    ${chips}
    <section class="pl-head">
      <div class="pl-name"><h2>${esc(ui.player.name)}${profile(ui.player.name).number ? ` <span class="pl-num">#${esc(profile(ui.player.name).number)}</span>` : ''}</h2><button class="link" data-act="player-edit">Edit</button></div>
      ${batsOf(ui.player.name) ? `<p class="muted">Bats ${{ R: 'right', L: 'left', S: 'both sides' }[batsOf(ui.player.name)]}</p>` : '<p class="muted"><button class="link inline" data-act="player-edit">Add which side they bat from</button></p>'}
      <p class="muted">${years.length > 1 ? '' : `${esc(ui.player.season)} season · `}${games.length} game${games.length === 1 ? '' : 's'} · ${rep.paCount} PA · ${rep.pitchCount} pitches</p>
      ${seasonPick}
    </section>
    <div class="tiles big ${sl.small ? 'is-small' : ''}">${tile(rate3(sl.avg), 'AVG')}${tile(rate3(sl.obp), 'OBP')}${tile(rate3(sl.slg), 'SLG')}</div>
    <div class="tiles">${tile(sl.h, 'Hits')}${tile(count('HR'), 'HR')}${tile(sl.bb, 'BB')}${tile(count('K'), 'K')}</div>
    ${sl.small && sl.pa ? `<p class="hint center">Early in the season: only ${sl.pa} PA so far.</p>` : ''}

    ${deep && lvl() >= 2 && CONFIG.features.insights ? viewInsights(rep) : ''}

    <h2 class="section">How they rate</h2>
    <div class="card">
      <div class="scale-key in-card" aria-hidden="true"><span>Needs work</span><i></i><span>Great</span></div>
      ${PROFILE_STATS[lvl()].map(([k, l]) => profileRow(k, l, S[k])).join('')}
    </div>
    <p class="hint">A general guide for youth hitters, not a ranking against other players. Hollow markers are early reads.</p>

    ${lvl() < 2 ? '' : deep ? `
    <h2 class="section">Hot and cold zones</h2>
    ${viewHeat(rep, batsOf(ui.player.name))}
    ${lvl() >= 3 ? viewByType(rep) : ''}
    <h2 class="section">Where the ball goes</h2>
    ${viewSpray(rep, games)}` : viewUpsell()}

    <h2 class="section">Recent games</h2>
    <ul class="list">${recent}</ul>
    <a class="btn secondary block" href="#/report" data-act="open-season" data-player="${esc(ui.player.name)}" data-season="${esc(ui.player.season)}">Full season report</a>
  </main>`;
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
  return `<a class="season-card" href="#/player" data-act="open-player" data-player="${esc(latest.player)}" data-season="${esc(year)}">
    <span class="sc-top">${esc(latest.player || 'Season')} · ${esc(year)}<span>Player page ›</span></span>
    <span class="sc-stats">
      <span><b>${rate3(sl.avg)}</b>AVG</span>
      <span><b>${rate3(sl.obp)}</b>OBP</span>
      ${lvl() >= 2 ? `<span><b>${pct(rep.stats.chase.value)}</b>Chase</span>` : `<span><b>${pct(rep.stats.kRate.value)}</b>K rate</span>`}
      <span><b>${rep.paCount}</b>PA</span>
    </span>
  </a>`;
}

function viewHome() {
  const games = sortedGames();
  const many = players().length > 1;
  if (!games.length) {
    return `<main class="page">
      <header class="top"><h1>${esc(CONFIG.appName)}</h1></header>
      <section class="welcome compact">
        <img src="icons/icon.svg" alt="" width="56" height="56">
        <h2>Every pitch tells you something</h2>
        <p>Log your kid's at-bats pitch by pitch. See what they swing at, what they miss, and how it changes over the season.</p>
      </section>
      <p class="label">How much do you want to track?</p>
      <div class="modes">${Object.entries(MODES).map(([id, m]) => `<button class="modecard ${id === 'standard' ? 'rec' : ''}" data-act="choose-mode" data-v="${id}">
        <span class="mc-top"><b>${m.label}</b>${id === 'standard' ? '<span class="mc-tag">Recommended</span>' : ''}<span class="mc-taps">${m.taps}</span></span>
        <span class="mc-blurb">${m.blurb}</span></button>`).join('')}</div>
      <p class="hint center">You can switch anytime in Settings. Free. No account. Works without signal.</p>
    </main>`;
  }
  const list = games.map((g) => {
    const { pas, current } = replayGame(g);
    const live = current.pitches.length > 0 && !g.done;
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
    <header class="top"><h1>${esc(CONFIG.appName)}</h1></header>
    ${seasonCard()}
    <a class="btn primary huge" href="#/new">New game</a>
    ${installOffer() ? `<section class="nudge"><span><b>Add to your home screen</b><small>Keeps your games safe and works at the field with no signal.</small></span>
      <span class="nudge-actions"><button class="link" data-act="install-never">Not now</button><button class="btn primary" data-act="install-open">Show me how</button></span></section>`
    : backupDue() ? `<section class="nudge"><span><b>Back up your season</b><small>${loggedGames() - (db.prefs.backupGames || 0)} games since your last backup. They only live on this phone.</small></span>
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
      ${g ? '' : `<div class="form-field"><span class="form-label">Mode</span>${modeSeg()}</div>`}
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
  const m = M();
  let lastText = m.zone ? 'Tap where the pitch was, then what happened' : 'Tap what happened on each pitch';
  if (last && last.type === 'end') lastText = `PA ended · ${PA_RESULTS[last.reason]}`;
  else if (last) {
    const lp = pitches[pitches.length - 1];
    lastText = `${lp.balls}-${lp.strikes} ${RESULTS[lp.result]}${lp.result === 'IP' && lp.outcome ? ` · ${OUTCOMES[lp.outcome]}` : ''} ${lp.zone ? ` · ${ZONE_LABELS[lp.zone]}` : ''}${lp.pitch ? ` · ${PITCH_TYPES[lp.pitch]}` : ''}`;
  }
  const countKey = `${current.num}:${b}-${s}`;
  const pop = ui.countKey && ui.countKey !== countKey ? 'pop' : '';
  ui.countKey = countKey;

  const cells = Array.from({ length: GRID * GRID }, (_, i) => {
    const z = defaultZoneForLoc(i);
    return `<button class="cell z-${z} ${ui.sel.loc === i ? 'sel' : ''}" data-act="loc" data-loc="${i}" aria-label="${esc(locName(i, batsOf(g.player)))}"></button>`;
  }).join('');
  const zoneBtns = ZONES.map((z) => `<button class="zbtn ${ui.sel.zone === z ? 'sel' : ''}" data-act="zone" data-zone="${z}">${ZONE_LABELS[z]}</button>`).join('');
  const resBtns = [
    ['B', 'Ball'], ['CS', 'Called<br>strike'], ['SS', 'Swinging<br>strike'],
    ['F', 'Foul'], ['IP', 'In play'], ['HBP', 'HBP'],
  ].map(([k, label]) => `<button class="rbtn r-${k}" data-act="result" data-r="${k}">${label}</button>`).join('');

  return `<main class="live ${m.zone ? '' : 'basic'}">
    <header class="live-top">
      <a class="icon-btn" href="#/" aria-label="Back to games">‹</a>
      <div class="live-title">${esc(g.player || 'Batter')} <span class="muted">vs ${esc(g.opponent || 'Opp')}</span></div>
      <button class="icon-btn" data-act="menu" aria-label="Game menu">⋯</button>
    </header>
    ${g.done ? '<button class="done-banner" data-act="resume-game">This game is over. <b>Resume logging</b></button>' : ''}
    <section class="countbar" aria-label="Count ${b} balls ${s} strikes">
      <div class="count-num ${pop}">${b}–${s}</div>
      <div class="count-dots"><div>${dots(b, 3)}</div><div>${dots(s, 2)}</div></div>
      <div class="count-pa">PA ${current.num}<span>Pitch ${current.pitches.length + 1}</span></div>
    </section>
    ${m.zone ? `<section class="zone-wrap">
      <div class="locgrid" aria-label="Pitch location, catcher's view">${cells}<div class="sz-outline" aria-hidden="true"></div></div>
      <div class="zbtns" id="zbtns">${zoneBtns}</div>
    </section>` : ''}
    ${!m.pitchType || db.prefs.pitchTypes === false ? '' : `<section class="ptypes" aria-label="Pitch type, optional">${Object.entries(PITCH_TYPES).map(([k, v]) => `<button class="ptype ${ui.pitchType === k ? 'sel' : ''}" data-act="ptype" data-v="${k}">${v}</button>`).join('')}</section>`}
    <section class="laststrip">
      <span class="last-text">${esc(lastText)}</span>
      <button class="undo" data-act="undo" ${g.events.length ? '' : 'disabled'}>↶ Undo</button>
    </section>
    <section class="results">${resBtns}</section>
    ${ui.ip ? viewInPlay() : ''}
    ${ui.menu ? viewMenu(g, current) : ''}
    ${(ui.zoneHelp || (m.zone && !db.prefs.zoneHelpSeen && !ui.menu && !ui.ip)) ? viewZoneHelp() : ''}
  </main>`;
}

function viewMenu(g, current) {
  const { pas } = replayGame(g);
  const recent = [...pas].reverse().map((pa) => `<li><span>PA ${pa.num}</span>${esc(describePA(pa))}<span class="muted">${pa.pitches.length}p</span></li>`).join('');
  return `<div class="sheet-bg" data-act="close-menu"></div>
  <div class="sheet" role="dialog" aria-label="Game menu">
    <div class="sheet-head"><h2>${esc(g.player || 'Batter')} vs ${esc(g.opponent || 'Opp')}</h2><button class="link" data-act="close-menu">Done</button></div>
    <div class="optrow two menu-main">
      <button class="btn primary" data-act="end-game">End game</button>
      <a class="btn secondary" href="#/report/${g.id}">Game report</a>
    </div>
    <p class="label">End PA ${current.num} without a pitch</p>
    <div class="optrow two">
      <button class="opt" data-act="end-pa" data-reason="IBB">Intentional walk</button>
      <button class="opt" data-act="end-pa" data-reason="OTHER">Other</button>
    </div>
    <p class="hint">“Other” is for a runner out, game over, or a substitution. It isn't counted in the stats.</p>
    ${recent ? `<p class="label">This game</p><ol class="mini-log">${recent}</ol>` : ''}
    <div class="sheet-links"><a class="link" href="#/fix/${g.id}">Fix a pitch</a><a class="link" href="#/edit/${g.id}">Edit game</a>${M().zone ? '<button class="link" data-act="zone-help">Zones?</button>' : ''}</div>
    <div class="sheet-links quiet"><button class="link" data-act="feedback-open">Send feedback</button><a class="link" href="#/help">Help</a></div>
  </div>`;
}

function viewInPlay() {
  const ip = ui.ip;
  const m = M();
  const opt = (group, key, label) => `<button class="opt ${ip[group] === key ? 'sel' : ''}" data-act="ip-${group}" data-v="${key}">${label}</button>`;
  const dot = ip.spray ? `<circle class="spray-pick" cx="${ip.spray.x * 200}" cy="${ip.spray.y * 200}" r="6"/>` : '';
  return `<div class="sheet-bg"></div>
  <div class="sheet" role="dialog" aria-label="Ball in play">
    <div class="sheet-head"><h2>Ball in play</h2><button class="link" data-act="ip-cancel">Cancel</button></div>
    ${m.contact ? `<div class="optrow three">${CONTACT.map((c) => opt('contact', c, c[0].toUpperCase() + c.slice(1))).join('')}</div>` : ''}
    ${m.traj ? `<div class="optrow four">${Object.entries(TRAJ).map(([k, v]) => opt('traj', k, v.replace(' ball', '').replace('Line drive', 'Liner'))).join('')}</div>` : ''}
    ${m.field ? `<div class="field-input" data-act="ip-field">${fieldSVG(dot)}${ip.spray ? '' : '<span class="field-hint">Tap where it went</span>'}</div>` : ''}
    <p class="label">Result</p>
    <div class="optrow outcomes">${Object.keys(OUTCOMES).map((k) => `<button class="opt" data-act="ip-outcome" data-v="${k}">${k === 'OUT' ? 'Out' : k === 'E' ? 'Error' : k}</button>`).join('')}</div>
  </div>`;
}

function logPitch(result, extra = {}) {
  const g = getGame(route().id);
  if (!g) return false;
  const m = M();
  let zone = m.zone ? ui.sel.zone : null;
  if (m.zone && !zone && result === 'HBP') zone = 'waste';
  if (m.zone && !zone) {
    const zb = document.getElementById('zbtns');
    zb?.classList.remove('need'); void zb?.offsetWidth; zb?.classList.add('need');
    showToast('Pick a zone first', 1600);
    buzz(40);
    return false;
  }
  const before = replayGame(g).current.num;
  const firstPitch = !g.events.some((ev) => ev.type === 'pitch');
  g.events.push({ type: 'pitch', t: Date.now(), zone, loc: m.zone ? ui.sel.loc : null, result, ...(m.pitchType && ui.pitchType ? { pitch: ui.pitchType } : {}), ...extra });
  persist();
  if (firstPitch) {
    usage.track('game');
    const n = loggedGames();
    if (n === 1) usage.track('first_game');
    if (n === 3) usage.track('game3');
    if (n === 10) usage.track('game10');
  }
  ui.sel = { zone: null, loc: null };
  ui.pitchType = null;
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
    <span class="stat-label">${label}<small>${n}${small ? ` · ${t == null ? 'small sample' : tiny ? 'too few to rate' : `early read: ${word.toLowerCase()}`}` : t != null ? ` · ${word.toLowerCase()}` : ''}</small></span>
    <span class="stat-val">${fmt(m.value)}</span>${bar}</summary>
    <p class="stat-def">${def}</p></details>`;
}

const STAT_DEFS = {
  chase: ['Chase rate', 'Swings at Chase + Waste pitches ÷ Chase + Waste pitches.'],
  zoneSwing: ['Zone swing rate', 'Swings at Heart + Edge pitches ÷ Heart + Edge pitches.'],
  heartTake: ['Heart take rate', 'Heart pitches taken ÷ Heart pitches. Lower is better.'],
  firstPitchSwing: ['First-pitch swing', 'Swings at the first pitch of a PA ÷ first pitches.'],
  twoStrikeChase: ['Two-strike chase', 'Chase rate with two strikes.'],
  whiff: ['Whiff rate', 'Swinging strikes ÷ swings.'],
  zoneContact: ['Zone contact', 'Fouls + balls in play ÷ swings at Heart + Edge pitches.'],
  swStr: ['Swinging-strike rate', 'Swinging strikes ÷ all pitches.'],
  hardHit: ['Hard-hit rate', 'Hard contact ÷ balls in play.'],
  kRate: ['K rate', 'Strikeouts ÷ plate appearances.'],
  pPerPA: ['Pitches per PA', 'Average pitches seen per plate appearance.'],
};
// Plainer names in Basic mode.
const BASIC_NAMES = { whiff: 'Swing and miss', kRate: 'Strikeout rate', swStr: 'Misses per pitch', firstPitchSwing: 'Swings at first pitch' };
const REPORT_GROUPS = {
  1: [['Results', ['whiff', 'swStr', 'firstPitchSwing', 'kRate', 'pPerPA']]],
  2: [['Swing decisions', ['chase', 'zoneSwing', 'heartTake', 'firstPitchSwing']], ['Contact', ['whiff', 'hardHit']], ['Plate appearances', ['kRate', 'pPerPA']]],
  3: [['Swing decisions', ['chase', 'zoneSwing', 'heartTake', 'firstPitchSwing', 'twoStrikeChase']], ['Contact', ['whiff', 'zoneContact', 'swStr', 'hardHit']], ['Plate appearances', ['kRate', 'pPerPA']]],
};
const statName = (k) => (lvl() === 1 && BASIC_NAMES[k]) || STAT_DEFS[k][0];
function reportStats(S) {
  const num = (v) => (v == null ? '—' : v.toFixed(1));
  return REPORT_GROUPS[lvl()].map(([title, keys]) => `<h2 class="section">${title}</h2>
    <div class="stats">${keys.map((k) => statRow(k, statName(k), S[k], STAT_DEFS[k][1], k === 'pPerPA' ? num : pct)).join('')}</div>`).join('');
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

    ${!single && isPro && lvl() >= 2 && CONFIG.features.insights ? viewInsights(rep) : ''}

    <div class="scale-key" aria-hidden="true"><span>Needs work</span><i></i><span>Great</span></div>
    ${reportStats(S)}

    ${!single && isPro && lvl() >= 2 && CONFIG.features.trends ? viewTrends(games) : ''}
    ${lvl() < 2 ? '' : deep ? `
    ${lvl() >= 3 ? `${viewByType(rep)}
    <h2 class="section">By count</h2>
    ${viewSplits(rep.splits)}` : ''}
    <h2 class="section">Heat map</h2>
    ${viewHeat(rep, single ? batsOf(single.player) : f.player !== 'all' ? batsOf(f.player) : null)}
    <h2 class="section">Spray chart</h2>
    ${viewSpray(rep, games)}` : viewUpsell()}

    ${single ? `<div class="list-head"><h2 class="section">Pitch by pitch</h2><a class="link" href="#/fix/${single.id}">Fix a mistake</a></div>${viewPALog(rep.allPAs)}` : ''}
    <p class="footnote">“Early read” means there aren't many pitches behind a number yet, so it can swing a lot from game to game. The blue-to-red scale is a general guide for youth hitters, not a ranking against other players. Tap any stat for its definition.${lvl() >= 2 ? ' In zone = Heart + Edge.' : ''}</p>
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
    stats: lvl() >= 2
      ? [stat('Chase rate', S.chase), stat('Zone swing', S.zoneSwing), stat('Whiff rate', S.whiff), stat('Hard-hit rate', S.hardHit)]
      : [stat('Swing and miss', S.whiff), stat('Strikeout rate', S.kRate), stat('First-pitch swing', S.firstPitchSwing),
        { label: 'Pitches per PA', value: S.pPerPA.value == null ? '—' : S.pPerPA.value.toFixed(1), sub: `${S.pPerPA.den} PA`, small: S.pPerPA.small }],
    spray: lvl() >= 2 ? rep.spray : [],
    footer: `Made with ${CONFIG.appName} · ${location.host}`,
  });
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { showToast('Could not create the image'); return; }
  const slug = (single ? `${single.player}-vs-${single.opponent}-${single.date}` : `${who}-season`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const sent = await shareOrDownload(blob, `bleacher-stats-${slug || 'report'}.png`, CONFIG.appName);
  if (sent) usage.track('share');
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

// Blue (low) -> pale -> red (high) for batting average and hard contact by location.
function hotColdColor(t) {
  const [lo, mid, hi] = isDark() ? ['#3987e5', '#3a3a37', '#e66767'] : ['#2a78d6', '#e9e7e1', '#e34948'];
  return t < 0.5 ? mixHex(lo, mid, t * 2) : mixHex(mid, hi, (t - 0.5) * 2);
}
const HEAT_MODES = {
  avg: { label: 'AVG', hotCold: true, lo: 0.1, hi: 0.4, min: 'heatAB',
    get: (c) => ({ v: c.ab ? c.hits / c.ab : null, den: c.ab, text: c.ab ? rate3(c.hits / c.ab) : '' }) },
  hard: { label: 'Hard hit', hotCold: true, lo: 0.15, hi: 0.5, min: 'heatAB',
    get: (c) => ({ v: c.bip ? c.hard / c.bip : null, den: c.bip, text: c.bip ? pct(c.hard / c.bip) : '' }) },
  seen: { label: 'Pitches', min: 'heatCell', get: (c) => ({ v: c.seen || null, den: c.seen, text: c.seen ? String(c.seen) : '' }) },
  swing: { label: 'Swing', min: 'heatCell', get: (c) => ({ v: c.seen ? c.swings / c.seen : null, den: c.seen, text: c.seen ? pct(c.swings / c.seen) : '' }) },
  whiff: { label: 'Whiff', min: 'heatCell', get: (c) => ({ v: c.swings ? c.whiffs / c.swings : null, den: c.swings, text: c.swings ? pct(c.whiffs / c.swings) : '' }) },
};

function viewHeat(rep, bats = null) {
  const keys = Object.keys(HEAT_MODES).filter((k) => lvl() >= 3 || ['avg', 'hard', 'seen'].includes(k));
  const mode = keys.includes(ui.heat) ? ui.heat : 'avg';
  const M = HEAT_MODES[mode];
  const cw = 44, ch = 50, gap = 2;
  if (ui.heatType !== 'all' && (!rep.typed || lvl() < 3)) ui.heatType = 'all';
  const src = ui.heatType === 'all' ? rep : buildHeat(rep.pitches.filter((p) => p.pitch === ui.heatType));
  const vals = src.heat.map(M.get);
  const max = mode === 'seen' ? Math.max(1, ...vals.map((x) => x.v || 0)) : 1;
  const any = vals.some((x) => x.v != null);
  const cells = vals.map((x, i) => {
    const r = Math.floor(i / GRID), c = i % GRID;
    const t = x.v == null ? null : M.hotCold ? Math.min(1, Math.max(0, (x.v - M.lo) / (M.hi - M.lo))) : x.v / max;
    const small = x.den < MIN_N[M.min];
    const fill = t == null ? 'var(--heat-empty)' : M.hotCold ? hotColdColor(t) : heatColor(t);
    const strong = t != null && (M.hotCold ? Math.abs(t - 0.5) > 0.28 : t > 0.55);
    return `<g class="hcell ${strong ? (M.hotCold ? 'hotw' : 'hot') : ''} ${small && x.den ? 'small' : ''} ${ui.heatPick === i ? 'picked' : ''}" data-act="heat-pick" data-i="${i}">
      <rect x="${c * cw + gap / 2}" y="${r * ch + gap / 2}" width="${cw - gap}" height="${ch - gap}" rx="4" fill="${fill}"/>
      <text x="${c * cw + cw / 2}" y="${r * ch + ch / 2 + 5}" text-anchor="middle">${x.text}</text></g>`;
  }).join('');
  const pick = ui.heatPick != null ? src.heat[ui.heatPick] : null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : (w.endsWith('h') ? 'es' : 's')}`;
  const caption = pick
    ? `<b>${esc(locName(ui.heatPick, bats))}</b>: ${plural(pick.seen, 'pitch')}, ${plural(pick.swings, 'swing')}, ${plural(pick.whiffs, 'whiff')}${pick.ab ? ` · ${pick.hits}-for-${pick.ab} (${rate3(pick.hits / pick.ab)})` : ''}${pick.bip ? ` · ${pick.hard} of ${pick.bip} hit hard` : ''}`
    : !any && M.hotCold ? 'No at-bats have ended on a located pitch yet.' : 'Catcher’s view. Tap a box for details.';
  const tab = (k) => `<button class="seg ${mode === k ? 'sel' : ''}" data-act="heat-mode" data-v="${k}">${HEAT_MODES[k].label}</button>`;
  const key = M.hotCold
    ? `<div class="scale-key heat-key" aria-hidden="true"><span>${mode === 'avg' ? rate3(M.lo) : pct(M.lo)}</span><i class="hotcold"></i><span>${mode === 'avg' ? rate3(M.hi) : pct(M.hi)}</span></div>` : '';
  const explain = mode === 'avg' ? 'Batting average on at-bats that ended on a pitch in each spot (balls in play and strike three).'
    : mode === 'hard' ? 'Share of balls in play from each spot that were hit hard.' : '';
  const typeChips = !rep.typed || lvl() < 3 ? '' : `<div class="chips-row tight">${[['all', 'All pitches'], ...Object.entries(PITCH_TYPES)].map(([k, v]) => `<button class="chipbtn small ${ui.heatType === k ? 'sel' : ''}" data-act="heat-type" data-v="${k}">${v}</button>`).join('')}</div>`;
  return `<div class="segs">${keys.map(tab).join('')}</div>${typeChips}
    <div class="heat-wrap"><svg class="heat" viewBox="0 0 ${cw * GRID} ${ch * GRID}" role="img" aria-label="Zone heat map, catcher's view">
      ${cells}<rect class="sz" x="${cw}" y="${ch}" width="${cw * 3}" height="${ch * 3}" rx="3"/></svg>
      ${bats === 'R' || bats === 'L' ? `<div class="heat-dir"><span>← ${bats === 'R' ? 'Inside' : 'Away'}</span><span>${bats === 'R' ? 'Away' : 'Inside'} →</span></div>` : ''}${key}</div>
    <p class="hint heat-caption">${caption}</p>
    ${explain ? `<p class="hint center">${explain} Faded boxes have fewer than ${MIN_N.heatAB}.</p>` : ''}
    ${src.noLoc ? `<p class="hint center">${src.noLoc} pitch${src.noLoc === 1 ? '' : 'es'} logged without a location</p>` : ''}`;
}

function viewByType(rep) {
  if (!rep.typed) return '';
  const cell = (m, fmt = pct) => `<td class="${m.small ? 'is-small' : ''}">${fmt(m.value)}<small>${m.den ? `${m.num}/${m.den}` : ''}</small></td>`;
  const rows = Object.entries(rep.byType).map(([k, t]) => `<tr><th>${k === 'NA' ? 'Not marked' : PITCH_TYPES[k]}<small>${t.pitches} pitch${t.pitches === 1 ? '' : 'es'}</small></th>${cell(t.swing)}${cell(t.whiff)}${cell(t.chase)}${cell(t.avg, rate3)}${cell(t.hard)}</tr>`).join('');
  return `<h2 class="section">By pitch type</h2>
    <div class="table-wrap"><table class="splits">
    <thead><tr><th>Pitch</th><th>Swing</th><th>Whiff</th><th>Chase</th><th>AVG</th><th>Hard hit</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint">AVG counts at-bats that ended on that pitch. Faded numbers are small samples.</p>`;
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
    <span class="seq">${pa.pitches.map((p) => `<i class="pc r-${p.result}" title="${esc(RESULTS[p.result])} · ${esc(ZONE_LABELS[p.zone])}${p.pitch ? ` · ${PITCH_TYPES[p.pitch]}` : ''}">${code[p.result]}</i>`).join('')}</span>
    ${(() => { const lp = pa.pitches[pa.pitches.length - 1]; return lp && lp.result === 'IP' ? `<small>${esc([lp.contact, lp.traj && TRAJ[lp.traj].toLowerCase()].filter(Boolean).join(' '))}</small>` : ''; })()}
  </li>`).join('')}</ol>
  <p class="hint">B ball · K called strike · S swinging strike · F foul · X in play · H hit by pitch</p>`;
}

// ---------- fix a pitch ----------
const FIX_RESULTS = ['B', 'CS', 'SS', 'F', 'HBP'];
function viewFix(g) {
  const { pas, current } = replayGame(g);
  const all = current.pitches.length ? [...pas, current] : pas;
  const pitchRow = (p) => {
    const sel = p.result === 'IP'
      ? `<select data-fix-outcome="${p.idx}" aria-label="Result">${Object.entries(OUTCOMES).map(([k, v]) => `<option value="${k}" ${p.outcome === k ? 'selected' : ''}>In play: ${v}</option>`).join('')}</select>`
      : `<select data-fix-result="${p.idx}" aria-label="Pitch result">${FIX_RESULTS.map((k) => `<option value="${k}" ${p.result === k ? 'selected' : ''}>${RESULTS[k]}</option>`).join('')}</select>`;
    return `<li class="fix-row"><span class="fix-c">${p.balls}-${p.strikes}</span>${sel}<span class="fix-z muted">${p.zone ? ZONE_LABELS[p.zone] : ''}</span>
      <button class="icon-btn small" data-act="fix-delete" data-idx="${p.idx}" aria-label="Delete pitch">✕</button></li>`;
  };
  const body = all.map((pa) => `<section class="fix-pa">
    <h3>PA ${pa.num} <span class="muted">${pa.result ? esc(describePA(pa)) : 'in progress'}</span></h3>
    <ol class="fix-list">${pa.pitches.map(pitchRow).join('')}
    ${pa.endIdx != null ? `<li class="fix-row"><span class="fix-c"></span><span class="fix-end">Ended: ${esc(PA_RESULTS[pa.result])}</span><span></span><button class="icon-btn small" data-act="fix-delete" data-idx="${pa.endIdx}" aria-label="Remove">✕</button></li>` : ''}</ol>
  </section>`).join('');
  return `<main class="page">
    ${backHeader('Fix a pitch', `#/game/${g.id}`)}
    <p class="hint">Change a pitch's result or delete it. The count and at-bats recalculate, so later pitches may move into a different at-bat.</p>
    ${body || '<p class="empty">No pitches yet.</p>'}
  </main>`;
}

// ---------- end of game ----------
function viewSummary(g) {
  const rep = buildReport([g]);
  const S = rep.stats;
  const line = gameLine(rep.allPAs);
  const hits = rep.allPAs.filter((pa) => HITS.has(pa.result));
  const rank = { HR: 4, '3B': 3, '2B': 2, '1B': 1 };
  const best = [...hits].sort((a, b) => rank[b.result] - rank[a.result])[0];
  const longest = [...rep.allPAs].sort((a, b) => b.pitches.length - a.pitches.length)[0];
  const swings = rep.pitches.filter((p) => ['SS', 'F', 'IP'].includes(p.result)).length;
  const moment = best
    ? `${describePA(best)} in PA ${best.num}${(() => { const lp = best.pitches[best.pitches.length - 1]; return lp ? ` on a ${lp.balls}-${lp.strikes} pitch` : ''; })()}`
    : longest && longest.pitches.length >= 5 ? `A ${longest.pitches.length}-pitch battle in PA ${longest.num}` : '';
  const tile = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  return `<main class="page summary">
    ${backHeader('Game over', '#/')}
    <section class="sum-card">
      <span class="sum-who">${esc(g.player || 'Batter')} vs ${esc(g.opponent || 'Opponent')} · ${esc(fmtDate(g.date, false))}</span>
      <span class="sum-line">${esc(line || 'No completed at-bats')}</span>
      ${moment ? `<span class="sum-moment">Best moment: ${esc(moment)}</span>` : ''}
    </section>
    <div class="tiles">${tile(rep.paCount, 'PA')}${tile(rep.pitchCount, 'Pitches')}${tile(swings, 'Swings')}${tile(pct(S.whiff.value), 'Miss rate')}</div>
    <button class="btn primary huge" data-act="share-summary" data-id="${g.id}">Share this game</button>
    <a class="btn secondary block" href="#/report/${g.id}">Full game report</a>
    <a class="btn secondary block" href="#/">Back to games</a>
    <p class="hint center"><button class="link" data-act="resume-game" data-id="${g.id}">Resume logging this game</button></p>
  </main>`;
}

// ---------- players ----------
function viewPlayerEdit() {
  const name = ui.playerEdit;
  const pr = profile(name);
  const opt = (v, l) => `<button type="button" class="seg ${pr.bats === v ? 'sel' : ''}" data-act="pe-bats" data-v="${v}">${l}</button>`;
  return `<div class="sheet-bg" data-act="pe-close"></div>
  <div class="sheet" role="dialog" aria-label="Edit player">
    <div class="sheet-head"><h2>Edit player</h2><button class="link" data-act="pe-close">Cancel</button></div>
    <form id="player-form" class="form">
      <label>Name<input name="name" required maxlength="40" autocomplete="off" value="${esc(name)}"></label>
      <div class="form-field"><span class="form-label">Bats</span><div class="segs">${opt('R', 'Right')}${opt('L', 'Left')}${opt('S', 'Both')}</div>
        <p class="hint">Lets the heat map say inside and away instead of left and right.</p></div>
      <label>Jersey number <span class="muted">(optional)</span><input name="number" maxlength="3" inputmode="numeric" value="${esc(pr.number || '')}"></label>
      <button class="btn primary huge" type="submit">Save</button>
    </form>
  </div>`;
}
function savePlayer(oldName, { name, number, bats }) {
  const pr = { ...profile(oldName), number: number || undefined, bats: bats || profile(oldName).bats };
  if (name !== oldName) {
    const merging = players().includes(name);
    if (merging && !confirm(`${name} already exists. Combine ${oldName}'s games into ${name}?`)) return false;
    for (const g of db.games) if (g.player === oldName) g.player = name;
    delete db.players[oldName];
    if (db.prefs.lastPlayer === oldName) db.prefs.lastPlayer = name;
    db.players[name] = merging ? { ...pr, ...profile(name) } : pr;
  } else db.players[name] = pr;
  persist();
  ui.player.name = name;
  return true;
}

// ---------- zone explainer ----------
function viewZoneHelp() {
  const z = (cls, label, text) => `<li><i class="zh-sw ${cls}"></i><span><b>${label}</b> ${text}</span></li>`;
  const cells = Array.from({ length: 25 }, (_, i) => `<i class="cell z-${defaultZoneForLoc(i)}"></i>`).join('');
  return `<div class="sheet-bg" data-act="zone-help-close"></div>
  <div class="sheet" role="dialog" aria-label="How zones work">
    <div class="sheet-head"><h2>How the zones work</h2><button class="link" data-act="zone-help-close">Close</button></div>
    <div class="zh-wrap"><div class="zh-grid" aria-hidden="true">${cells}<span class="sz-outline"></span></div>
      <ul class="zh-list">
        ${z('z-heart', 'Heart:', 'middle of the zone. The pitches to hit.')}
        ${z('z-edge', 'Edge:', 'the rest of the strike zone, near the corners.')}
        ${z('z-chase', 'Chase:', 'just off the plate. Tempting, but a ball.')}
        ${z('z-waste', 'Waste:', 'way off. Nobody should swing.')}
      </ul></div>
    <p class="zh-tip">Tap where the pitch crossed the plate, <b>as the catcher sees it</b>. We pick the zone for you; tap a zone button to change it. Close enough is fine.</p>
    <button class="btn primary huge" data-act="zone-help-close">Got it</button>
  </div>`;
}

// ---------- help ----------
function viewHelp() {
  const q = (title, body) => `<details class="help-q"><summary>${title}</summary><div>${body}</div></details>`;
  const stats = Object.values(STAT_DEFS).map(([name, def]) => `<li><b>${name}</b>: ${def}</li>`).join('');
  return `<main class="page help">
    ${backHeader('How it works', '#/settings')}
    <h2 class="section">Logging</h2>
    ${q('How do I log a pitch?', '<p>In Standard and Advanced, tap where the pitch was on the grid (as the catcher sees it), then what happened. In Basic, just tap what happened. The count, walks, strikeouts and the end of each at-bat happen on their own.</p>')}
    ${q('I tapped the wrong thing', '<p>Tap <b>Undo</b> to remove the last pitch. For an older pitch, open ⋯ and choose <b>Fix a pitch</b> to change or delete any pitch in the game.</p>')}
    ${q('What are Heart, Edge, Chase and Waste?', '<p><b>Heart</b> is the middle of the zone, <b>Edge</b> is the rest of the strike zone, <b>Chase</b> is just off the plate and <b>Waste</b> is way off. Swinging at Heart pitches and laying off Chase and Waste is what good hitters do.</p>')}
    ${q('The at-bat ended without a pitch', '<p>Open ⋯ and choose <b>Intentional walk</b> or <b>Other</b> (a runner out, game over, a substitution). “Other” isn\'t counted in the stats.</p>')}
    ${q('When the game is over', '<p>Open ⋯ and tap <b>End game</b> for a summary you can share. You can resume a game later if you ended it by mistake.</p>')}
    ${q('Which mode should I use?', '<p><b>Basic</b> is one tap a pitch, great for younger kids. <b>Standard</b> adds where the pitch was and is right for most parents. <b>Advanced</b> adds pitch type and ball flight. Change it anytime in Settings; nothing is deleted.</p>')}
    ${q('Can I log a game from video?', '<p>Yes. Start a new game with the date it was played and log while you watch.</p>')}
    <h2 class="section">The numbers</h2>
    ${q('What does each stat mean?', `<ul class="help-list">${stats}</ul>`)}
    ${q('What do the colors mean?', '<p>Sliders run from blue (needs work) to red (great). They\'re a general guide for youth hitters, not a ranking against other players. Hollow markers and faded numbers are “early reads”: too few pitches to trust yet.</p>')}
    ${q('Inside and away', '<p>On the Player page, tap <b>Edit</b> and choose which side your kid bats from. The heat map then says inside and away instead of left and right.</p>')}
    ${q('Why is the heat map mostly empty?', '<p>Each box needs a few at-bats ending there before it means much. It fills in over a season.</p>')}
    <h2 class="section">Your data</h2>
    ${q('Where are my games stored?', '<p>Only on this phone. Nothing about your kid is uploaded. That also means deleting the app or clearing browser data erases them, so save a backup in Settings now and then.</p>')}
    ${q('Moving to a new phone', '<p>On the old phone: Settings → <b>Download backup</b>, and send the file to yourself. On the new phone: open the app, then Settings → <b>Restore from backup</b>.</p>')}
    ${q('Adding it to your home screen', '<p>It keeps your games safe and works with no signal. Settings → <b>Add to home screen</b> shows the steps for your phone.</p>')}
    <p class="hint center">Still stuck? <button class="link" data-act="feedback-open">Send feedback</button></p>
  </main>`;
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
  const install = isStandalone() ? '<p class="hint">Installed on this phone.</p>'
    : '<button class="btn secondary block" data-act="install-open">Add to home screen</button>';
  return `<main class="page"><header class="top"><h1>Settings</h1></header>
    ${proRow}
    <a class="row-link fb-row" href="#/help"><span><b>How it works</b><small>Logging, what the stats mean, your data</small></span><span class="chev">›</span></a>
    <button class="row-link fb-row" data-act="feedback-open"><span><b>Send feedback</b><small>Something broken, confusing or missing? Tell us.</small></span><span class="chev">›</span></button>
    <h2 class="section">Mode</h2>
    ${modeSeg()}
    <p class="hint">Switching never deletes anything. It only changes what you log and what the reports show.</p>
    ${M().pitchType ? `<label class="toggle"><span><b>Track pitch type</b><small>Adds an optional Fastball / Breaking / Changeup row while logging</small></span>
      <input type="checkbox" id="pref-ptypes" ${db.prefs.pitchTypes === false ? '' : 'checked'}></label>` : ''}
    <h2 class="section">Your data</h2>
    <p class="muted small">${db.games.length} game${db.games.length === 1 ? '' : 's'} · ${n} pitches, stored only on this phone.</p>
    <button class="btn secondary block" data-act="csv">Export all pitches (CSV)</button>
    <button class="btn secondary block" data-act="backup">Download backup</button>
    <label class="btn secondary block file-btn">Restore from backup<input type="file" accept="application/json,.json" id="restore"></label>
    <p class="hint">${db.prefs.backupAt ? `Last backup: ${new Date(db.prefs.backupAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}. ` : ''}Save a backup now and then (email it to yourself or keep it in Files). Clearing browser data or removing the app erases the log.</p>
    <h2 class="section">App</h2>
    ${install}
    <label class="toggle"><span><b>Share anonymous usage counts</b><small>Counts like "the app was opened today" or "a game was started". No games, names or IDs.</small></span>
      <input type="checkbox" id="pref-usage" ${db.prefs.usage === false ? '' : 'checked'}></label>
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
    case 'back': // return to wherever the person came from; the href is the fallback
      if (history.length > 1) { e.preventDefault(); history.back(); }
      break;
    case 'open-player':
      ui.player = { name: el.dataset.player || '', season: el.dataset.season || '' };
      break; // the link itself navigates
    case 'pick-player':
      ui.player = { name: el.dataset.player, season: '' }; ui.heatPick = null; ui.sprayPick = null;
      render(); break;
    case 'share-player':
      ui.report = { player: ui.player.name, season: ui.player.season, game: 'all' };
      if (!ui.busy) { ui.busy = true; shareReport().catch(() => showToast('Could not share the report')).finally(() => { ui.busy = false; }); }
      break;
    case 'open-season':
      ui.report = { player: el.dataset.player || 'all', season: el.dataset.season || 'all', game: 'all' };
      break; // the link itself navigates
    case 'loc': {
      const loc = Number(el.dataset.loc);
      if (ui.sel.loc === loc) ui.sel = { zone: null, loc: null };
      else ui.sel = { loc, zone: defaultZoneForLoc(loc) };
      buzz(6); render(); break;
    }
    case 'end-game': {
      if (!g) break;
      const cur = replayGame(g).current;
      if (cur.pitches.length) {
        if (!confirm(`End the game? The at-bat in progress (${cur.balls}-${cur.strikes}) will be ended with no result.`)) break;
        g.events.push({ type: 'end', t: Date.now(), reason: 'OTHER' });
      }
      g.done = true; persist(); usage.track('game_done');
      ui.menu = false; go(`#/summary/${g.id}`); break;
    }
    case 'resume-game': {
      const gg = getGame(el.dataset.id || route().id);
      if (!gg) break;
      gg.done = false; persist();
      if (route().view === 'game') render(); else go(`#/game/${gg.id}`);
      break;
    }
    case 'share-summary':
      ui.report = { player: getGame(el.dataset.id).player || 'all', season: 'all', game: el.dataset.id };
      if (!ui.busy) { ui.busy = true; shareReport().catch(() => showToast('Could not share the game')).finally(() => { ui.busy = false; }); }
      break;
    case 'fix-delete': {
      const gg = getGame(route().id);
      const idx = Number(el.dataset.idx);
      if (!gg || !gg.events[idx]) break;
      if (!confirm(gg.events[idx].type === 'end' ? 'Remove this at-bat ending?' : 'Delete this pitch?')) break;
      gg.events.splice(idx, 1); persist(); showToast('Deleted. Counts recalculated.'); render(); break;
    }
    case 'zone-help': ui.menu = false; ui.zoneHelp = true; render(); break;
    case 'zone-help-close': ui.zoneHelp = false; db.prefs.zoneHelpSeen = true; persist(); render(); break;
    case 'player-edit': ui.playerEdit = ui.player.name; render(); break;
    case 'pe-close': ui.playerEdit = null; render(); break;
    case 'pe-bats': {
      const form = document.getElementById('player-form');
      const vals = { name: form.elements.name.value, number: form.elements.number.value };
      db.players[ui.playerEdit] = { ...profile(ui.playerEdit), bats: el.dataset.v }; persist(); render();
      const f2 = document.getElementById('player-form').elements;
      f2.name.value = vals.name; f2.number.value = vals.number;
      break;
    }
    case 'choose-mode':
      setMode(el.dataset.v); usage.track(`start_${el.dataset.v}`); go('#/new'); break;
    case 'feedback-open': ui.menu = false; ui.feedback = { kind: 'other', sending: false }; render(); break;
    case 'feedback-close': ui.feedback = null; render(); break;
    case 'feedback-kind': {
      const msg = document.querySelector('#feedback-form textarea')?.value || '';
      const email = document.querySelector('#feedback-form input[name=email]')?.value || '';
      ui.feedback.kind = el.dataset.v; render();
      document.querySelector('#feedback-form textarea').value = msg;
      document.querySelector('#feedback-form input[name=email]').value = email;
      break;
    }
    case 'set-mode':
      setMode(el.dataset.v); buzz(6); render(); break;
    case 'ptype':
      ui.pitchType = ui.pitchType === el.dataset.v ? null : el.dataset.v;
      buzz(6); render(); break;
    case 'heat-type': ui.heatType = el.dataset.v; ui.heatPick = null; render(); break;
    case 'zone':
      ui.sel.zone = ui.sel.zone === el.dataset.zone ? null : el.dataset.zone;
      buzz(6); render(); break;
    case 'result': {
      const r = el.dataset.r;
      if (r === 'IP') {
        if (M().zone && !ui.sel.zone) { logPitch('IP'); return; } // shows the "pick a zone" prompt
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
      saveFile(`bleacher-stats-pitches-${today()}.csv`, toCSV(db.games), 'text/csv');
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
        db = { version: 1, games: [], players: {}, prefs: { lastPlayer: '' } };
        persist(); showToast('All data erased'); go('#/');
      }
      break;
    case 'install-open': ui.installSheet = true; render(); break;
    case 'install-close': ui.installSheet = false; render(); break;
    case 'install-never':
      db.prefs.installDismissed = true; persist(); ui.installSheet = false; render(); break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice?.then((c) => { if (c.outcome === 'accepted') { ui.installSheet = false; render(); } });
        installPrompt = null; render();
      }
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
  if (t.dataset.fixResult || t.dataset.fixOutcome) {
    const gg = getGame(route().id);
    const idx = Number(t.dataset.fixResult || t.dataset.fixOutcome);
    if (gg && gg.events[idx]) {
      if (t.dataset.fixResult) gg.events[idx].result = t.value; else gg.events[idx].outcome = t.value;
      persist(); showToast('Updated. Counts recalculated.'); render();
    }
  } else if (t.id === 'pref-usage') {
    db.prefs.usage = t.checked; persist();
    if (!t.checked) usage.clearQueue();
  } else if (t.id === 'pref-ptypes') {
    db.prefs.pitchTypes = t.checked; persist();
  } else if (t.dataset.playerSeason) {
    ui.player.season = t.value; ui.heatPick = null; ui.sprayPick = null; render();
  } else if (t.dataset.filter) {
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
  if (e.target.id === 'player-form') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    if (!name) return;
    if (savePlayer(ui.playerEdit, { name, number: String(fd.get('number') || '').trim(), bats: profile(ui.playerEdit).bats })) {
      ui.playerEdit = null; showToast('Player saved'); render();
    }
    return;
  }
  if (e.target.id === 'feedback-form') {
    e.preventDefault();
    if (!ui.feedback || ui.feedback.sending) return;
    const fd = new FormData(e.target);
    const message = String(fd.get('message') || '').trim();
    if (!message) return;
    ui.feedback.sending = true; render();
    sendFeedback({ kind: ui.feedback.kind, message, email: String(fd.get('email') || '').trim(), context: feedbackContext() })
      .then((r) => {
        ui.feedback = null;
        usage.track('feedback');
        showToast(r === 'sent' ? 'Thanks! Your feedback was sent.' : 'Saved. It will send when you\'re back online.', 3500);
        render();
      });
    return;
  }
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
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (ui.installSheet || route().view === 'settings') render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; ui.installSheet = false; showToast('Installed. Open it from your home screen.', 3500); render(); });

// ---------- boot ----------
// Games carried over from the old web address (see moved/index.html).
async function importFromHash() {
  const m = location.hash.match(/^#import=([gr])([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', `${location.pathname}#/`);
  try {
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let text;
    if (m[1] === 'g') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else text = new TextDecoder().decode(bytes);
    const incoming = store.parseBackup(text);
    const have = new Set(db.games.map((g) => g.id));
    const added = incoming.games.filter((g) => !have.has(g.id));
    db.games.push(...added);
    db.prefs = { ...incoming.prefs, ...db.prefs, mode: db.prefs.mode || incoming.prefs.mode };
    persist();
    showToast(added.length ? `Moved ${added.length} game${added.length === 1 ? '' : 's'} to the new address` : 'Your games are already here', 4000);
  } catch (e) {
    console.error(e);
    showToast('Could not move your games. Use a backup file instead.', 5000);
  }
}

async function boot() {
  await importFromHash();
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
  usage.configure({ isEnabled: () => db.prefs.usage !== false });
  usage.trackOpen(isStandalone());
  usage.flush();
  flushFeedback();
  pro.refreshIfDue().then(() => { if (route().view === 'report' || route().view === 'pro') render(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}
boot();
