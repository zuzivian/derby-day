// A deterministic headless career: hundreds or thousands of matches through
// the same meta functions the UI calls (first match, warm-ups, ranked, cup,
// league, practice, forfeits, abandoned matches, training, transfers, the
// academy and every rollover), printing level, Elo, money, division, your XI
// against the world, and unlocks over time.
//   bun run career [matches] [--seed N] [--policy mixed|ranked|cup] [--edge N] [--assert]
// Results come from the same Poisson model as CPU fixtures (quickScore in
// src/meta/world.ts) with your XI plus `edge` (how much better you play than
// your squad's rating; default 3). Real time is MATCH_MINUTES a match: 2 x 3
// minutes of play plus a minute of kick-off, result and menus.
//
// With --assert the process exits non-zero when a target band is missed (CI
// runs it in the check job): the pacing to levels 5, 10, 20, 50 and 99, the
// world keeping strong opposition at the top, cups not out-earning ranked,
// promotion happening, and the save staying small. The bands are printed with
// the numbers.

import { autoLineup, generateSquad, teamStrength } from '../src/meta/club.ts';
import { applyResult, askingPrice, averageOverall, buyPlayer, MIN_SQUAD, newGame, offeredOpponent, sellPlayer, train, type Save } from '../src/meta/game.ts';
import { closeCup, closeSeason, cupOpponent, cupWaitLeft, ensureCompetitionFields, isOut, recordCupMatch, recordSeasonMatch, seasonOpponent, simulateRestOfCup, startCup, startSeason } from '../src/meta/competitions.ts';
import { award, claimMilestone, clubLevel, isUnlocked, markUnlocksSeen, MAX_LEVEL, pendingUnlocks, squadCap, type PracticeLevel } from '../src/meta/levels.ts';
import { beginMatch, settleAbandoned } from '../src/meta/pending.ts';
import { maybeRollover, scoutedPotential, signProspect } from '../src/meta/progression.ts';
import { warmupTeam } from '../src/meta/warmup.ts';
import { cpuStrength, divisionClubs, playerDivision, quickScore } from '../src/meta/world.ts';
import { overall, type AttrKey, type Player } from '../src/meta/player.ts';
import { makeRng, next } from '../src/sim/rng.ts';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ASSERT = args.includes('--assert');
const N = Number(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? (ASSERT ? 3600 : 300));
const SEED = Number(flag('seed', '2026'));
const POLICY = flag('policy', 'mixed');
const EDGE = Number(flag('edge', '3'));
if (!Number.isFinite(N) || N < 1) throw new Error('Usage: bun run career [matches] [--seed N] [--policy mixed|ranked|cup] [--edge N] [--assert]');
export const MATCH_MINUTES = 7;

/** Practice opponents, as on Home (PRACTICE in src/client/ui.ts). */
const PRACTICE: { id: PracticeLevel; name: string; short: string; quality: number }[] = [
  { id: 'easy', name: 'Reserve XI', short: 'RES', quality: 46 },
  { id: 'normal', name: 'Academy Select', short: 'ACA', quality: 58 },
  { id: 'hard', name: 'Veterans Select', short: 'VET', quality: 72 },
];

const s: Save = newGame(SEED);
const r = makeRng(SEED ^ 0xca5ee5);
const xi = () => averageOverall(s);
/** Your result against an XI of `opp`: the CPU-fixture model, with your play worth EDGE points. */
const play = (opp: number): [number, number] => quickScore(r, xi() + EDGE, opp);

const stats = { ranked: 0, cup: 0, league: 0, practice: 0, warmup: 0, forfeits: 0, abandoned: 0, sessions: 0, bought: 0, sold: 0, cupsWon: 0, leaguesWon: 0, promotions: 0, relegations: 0, reviews: 0 };
const xpBy: Record<string, { xp: number; n: number; money: number; w: number; d: number; l: number }> = {};
const levelAt: Record<number, number> = {};
const unlockAt: string[] = [];
const blocks: string[] = [];
let blk = { n: 0, w: 0, d: 0, l: 0, opp: 0 };
/** Per 100 matches from match 101 on: ranked win share and the gap from the strongest CPU club down to your XI. */
const late: { win: number; gap: number }[] = [];
let lateW = 0;
let lateN = 0;

function bestAttr(p: Player): AttrKey {
  const w: Record<string, AttrKey[]> = { GK: ['goalkeeping'], DEF: ['defending', 'pace'], MID: ['passing', 'dribbling'], FWD: ['shooting', 'pace', 'dribbling'] };
  return w[p.role].find((k) => p.attrs[k] < 99) ?? 'stamina';
}

