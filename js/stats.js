// Pure logic: count replay, plate-appearance building and report stats.
// No DOM access here so it can be unit-tested in Node.

export const RESULTS = {
  B: 'Ball',
  CS: 'Called strike',
  SS: 'Swinging strike',
  F: 'Foul',
  IP: 'In play',
  HBP: 'Hit by pitch',
};
export const ZONES = ['heart', 'edge', 'chase', 'waste'];
export const ZONE_LABELS = { heart: 'Heart', edge: 'Edge', chase: 'Chase', waste: 'Waste' };
export const CONTACT = ['weak', 'medium', 'hard'];
export const TRAJ = { GB: 'Ground ball', LD: 'Line drive', FB: 'Fly ball', PU: 'Popup' };
export const OUTCOMES = { OUT: 'Out', '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'Home run', E: 'Error' };
export const PA_RESULTS = {
  K: 'Strikeout', BB: 'Walk', IBB: 'Intentional walk', HBP: 'Hit by pitch',
  OUT: 'Out in play', '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'Home run',
  E: 'Reached on error', OTHER: 'Ended (no result)',
};

// Pitches needed behind a stat before we stop flagging it as a small sample.
export const MIN_N = {
  chase: 25, zoneSwing: 25, heartTake: 15, firstPitchSwing: 10, whiff: 20,
  zoneContact: 15, swStr: 30, twoStrikeChase: 15, kRate: 15, pPerPA: 10,
  slash: 15, hardHit: 10, split: 15, heatCell: 5,
};

export const isSwing = (r) => r === 'SS' || r === 'F' || r === 'IP';
export const inZone = (z) => z === 'heart' || z === 'edge';
export const outZone = (z) => z === 'chase' || z === 'waste';
export const HITS = new Set(['1B', '2B', '3B', 'HR']);
const TB = { '1B': 1, '2B': 2, '3B': 3, HR: 4 };

// Location grid: 5x5, catcher's view. Inner 3x3 (rows/cols 1-3) is the strike zone.
export const GRID = 5;
export function locRC(loc) { return [Math.floor(loc / GRID), loc % GRID]; }
export function locInZone(loc) {
  const [r, c] = locRC(loc);
  return r >= 1 && r <= 3 && c >= 1 && c <= 3;
}
/** Suggested attack zone for a tapped location (user can override). */
export function defaultZoneForLoc(loc) {
  if (loc === 12) return 'heart';
  return locInZone(loc) ? 'edge' : 'chase';
}
export function locName(loc) {
  if (loc == null) return '';
  const [r, c] = locRC(loc);
  const v = ['Way up', 'Up', 'Middle', 'Down', 'Way down'][r];
  const h = ['way left', 'left', 'center', 'right', 'way right'][c];
  return `${v} · ${h}`;
}

export function countState(balls, strikes) {
  if (balls === 3 && strikes === 2) return 'even'; // full count
  if (balls > strikes) return 'ahead';
  if (strikes > balls) return 'behind';
  return 'even';
}

function newPA(num, gameId) {
  return { num, gameId, pitches: [], balls: 0, strikes: 0, result: null, kLooking: false, endBalls: 0, endStrikes: 0 };
}

/**
 * Replay a game's event log into plate appearances.
 * Events: {type:'pitch', zone, loc, result, contact?, traj?, spray?, outcome?}
 *         {type:'end', reason:'IBB'|'OTHER'}  (manual PA end)
 * Returns { pas: completed PAs, current: in-progress PA, pitches: all annotated pitches }.
 */
export function replayGame(game) {
  const pas = [];
  const pitches = [];
  let cur = newPA(1, game.id);
  const close = (result, b, s) => {
    cur.result = result;
    cur.endBalls = b;
    cur.endStrikes = s;
    for (const p of cur.pitches) p.paResult = result;
    pas.push(cur);
    cur = newPA(cur.num + 1, game.id);
  };
  for (const ev of game.events || []) {
    if (ev.type === 'end') {
      close(ev.reason || 'OTHER', cur.balls, cur.strikes);
      continue;
    }
    const p = {
      ...ev, gameId: game.id, paNum: cur.num, pitchNum: cur.pitches.length + 1,
      balls: cur.balls, strikes: cur.strikes, paResult: null,
    };
    cur.pitches.push(p);
    pitches.push(p);
    const b = cur.balls, s = cur.strikes;
    switch (ev.result) {
      case 'B':
        cur.balls++;
        if (cur.balls >= 4) close('BB', b, s);
        break;
      case 'CS':
      case 'SS':
        cur.strikes++;
        if (cur.strikes >= 3) { cur.kLooking = ev.result === 'CS'; close('K', b, s); }
        break;
      case 'F':
        if (cur.strikes < 2) cur.strikes++;
        break;
      case 'HBP':
        close('HBP', b, s);
        break;
      case 'IP':
        close(ev.outcome || 'OUT', b, s);
        break;
    }
  }
  return { pas, current: cur, pitches };
}

export function metric(num, den, min) {
  return { num, den, value: den ? num / den : null, small: den < min };
}

/** Aggregate report for a set of games. */
export function buildReport(games) {
  const pitches = [];
  const pas = [];
  for (const g of games) {
    const r = replayGame(g);
    pitches.push(...r.pitches);
    pas.push(...r.pas);
  }
  const swings = pitches.filter((p) => isSwing(p.result));
  const zoneP = pitches.filter((p) => inZone(p.zone));
  const outP = pitches.filter((p) => outZone(p.zone));
  const heartP = pitches.filter((p) => p.zone === 'heart');
  const firstP = pitches.filter((p) => p.pitchNum === 1);
  const twoK = pitches.filter((p) => p.strikes === 2);
  const twoKOut = twoK.filter((p) => outZone(p.zone));
  const zoneSwings = zoneP.filter((p) => isSwing(p.result));
  const whiffs = pitches.filter((p) => p.result === 'SS');
  const count = (arr, f) => arr.filter(f).length;

  const realPAs = pas.filter((pa) => pa.result !== 'OTHER');
  const pitchesInPAs = realPAs.reduce((n, pa) => n + pa.pitches.length, 0);
  const slash = slashLine(realPAs);
  const bip = pitches.filter((p) => p.result === 'IP' && p.contact);

  const stats = {
    chase: metric(count(outP, (p) => isSwing(p.result)), outP.length, MIN_N.chase),
    zoneSwing: metric(zoneSwings.length, zoneP.length, MIN_N.zoneSwing),
    heartTake: metric(count(heartP, (p) => !isSwing(p.result)), heartP.length, MIN_N.heartTake),
    firstPitchSwing: metric(count(firstP, (p) => isSwing(p.result)), firstP.length, MIN_N.firstPitchSwing),
    whiff: metric(whiffs.length, swings.length, MIN_N.whiff),
    zoneContact: metric(count(zoneSwings, (p) => p.result !== 'SS'), zoneSwings.length, MIN_N.zoneContact),
    swStr: metric(whiffs.length, pitches.length, MIN_N.swStr),
    twoStrikeChase: metric(count(twoKOut, (p) => isSwing(p.result)), twoKOut.length, MIN_N.twoStrikeChase),
    kRate: metric(count(realPAs, (pa) => pa.result === 'K'), realPAs.length, MIN_N.kRate),
    pPerPA: { num: pitchesInPAs, den: realPAs.length, value: realPAs.length ? pitchesInPAs / realPAs.length : null, small: realPAs.length < MIN_N.pPerPA },
    hardHit: metric(count(bip, (p) => p.contact === 'hard'), bip.length, MIN_N.hardHit),
  };

  // Count splits: pitch decisions by count state, plus PAs that ended in that count.
  const splits = {};
  for (const st of ['ahead', 'even', 'behind']) {
    const ps = pitches.filter((p) => countState(p.balls, p.strikes) === st);
    const sw = ps.filter((p) => isSwing(p.result));
    const out = ps.filter((p) => outZone(p.zone));
    const ended = realPAs.filter((pa) => countState(pa.endBalls, pa.endStrikes) === st);
    const endBip = ended.map((pa) => pa.pitches[pa.pitches.length - 1]).filter((p) => p && p.result === 'IP');
    splits[st] = {
      pitches: ps.length,
      swing: metric(sw.length, ps.length, MIN_N.split),
      chase: metric(count(out, (p) => isSwing(p.result)), out.length, MIN_N.split),
      whiff: metric(count(sw, (p) => p.result === 'SS'), sw.length, MIN_N.split),
      pas: ended.length,
      slash: slashLine(ended),
      k: count(ended, (pa) => pa.result === 'K'),
      bb: count(ended, (pa) => pa.result === 'BB' || pa.result === 'IBB' || pa.result === 'HBP'),
      hard: count(endBip, (p) => p.contact === 'hard'),
      bip: endBip.length,
    };
  }

  // Heat map cells (5x5).
  const heat = Array.from({ length: GRID * GRID }, () => ({ seen: 0, swings: 0, whiffs: 0, takes: 0 }));
  let noLoc = 0;
  for (const p of pitches) {
    if (p.loc == null) { noLoc++; continue; }
    const c = heat[p.loc];
    c.seen++;
    if (isSwing(p.result)) c.swings++; else c.takes++;
    if (p.result === 'SS') c.whiffs++;
  }

  const outcomes = {};
  for (const pa of pas) outcomes[pa.result] = (outcomes[pa.result] || 0) + 1;

  const spray = pitches
    .filter((p) => p.result === 'IP' && p.spray)
    .map((p) => ({ x: p.spray.x, y: p.spray.y, contact: p.contact, traj: p.traj, outcome: p.outcome, gameId: p.gameId, paNum: p.paNum }));

  return {
    pitchCount: pitches.length, paCount: realPAs.length, allPAs: pas, pitches,
    stats, slash, splits, heat, noLoc, outcomes, spray,
  };
}

export function slashLine(pas) {
  let ab = 0, h = 0, tb = 0, bb = 0, hbp = 0;
  for (const pa of pas) {
    const r = pa.result;
    if (r === 'BB' || r === 'IBB') bb++;
    else if (r === 'HBP') hbp++;
    else if (r === 'OTHER' || r == null) continue;
    else {
      ab++;
      if (HITS.has(r)) { h++; tb += TB[r]; }
    }
  }
  const pa = ab + bb + hbp;
  return {
    pa, ab, h, tb, bb, hbp,
    avg: ab ? h / ab : null,
    obp: pa ? (h + bb + hbp) / pa : null,
    slg: ab ? tb / ab : null,
    small: pa < MIN_N.slash,
  };
}

// ---------- CSV ----------
const CSV_COLS = [
  'game_id', 'game_date', 'opponent', 'player', 'pa_number', 'pitch_number',
  'balls_before', 'strikes_before', 'count_state', 'zone', 'in_zone',
  'location_cell', 'location_row', 'location_col', 'location_label',
  'result', 'swing', 'contact_quality', 'trajectory', 'spray_x', 'spray_y',
  'bip_outcome', 'pa_result', 'timestamp',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(games) {
  const rows = [CSV_COLS.join(',')];
  const sorted = [...games].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
  for (const g of sorted) {
    const { pitches } = replayGame(g);
    for (const p of pitches) {
      const rc = p.loc == null ? [null, null] : locRC(p.loc);
      rows.push([
        g.id, g.date, g.opponent, g.player, p.paNum, p.pitchNum,
        p.balls, p.strikes, `${p.balls}-${p.strikes} ${countState(p.balls, p.strikes)}`,
        p.zone, inZone(p.zone) ? 'Y' : 'N',
        p.loc, rc[0], rc[1], locName(p.loc),
        RESULTS[p.result] || p.result, isSwing(p.result) ? 'Y' : 'N',
        p.contact, p.traj ? TRAJ[p.traj] : null,
        p.spray ? p.spray.x.toFixed(3) : null, p.spray ? p.spray.y.toFixed(3) : null,
        p.outcome ? OUTCOMES[p.outcome] : null,
        p.paResult ? PA_RESULTS[p.paResult] : 'In progress',
        p.t ? new Date(p.t).toISOString() : null,
      ].map(csvCell).join(','));
    }
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------- box-score line for a game ----------
export function gameLine(pas) {
  const s = slashLine(pas);
  if (!s.pa) return '';
  const n = (r) => pas.filter((pa) => pa.result === r).length;
  const parts = [`${s.h}-for-${s.ab}`];
  const add = (count, label) => { if (count) parts.push(count > 1 ? `${count} ${label}` : label); };
  add(n('HR'), 'HR'); add(n('3B'), '3B'); add(n('2B'), '2B');
  add(s.bb, 'BB'); add(s.hbp, 'HBP'); add(n('K'), 'K');
  return parts.join(' · ');
}

// ---------- per-game trends ----------
export const TREND_STATS = [
  ['chase', 'Chase rate'], ['zoneSwing', 'Zone swing'], ['whiff', 'Whiff rate'], ['hardHit', 'Hard-hit rate'],
];
/** One point per game (oldest first) for each trend stat; games without data for a stat are skipped. */
export function buildTrends(games) {
  const sorted = [...games].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
  const reps = sorted.map((g) => ({ g, s: buildReport([g]).stats }));
  return TREND_STATS.map(([key, label]) => ({
    key, label,
    points: reps.filter((r) => r.s[key].den > 0).map((r) => ({ date: r.g.date, value: r.s[key].value, den: r.s[key].den })),
  }));
}

// ---------- plain-language insights ----------
const p100 = (v) => `${Math.round(v * 100)}%`;
/** Takeaways from a report. Only speaks when the sample behind a stat is big enough. */
export function buildInsights(rep) {
  const s = rep.stats;
  const out = [];
  const ok = (m) => m.den > 0 && !m.small;
  if (ok(s.chase)) {
    if (s.chase.value >= 0.35) out.push({ title: 'Chasing pitches', text: `Swings at ${p100(s.chase.value)} of pitches outside the zone. Laying off those is the quickest way to better counts.` });
    else if (s.chase.value <= 0.2) out.push({ title: 'Great eye', text: `Only chases ${p100(s.chase.value)} of pitches outside the zone.` });
  }
  if (ok(s.heartTake) && s.heartTake.value >= 0.35) {
    out.push({ title: 'Letting good ones go', text: `Takes ${p100(s.heartTake.value)} of pitches over the heart of the plate. Those are the ones to hunt.` });
  }
  if (ok(s.zoneSwing) && ok(s.chase) && s.zoneSwing.value - s.chase.value >= 0.4) {
    out.push({ title: 'Picks the right pitches', text: `Swings at ${p100(s.zoneSwing.value)} of strikes but only ${p100(s.chase.value)} of balls.` });
  }
  if (ok(s.twoStrikeChase) && ok(s.chase) && s.twoStrikeChase.value - s.chase.value >= 0.15) {
    out.push({ title: 'Expands with two strikes', text: `Chase rate jumps from ${p100(s.chase.value)} to ${p100(s.twoStrikeChase.value)} with two strikes.` });
  }
  if (ok(s.whiff)) {
    if (s.whiff.value >= 0.35) out.push({ title: 'Swing and miss', text: `Misses on ${p100(s.whiff.value)} of swings.` });
    else if (s.whiff.value <= 0.15) out.push({ title: 'Puts the bat on the ball', text: `Misses on just ${p100(s.whiff.value)} of swings.` });
  }
  if (ok(s.firstPitchSwing) && s.firstPitchSwing.value <= 0.15) {
    out.push({ title: 'Patient on the first pitch', text: `Swings at the first pitch only ${p100(s.firstPitchSwing.value)} of the time. A first-pitch strike over the heart is often the best pitch of the at-bat.` });
  }
  if (ok(s.hardHit) && s.hardHit.value >= 0.4) {
    out.push({ title: 'Hitting it hard', text: `${p100(s.hardHit.value)} of balls in play are hard contact.` });
  }
  // Location with the most swings and misses.
  let worst = null;
  rep.heat.forEach((c, i) => {
    if (c.swings >= 5 && c.whiffs >= 3 && c.whiffs / c.swings >= 0.5 && (!worst || c.whiffs > worst.c.whiffs)) worst = { c, i };
  });
  if (worst) out.push({ title: 'Trouble spot', text: `Most swings and misses are on pitches ${locName(worst.i).toLowerCase().replace(' · ', ', ')}: ${worst.c.whiffs} misses on ${worst.c.swings} swings.` });
  const a = rep.splits.ahead, b = rep.splits.behind;
  if (!a.swing.small && !b.chase.small && !a.chase.small && a.chase.den && b.chase.den && b.chase.value - a.chase.value >= 0.2) {
    out.push({ title: 'Different hitter when behind', text: `Chases ${p100(b.chase.value)} when behind in the count vs. ${p100(a.chase.value)} when ahead.` });
  }
  return out;
}
