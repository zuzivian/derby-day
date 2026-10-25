// Long-career simulation through the same meta functions the UI calls.
// Usage: bun career.ts <matches> <mode: sim|model> <seed> [policy]
import { cpuTeam, ladderSquad, autoLineup, generateSquad, toTeamSetup } from '/tmp/rt/progression/repo/src/meta/club.ts';
import { applyResult, buyPlayer, clubTeam, newGame, pickOpponent, sellPlayer, train, averageOverall, askingPrice, salePrice, MIN_SQUAD, type Save } from '/tmp/rt/progression/repo/src/meta/game.ts';
import { completeFirstMatch } from '/tmp/rt/progression/repo/src/client/firstrun.ts';
import { clubLevel, isUnlocked, markUnlocksSeen, pendingUnlocks, UNLOCKS, squadCap, levelForXp } from '/tmp/rt/progression/repo/src/meta/levels.ts';
import { closeCup, closeSeason, cupOpponent, recordCupMatch, recordSeasonMatch, seasonOpponent, simulateRestOfCup, startCup, startSeason, isOut, ensureCompetitionFields } from '/tmp/rt/progression/repo/src/meta/competitions.ts';
import { maybeRollover, signProspect, scoutedPotential } from '/tmp/rt/progression/repo/src/meta/progression.ts';
import { warmupTeam } from '/tmp/rt/progression/repo/src/meta/warmup.ts';
import { simulate } from '/tmp/rt/progression/repo/src/sim/match.ts';
import { makeRng, next, int } from '/tmp/rt/progression/repo/src/sim/rng.ts';
import { overall, ATTR_KEYS, type AttrKey, type Player } from '/tmp/rt/progression/repo/src/meta/player.ts';
import { PRACTICE } from '/tmp/rt/progression/repo/src/client/ui.ts';
import type { TeamSetup } from '/tmp/rt/progression/repo/src/sim/types.ts';
import type { QuickSim } from '/tmp/rt/progression/repo/src/meta/competitions.ts';
const FASTQ: QuickSim | undefined = process.env.FASTQ ? (_s, a, b, seed) => { const r = makeRng(seed); const ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400)); const x = next(r); return x < ea * 0.75 ? { ga: 2, gb: 1 } : x > 1 - (1 - ea) * 0.75 ? { ga: 0, gb: 1 } : { ga: 1, gb: 1 }; } : undefined;

const N = Number(process.argv[2] ?? 300);
const MODE = process.argv[3] ?? 'model';
const SEED = Number(process.argv[4] ?? 12345);
const POLICY = process.argv[5] ?? 'normal';
const HALF = Number(process.env.HALF ?? 180);

const s: Save = newGame(SEED);
const pol = makeRng(SEED ^ 0xabc);
const prefs: any = {};

// Result model: a typical player near his Elo (roadmap: 45% W, 25% D, 30% L, 1.6 goals, CS 25%).
function modelResult(): [number, number] {
  const roll = next(pol);
  const g = () => { let k = 0; const L = Math.exp(-1.6); let p = 1; do { k++; p *= next(pol); } while (p > L); return k - 1; };
  let gf = g(), ga = g();
  if (roll < 0.45) { if (gf <= ga) { gf = ga + 1; } }
  else if (roll < 0.70) { ga = gf; }
  else { if (ga <= gf) ga = gf + 1; }
  return [gf, ga];
}
function simResult(away: TeamSetup): [number, number] {
  const m = simulate({ seed: int(pol, 1, 2 ** 31 - 1), home: clubTeam(s, 0.6), away, halfSeconds: HALF });
  return [m.score[0], m.score[1]];
}
const result = (away: TeamSetup) => (MODE === 'sim' ? simResult(away) : modelResult());

