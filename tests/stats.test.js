import test from 'node:test';
import assert from 'node:assert/strict';
import { replayGame, buildReport, toCSV, defaultZoneForLoc, countState, scaleScore, metric } from '../js/stats.js';

const P = (result, zone = 'heart', extra = {}) => ({ type: 'pitch', zone, loc: null, result, t: 0, ...extra });
const game = (events, id = 'g1') => ({ id, date: '2026-05-01', opponent: 'Tigers', player: 'Sam', createdAt: 1, events });

test('walk ends PA after four balls; count resets', () => {
  const r = replayGame(game([P('B', 'chase'), P('B', 'chase'), P('CS'), P('B', 'waste'), P('B', 'chase'), P('B')]));
  assert.equal(r.pas.length, 1);
  assert.equal(r.pas[0].result, 'BB');
  assert.equal(r.pas[0].endBalls, 3);
  assert.equal(r.pas[0].endStrikes, 1);
  assert.equal(r.current.num, 2);
  assert.equal(r.current.balls, 1);
  assert.equal(r.pitches[5].pitchNum, 1);
});

test('fouls with two strikes do not end PA; strikeout looking', () => {
  const r = replayGame(game([P('CS'), P('SS'), P('F'), P('F'), P('CS', 'edge')]));
  assert.equal(r.pas.length, 1);
  assert.equal(r.pas[0].result, 'K');
  assert.equal(r.pas[0].kLooking, true);
  assert.equal(r.pas[0].pitches.length, 5);
});

test('in play, HBP and manual end close PAs', () => {
  const r = replayGame(game([
    P('IP', 'heart', { outcome: '2B', contact: 'hard' }),
    P('HBP', 'waste'),
    P('B'), { type: 'end', reason: 'IBB' },
    { type: 'end', reason: 'OTHER' },
  ]));
  assert.deepEqual(r.pas.map((p) => p.result), ['2B', 'HBP', 'IBB', 'OTHER']);
  assert.equal(r.current.pitches.length, 0);
});

test('undo (pop) reopens a finished PA', () => {
  const ev = [P('B'), P('B'), P('B'), P('B')];
  const g = game(ev);
  assert.equal(replayGame(g).pas.length, 1);
  g.events.pop();
  const r = replayGame(g);
  assert.equal(r.pas.length, 0);
  assert.equal(r.current.balls, 3);
});

test('report rates', () => {
  // PA1: chase swing-miss, heart take (CS), heart foul, edge in play out (weak)
  // PA2: first pitch chase take (B), heart swing-miss, then 1-1 chase swing-miss, 1-2 waste take, chase whiff K
  const g = game([
    P('SS', 'chase'), P('CS', 'heart'), P('F', 'heart'), P('IP', 'edge', { outcome: 'OUT', contact: 'weak', spray: { x: .5, y: .5 } }),
    P('B', 'chase'), P('SS', 'heart'), P('SS', 'chase'), P('B', 'waste'), P('SS', 'chase'),
  ]);
  const rep = buildReport([g]);
  const s = rep.stats;
  assert.equal(rep.pitchCount, 9);
  assert.equal(rep.paCount, 2);
  // out of zone: chase SS, chase B, chase SS, waste B, chase SS => 5 pitches, 3 swings
  assert.deepEqual([s.chase.num, s.chase.den], [3, 5]);
  // in zone: heart CS, heart F, edge IP, heart SS => 4, swings 3
  assert.deepEqual([s.zoneSwing.num, s.zoneSwing.den], [3, 4]);
  // heart: CS, F, SS => takes 1
  assert.deepEqual([s.heartTake.num, s.heartTake.den], [1, 3]);
  assert.deepEqual([s.firstPitchSwing.num, s.firstPitchSwing.den], [1, 2]);
  // swings: SS,F,IP,SS,SS,SS = 6, whiffs 4
  assert.deepEqual([s.whiff.num, s.whiff.den], [4, 6]);
  assert.deepEqual([s.zoneContact.num, s.zoneContact.den], [2, 3]);
  assert.deepEqual([s.swStr.num, s.swStr.den], [4, 9]);
  // two-strike pitches out of zone: PA1 none out-of-zone with 2 strikes (F at 0-2 is heart, IP at 0-2 edge);
  // PA2: 1-2 waste B (take), 2-2 chase SS (swing) => 1/2
  assert.deepEqual([s.twoStrikeChase.num, s.twoStrikeChase.den], [1, 2]);
  assert.deepEqual([s.kRate.num, s.kRate.den], [1, 2]);
  assert.equal(s.pPerPA.value, 4.5);
  assert.equal(s.chase.small, true);
  assert.equal(rep.spray.length, 1);
  assert.equal(rep.slash.ab, 2);
  assert.equal(rep.slash.avg, 0);
});