function spendSessions() {
  if (!isUnlocked(s, 'training')) return;
  while (s.trainingPoints > 0) {
    const team = s.lineup.map((id) => s.squad.find((p) => p.id === id)!).filter(Boolean);
    const p = [...team].sort((a, b) => b.potential - overall(b) - (a.potential - overall(a)) || a.age - b.age)[0];
    train(s, p.id, bestAttr(p));
    stats.sessions++;
  }
}

function transfers() {
  if (!isUnlocked(s, 'transfers')) return;
  for (const p of [...s.squad]) {
    if (s.squad.length <= MIN_SQUAD + 2) break;
    if (p.age >= 33 && !s.lineup.includes(p.id) && sellPlayer(s, p.id).ok) stats.sold++;
  }
  for (let guard = 0; guard < 3; guard++) {
    const team = s.lineup.map((id) => s.squad.find((p) => p.id === id)!);
    const worst = (role: string) => team.filter((p) => p.role === role).sort((a, b) => overall(a) - overall(b))[0];
    const options = s.market.filter((m) => worst(m.role) && overall(m) >= overall(worst(m.role)) + 3 && askingPrice(m) <= s.budget).sort((a, b) => overall(b) - overall(a));
    if (!options.length) break;
    if (s.squad.length >= squadCap(s)) {
      const bench = s.squad.filter((p) => !s.lineup.includes(p.id) && p.role !== 'GK').sort((a, b) => overall(a) - overall(b))[0];
      if (!bench || !sellPlayer(s, bench.id).ok) break;
      stats.sold++;
    }
    if (!buyPlayer(s, options[0].id).ok) break;
    stats.bought++;
    s.lineup = autoLineup(s.squad, s.formation);
  }
}

function academy() {
  for (const o of [...(s.offers ?? [])]) {
    if (scoutedPotential(o).stars < 4) continue;
    const out = s.squad.filter((p) => !s.lineup.includes(p.id) && p.role !== 'GK').sort((a, b) => b.age - a.age || overall(a) - overall(b))[0];
    signProspect(s, o.id, out?.id);
  }
}

function strengthOf(id: string): number {
  const c = s.ladder.find((x) => x.id === id)!;
  return cpuStrength(c);
}

// The first match: a friendly against an easy club, with its milestone.
{
  const w = warmupTeam(s, true);
  const [gf, ga] = play(teamStrength(generateSquad(makeRng(1), 46), autoLineup(generateSquad(makeRng(1), 46))));
  const summary = applyResult(s, null, { name: w.away.name, short: w.away.short }, gf, ga, false, [], undefined, false, 'easy');
  award(s, [claimMilestone(s, 'first-match')], summary.xp);
  markUnlocksSeen(s);
}
levelAt[clubLevel(s)] = 0;