const weights: Record<string, Partial<Record<AttrKey, number>>> = {
  GK: { goalkeeping: 0.72 }, DEF: { defending: 0.4, pace: 0.2 }, MID: { passing: 0.35, dribbling: 0.2 }, FWD: { shooting: 0.4, pace: 0.25, dribbling: 0.25 },
};
function bestAttr(p: Player): AttrKey {
  const w = weights[p.role];
  return (Object.keys(w) as AttrKey[]).filter((k) => p.attrs[k] < 99).sort((a, b) => (w[b]! - w[a]!))[0] ?? 'stamina';
}
function spendSessions() {
  if (!isUnlocked(s, 'training')) return;
  while (s.trainingPoints > 0) {
    // train a starter: youngest with headroom first, else the best starter
    const xi = s.lineup.map((id) => s.squad.find((p) => p.id === id)!).filter(Boolean);
    const cand = [...xi].sort((a, b) => (b.potential - overall(b)) - (a.potential - overall(a)) || a.age - b.age)[0];
    train(s, cand.id, bestAttr(cand));
    stats.sessions++;
  }
}
function transfers() {
  if (!isUnlocked(s, 'transfers') || POLICY === 'notransfers') return;
  // sell 33+ bench players
  for (const p of [...s.squad]) {
    if (s.squad.length <= MIN_SQUAD + 2) break;
    if (p.age >= 33 && !s.lineup.includes(p.id)) { const o = sellPlayer(s, p.id); if (o.ok) stats.sold++; }
  }
  // buy upgrades
  for (let guard = 0; guard < 3; guard++) {
    const xi = s.lineup.map((id) => s.squad.find((p) => p.id === id)!);
    const worst = (role: string) => xi.filter((p) => p.role === role).sort((a, b) => overall(a) - overall(b))[0];
    const options = s.market.filter((m) => { const w = worst(m.role); return w && overall(m) >= overall(w) + 3 && askingPrice(m) <= s.budget; }).sort((a, b) => overall(b) - overall(a));
    if (!options.length) break;
    if (s.squad.length >= squadCap(s)) {
      const bench = s.squad.filter((p) => !s.lineup.includes(p.id) && p.role !== 'GK').sort((a, b) => overall(a) - overall(b))[0];
      if (!bench) break;
      sellPlayer(s, bench.id); stats.sold++;
    }
    const pr = askingPrice(options[0]);
    const o = buyPlayer(s, options[0].id);
    if (o.ok) { stats.bought++; stats.spent += pr; s.lineup = autoLineup(s.squad, s.formation); } else break;
  }
}
function handleOffers() {
  for (const o of [...(s.offers ?? [])]) {
    const v = scoutedPotential(o);
    if (v.stars >= 4) {
      const worst = s.squad.filter((p) => !s.lineup.includes(p.id) && p.role !== 'GK').sort((a, b) => b.age - a.age || overall(a) - overall(b))[0];
      signProspect(s, o.id, worst?.id);
    }
  }
}

const stats = { sessions: 0, bought: 0, sold: 0, spent: 0, forfeits: 0, practice: 0, ranked: 0, cup: 0, league: 0, warmup: 0, cupsWon: 0, leaguesWon: 0, reviews: 0 };
const unlockAt: Record<string, number> = {};
const levelAt: Record<number, number> = {};
const rows: string[] = [];
let blk = { n: 0, w: 0, d: 0, l: 0, q: 0 };
let incomeRanked = 0, incomeComp = 0;

// match 0: first match
{
  const opp = warmupTeam(s, true);
  const [gf, ga] = MODE === 'sim' ? simResult(opp.away) : [1, 0];
  completeFirstMatch(s, prefs, { gf, ga, scorers: [], opponent: { name: opp.away.name, short: opp.away.short } });
}
levelAt[clubLevel(s)] = 1;