test('count splits and helpers', () => {
  assert.equal(countState(2, 1), 'ahead');
  assert.equal(countState(1, 2), 'behind');
  assert.equal(countState(3, 2), 'even');
  assert.equal(defaultZoneForLoc(12), 'heart');
  assert.equal(defaultZoneForLoc(6), 'edge');
  assert.equal(defaultZoneForLoc(0), 'chase');
  const rep = buildReport([game([P('B', 'chase'), P('IP', 'heart', { outcome: '1B', contact: 'hard' })])]);
  assert.equal(rep.splits.ahead.pas, 1);
  assert.equal(rep.splits.ahead.slash.h, 1);
  assert.equal(rep.splits.even.pitches, 1);
});

test('CSV export escapes and includes every pitch', () => {
  const g = game([P('B', 'chase', { loc: 0 }), P('IP', 'heart', { loc: 12, outcome: 'HR', contact: 'hard', traj: 'FB', spray: { x: .2, y: .3 } })]);
  g.opponent = 'Cubs, "Blue"';
  const csv = toCSV([g]).trim().split('\r\n');
  assert.equal(csv.length, 3);
  assert.match(csv[1], /"Cubs, ""Blue"""/);
  assert.match(csv[2], /Home run,Home run/);
});

test('scale: direction, clamping and stats without a scale', () => {
  assert.equal(scaleScore('chase', metric(15, 100, 25)), 1);      // 15% chase = great
  assert.equal(scaleScore('chase', metric(60, 100, 25)), 0);      // clamped at needs-work
  assert.ok(Math.abs(scaleScore('chase', metric(30, 100, 25)) - 0.5) < 1e-9);
  assert.equal(scaleScore('zoneSwing', metric(80, 100, 25)), 1);  // higher is better
  assert.equal(scaleScore('firstPitchSwing', metric(5, 10, 10)), null);
  assert.equal(scaleScore('chase', metric(0, 0, 25)), null);
});

test('heat map: batting average and hard contact by location', () => {
  const g = game([
    P('IP', 'heart', { loc: 12, outcome: '1B', contact: 'hard' }),
    P('IP', 'heart', { loc: 12, outcome: 'OUT', contact: 'weak' }),
    P('CS', 'heart', { loc: 12 }), P('SS', 'heart', { loc: 12 }), P('SS', 'chase', { loc: 0 }), // strikeout ends at loc 0
    P('F', 'edge', { loc: 7 }),
  ]);
  const h = buildReport([g]).heat;
  assert.deepEqual([h[12].ab, h[12].hits, h[12].bip, h[12].hard], [2, 1, 2, 1]);
  assert.deepEqual([h[0].ab, h[0].hits], [1, 0]);
  assert.equal(h[7].ab, 0);
});

test('pitch types: split, filtered heat map and CSV column', async () => {
  const { buildHeat } = await import('../js/stats.js');
  const g = game([
    P('IP', 'heart', { loc: 12, pitch: 'FB', outcome: '1B', contact: 'hard' }),
    P('SS', 'chase', { loc: 20, pitch: 'BR' }), P('SS', 'chase', { loc: 20, pitch: 'BR' }), P('B', 'chase', { loc: 0 }), P('SS', 'chase', { loc: 24, pitch: 'BR' }),
  ]);
  const r = buildReport([g]);
  assert.equal(r.typed, true);
  assert.deepEqual(Object.keys(r.byType), ['FB', 'BR', 'NA']);
  assert.deepEqual([r.byType.FB.avg.num, r.byType.FB.avg.den], [1, 1]);
  assert.deepEqual([r.byType.BR.whiff.num, r.byType.BR.whiff.den, r.byType.BR.avg.den], [3, 3, 1]);
  const h = buildHeat(r.pitches.filter((p) => p.pitch === 'BR')).heat;
  assert.equal(h[20].seen, 2); assert.equal(h[12].seen, 0);
  assert.match(toCSV([g]).split('\r\n')[1], /,Fastball,heart,/);
  assert.equal(buildReport([game([P('B', 'chase')])]).typed, false);
});