const t0 = performance.now();
let lastPrint = 0;
for (let i = 1; i <= N; i++) {
  const before = clubLevel(s);
  const xp0 = s.xp ?? 0;
  const money0 = s.budget;
  const roll = next(r);
  const forfeit = next(r) < 0.03;
  const abandon = !forfeit && next(r) < 0.01;
  let kind: 'ranked' | 'cup' | 'league' | 'practice' | 'warmup' = 'ranked';
  ensureCompetitionFields(s);
  const cupReady = isUnlocked(s, 'cup') && (s.cup || cupWaitLeft(s) === 0);
  if (!isUnlocked(s, 'ranked')) kind = 'warmup';
  else if (POLICY === 'cup' && cupReady) kind = 'cup';
  else if (POLICY === 'ranked') kind = 'ranked';
  // A mixed week: 5% practice, 25% cup (when one can run), 30% league, the rest ranked.
  else if (isUnlocked(s, 'practice') && roll < 0.05) kind = 'practice';
  else if (cupReady && roll < 0.3) kind = 'cup';
  else if (isUnlocked(s, 'league') && roll >= 0.3 && roll < 0.6) kind = 'league';

  if (kind === 'warmup') {
    const w = warmupTeam(s);
    const [gf, ga] = play(teamStrength(generateSquad(makeRng(i), 48), autoLineup(generateSquad(makeRng(i), 48))));
    applyResult(s, null, { name: w.away.name, short: w.away.short }, gf, ga, false, [], 'Warm-up friendly', false, 'easy');
    stats.warmup++;
  } else if (kind === 'practice') {
    const lv = PRACTICE[isUnlocked(s, 'practice-hard') ? 2 : isUnlocked(s, 'practice-normal') ? 1 : 0];
    const [gf, ga] = play(lv.quality + 1);
    if (!forfeit) applyResult(s, null, { name: lv.name, short: lv.short }, gf, ga, false, [], undefined, false, lv.id);
    stats.practice++;
  } else if (kind === 'cup') {
    if (!s.cup) startCup(s);
    const opp = cupOpponent(s, s.cup!)!;
    const [gf, ga] = play(strengthOf(opp.id));
    if (abandon) {
      beginMatch(s, { kind: 'cup', opponent: opp.name, label: 'Cup tie' });
      settleAbandoned(s);
      stats.abandoned++;
    } else {
      const pens = !forfeit && gf === ga ? (next(r) < 0.5 ? { you: 4, opp: 3 } : { you: 3, opp: 4 }) : undefined;
      recordCupMatch(s, forfeit ? 0 : gf, forfeit ? 3 : ga, [], undefined, forfeit, pens);
    }
    if (s.cup!.done || isOut(s, s.cup!)) {
      simulateRestOfCup(s);
      if (s.cup!.winner === s.club.id) stats.cupsWon++;
      closeCup(s);
    }
    stats.cup++;
  } else if (kind === 'league') {
    if (!s.season) startSeason(s);
    const opp = seasonOpponent(s, s.season!)!;
    const [gf, ga] = play(strengthOf(opp.id));
    const div = playerDivision(s);
    if (abandon) {
      beginMatch(s, { kind: 'league', opponent: opp.name, label: 'League matchday' });
      settleAbandoned(s);
      stats.abandoned++;
    } else recordSeasonMatch(s, forfeit ? 0 : gf, forfeit ? 3 : ga, [], undefined, forfeit);
    if (s.season!.done) {
      if (s.season!.finish === 1) stats.leaguesWon++;
      if (playerDivision(s) < div) stats.promotions++;
      if (playerDivision(s) > div) stats.relegations++;
      closeSeason(s);
    }
    stats.league++;
  } else {
    const opp = offeredOpponent(s);
    const theirs = strengthOf(opp.id);
    const [gf, ga] = play(theirs);
    blk.n++;
    blk.opp += theirs;
    if (abandon) {
      beginMatch(s, { kind: 'ranked', opponentId: opp.id, opponent: opp.name, label: 'Ranked' });
      settleAbandoned(s);
      stats.abandoned++;
      blk.l++;
    } else {
      if (forfeit) applyResult(s, opp, opp, 0, 3, true, [], undefined, true);
      else applyResult(s, opp, opp, gf, ga, true, []);
      const res = forfeit ? 'l' : gf > ga ? 'w' : gf === ga ? 'd' : 'l';
      blk[res]++;
      if (i > 100) {
        lateN++;
        if (res === 'w') lateW++;
      }
    }
    stats.ranked++;
  }
  if (forfeit && kind !== 'warmup') stats.forfeits++;
  const k = kind === 'warmup' ? 'practice' : kind;
  xpBy[k] ??= { xp: 0, n: 0, money: 0, w: 0, d: 0, l: 0 };
  if (i > 30) {
    xpBy[k].xp += (s.xp ?? 0) - xp0;
    xpBy[k].money += s.budget - money0;
    xpBy[k].n++;
    const last = s.history.at(-1)!;
    xpBy[k][last.goalsFor > last.goalsAgainst ? 'w' : last.goalsFor === last.goalsAgainst ? 'd' : 'l']++;
  }
  const review = maybeRollover(s);
  if (review) {
    review.seen = true;
    stats.reviews++;
    academy();
  }
  for (const u of pendingUnlocks(s)) unlockAt.push(`L${u.level} ${u.name} @${i} (${hours(i)} h)`);
  markUnlocksSeen(s);
  spendSessions();
  transfers();
  for (let l = before + 1; l <= clubLevel(s); l++) levelAt[l] = i;

  const every = N > 1000 ? 200 : 25;
  const top = i % 100 === 0 || i % every === 0 || i === N ? Math.max(...s.ladder.map((c) => cpuStrength(c))) : 0;
  if (i > 100 && i % 100 === 0) {
    late.push({ win: lateW / Math.max(1, lateN), gap: top - xi() });
    lateW = 0;
    lateN = 0;
  }
  if (i % every === 0 || i === N) {
    const d1 = divisionClubs(s, 1).map((c) => cpuStrength(c)).sort((a, b) => b - a);
    blocks.push(
      `${String(i).padStart(5)} ${hours(i).padStart(6)}h L${String(clubLevel(s)).padStart(2)} Elo ${s.club.elo} ${('ƒ' + (s.budget / 1e6).toFixed(2) + 'm').padStart(8)} Div ${playerDivision(s)} XI ${xi().toFixed(1)} ` +
        `| top CPU XI ${top} D1 ${d1.slice(0, 3).join('/')} | ranked ${blk.w}W ${blk.d}D ${blk.l}L v XI ${(blk.opp / Math.max(1, blk.n)).toFixed(1)} | yr ${s.year} save ${(JSON.stringify(s).length / 1024).toFixed(0)}KB`,
    );
    blk = { n: 0, w: 0, d: 0, l: 0, opp: 0 };
  }
  if (clubLevel(s) >= MAX_LEVEL && ASSERT) {
    lastPrint = i;
    break;
  }
  lastPrint = i;
}
const ms = performance.now() - t0;