for (let i = 1; i <= N; i++) {
  const lvl = clubLevel(s);
  const roll = next(pol);
  let kind = 'ranked';
  if (!isUnlocked(s, 'ranked')) kind = 'warmup';
  else if (isUnlocked(s, 'practice') && roll < 0.06) kind = 'practice';
  else if (isUnlocked(s, 'cup') && roll < 0.31) kind = 'cup';
  else if (isUnlocked(s, 'league') && roll < 0.56) kind = 'league';
  if (POLICY === 'cuponly' && isUnlocked(s, 'cup')) kind = 'cup';
  if (POLICY === 'rankedonly' && isUnlocked(s, 'ranked')) kind = 'ranked';
  const forfeit = !['noforfeit', 'cuponly', 'rankedonly'].includes(POLICY) && next(pol) < 0.03;
  const xpb = s.xp ?? 0;
  const b0 = s.budget;
  if (kind === 'warmup') {
    const w = warmupTeam(s);
    const [gf, ga] = result(w.away);
    if (!forfeit) applyResult(s, null, { name: w.away.name, short: w.away.short }, gf, ga, false, [], 'Warm-up friendly', false, 'easy');
    stats.warmup++;
  } else if (kind === 'practice') {
    const lv = PRACTICE[isUnlocked(s, 'practice-hard') ? 2 : isUnlocked(s, 'practice-normal') ? 1 : 0];
    const squad = generateSquad(makeRng(lv.quality * 7919), lv.quality);
    const away = toTeamSetup({ id: lv.id, name: lv.name, short: lv.short, primary: lv.primary, secondary: lv.secondary, crest: 'hoops' }, squad, autoLineup(squad), lv.aiSkill);
    const [gf, ga] = result(away);
    if (!forfeit) applyResult(s, null, { name: lv.name, short: lv.short }, gf, ga, false, [], undefined, false, lv.id as any);
    stats.practice++;
  } else if (kind === 'cup') {
    ensureCompetitionFields(s);
    if (s.cup && (s.cup.done || isOut(s, s.cup))) { simulateRestOfCup(s, FASTQ); if (s.cup.winner === s.club.id) stats.cupsWon++; closeCup(s); }
    if (!s.cup) startCup(s);
    const opp = cupOpponent(s, s.cup!)!;
    const [gf, ga] = result(cpuTeam(opp, ladderSquad(opp)));
    const f = forfeit;
    const pens = !f && gf === ga ? (next(pol) < 0.5 ? { you: 4, opp: 3 } : { you: 3, opp: 4 }) : undefined;
    recordCupMatch(s, f ? 0 : gf, f ? 3 : ga, [], FASTQ, f, pens);
    if (s.cup!.done || isOut(s, s.cup!)) { simulateRestOfCup(s, FASTQ); if (s.cup!.winner === s.club.id) stats.cupsWon++; closeCup(s); }
    stats.cup++;
    incomeComp += s.budget - b0;
  } else if (kind === 'league') {
    ensureCompetitionFields(s);
    if (!s.season) startSeason(s);
    const opp = seasonOpponent(s, s.season!)!;
    const [gf, ga] = result(cpuTeam(opp, ladderSquad(opp)));
    recordSeasonMatch(s, forfeit ? 0 : gf, forfeit ? 3 : ga, [], FASTQ, forfeit);
    if (s.season!.done) { if (s.season!.finish === 1) stats.leaguesWon++; closeSeason(s); }
    stats.league++;
    incomeComp += s.budget - b0;
  } else {
    const opp = pickOpponent(s);
    const [gf, ga] = result(cpuTeam(opp, ladderSquad(opp)));
    blk.n++; blk.q += opp.quality; if (gf > ga) blk.w++; else if (gf === ga) blk.d++; else blk.l++;
    if (forfeit) applyResult(s, opp, { name: opp.name, short: opp.short }, 0, Math.max(3, ga), true, [], undefined, true);
    else applyResult(s, opp, { name: opp.name, short: opp.short }, gf, ga, true, []);
    stats.ranked++;
    incomeRanked += s.budget - b0;
  }
  if (forfeit) stats.forfeits++;
  if (i > 20) { (stats as any)[kind + 'Xp'] = ((stats as any)[kind + 'Xp'] ?? 0) + (s.xp! - xpb); (stats as any)[kind + 'N'] = ((stats as any)[kind + 'N'] ?? 0) + 1; }
  const rev = maybeRollover(s);
  if (rev) { stats.reviews++; rev.seen = true; handleOffers(); }
  for (const u of pendingUnlocks(s)) unlockAt[`${u.level} ${u.name}`] = i;
  markUnlocksSeen(s);
  spendSessions();
  transfers();
  const L = clubLevel(s);
  for (let l = lvl + 1; l <= L; l++) levelAt[l] = i;
  if (i % (N > 1000 ? 250 : 25) === 0 || i === N) {
    const ages = s.squad.map((p) => p.age);
    const json = JSON.stringify(s);
    const xi = s.lineup.map((id) => s.squad.find((p) => p.id === id)!).filter(Boolean);
    const top3 = [...s.ladder].sort((a, b) => b.elo - a.elo).slice(0, 3).map((c) => c.quality).join('/');
    rows.push(`ranked W/D/L ${blk.w}/${blk.d}/${blk.l} oppQ ${(blk.q / Math.max(1, blk.n)).toFixed(1)} top3Q ${top3}`); blk = { n: 0, w: 0, d: 0, l: 0, q: 0 };
    rows.push(`${String(i).padStart(4)} L${String(L).padStart(2)} xp=${String(s.xp).padStart(6)} elo=${s.club.elo} ƒ=${(s.budget / 1e6).toFixed(2)}m XIavg=${averageOverall(s).toFixed(1)} squad=${s.squad.length} ages=${Math.min(...ages)}-${Math.max(...ages)} (xi mean ${(xi.reduce((t, p) => t + p.age, 0) / xi.length).toFixed(1)}) yr=${s.year} wk=${s.week} hist=${s.history.length} json=${(json.length / 1024).toFixed(1)}KB ladder=${Math.min(...s.ladder.map((c) => c.elo))}-${Math.max(...s.ladder.map((c) => c.elo))}`);
  }
}
console.log(`mode=${MODE} seed=${SEED} policy=${POLICY} N=${N}`);
console.log(rows.join('\n'));
console.log('levels reached at match #:', JSON.stringify(levelAt));
console.log('unlocks at match #:', JSON.stringify(unlockAt));
console.log('stats', JSON.stringify(stats), 'incomeRanked/match', Math.round(incomeRanked / Math.max(1, stats.ranked)), 'incomeComp/match', Math.round(incomeComp / Math.max(1, stats.cup + stats.league)));
console.log('trophies', (s.trophies ?? []).length, 'xp/match', ((s.xp ?? 0) / N).toFixed(1));
const ages = s.squad.map((p) => `${p.role}${p.age}:${overall(p)}`).join(' ');
console.log('final squad', ages);
await Bun.write(`/tmp/rt/progression/out/career-${MODE}-${SEED}-${POLICY}.json`, JSON.stringify(s));