function hours(matches: number): string {
  return ((matches * MATCH_MINUTES) / 60).toFixed(1);
}

const per = (k: string) => {
  const v = xpBy[k];
  return v && v.n ? { xp: v.xp / v.n, money: v.money / v.n, n: v.n, wdl: `${v.w}W ${v.d}D ${v.l}L` } : { xp: 0, money: 0, n: 0, wdl: '' };
};
console.log(`career seed=${SEED} policy=${POLICY} edge=${EDGE} matches=${lastPrint} (${(ms / Math.max(1, lastPrint)).toFixed(2)} ms a match)`);
console.log('match   hours lvl  Elo     money   Div  your XI | strongest CPU XIs | ranked block | calendar');
console.log(blocks.join('\n'));
const milestones = [5, 10, 20, 30, 50, 75, 99];
console.log('levels:', milestones.map((l) => `L${l} ${levelAt[l] !== undefined ? `${hours(levelAt[l])} h (match ${levelAt[l]})` : 'not reached'}`).join(', '));
console.log('unlocks:', unlockAt.join('; '));
for (const k of ['ranked', 'cup', 'league', 'practice']) {
  const p = per(k);
  console.log(`  ${k.padEnd(8)} ${p.n} matches (${p.wdl}), ${p.xp.toFixed(0)} XP and ${(p.money / 1000).toFixed(0)}k a match (after match 30; the match and any finish bonus, not training)`);
}
console.log('stats', JSON.stringify(stats));
console.log('late blocks (ranked win share, strongest CPU XI minus yours):', late.map((x) => `${(x.win * 100).toFixed(0)}%/${x.gap >= 0 ? '+' : ''}${x.gap.toFixed(1)}`).join(' '));
console.log(`history ${s.history.length} kept (+${s.historyBase} dropped), save ${(JSON.stringify(s).length / 1024).toFixed(0)} KB, trophies ${(s.trophies ?? []).length}, seasons logged ${(s.seasons ?? []).length}`);

if (ASSERT) {
  const fails: string[] = [];
  const band = (label: string, value: number, lo: number, hi: number) => {
    const ok = value >= lo && value <= hi;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${Number.isFinite(value) ? value.toFixed(2) : value} (want ${lo}..${hi})`);
    if (!ok) fails.push(label);
  };
  const h = (l: number) => (levelAt[l] !== undefined ? (levelAt[l] * MATCH_MINUTES) / 60 : Infinity);
  band('hours to level 5', h(5), 0, 1.5);
  band('hours to level 10', h(10), 2, 7);
  band('hours to level 20', h(20), 8, 25);
  band('hours to level 50', h(50), 40, 110);
  band('hours to level 99', h(99), 150, 320);
  band('cup XP a match / ranked XP a match', per('cup').xp / Math.max(1, per('ranked').xp), 0.8, 1.3);
  band('league XP a match / ranked XP a match', per('league').xp / Math.max(1, per('ranked').xp), 0.8, 1.35);
  // From match 200 on, the world keeps up: the strongest CPU XI is never more than 3 below yours, and ranked is never a walkover.
  const later = late.slice(1);
  band('worst gap, strongest CPU XI minus yours (from match 200)', Math.min(...later.map((x) => x.gap)), -3, 40);
  band('best ranked win share per 100 matches (from match 200)', Math.max(...later.map((x) => x.win)), 0, 0.7);
  band('promotions', stats.promotions, 3, 1e9);
  band('save size KB', JSON.stringify(s).length / 1024, 0, 160);
  band('matches kept in history', s.history.length, 0, 300);
  band('ms a match', ms / Math.max(1, lastPrint), 0, 25);
  if (fails.length) {
    console.error(`career --assert failed: ${fails.join(', ')}`);
    process.exit(1);
  }
}
