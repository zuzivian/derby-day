// Competitions against the CPU: an 8-club knockout cup and an 8-club league
// season. Pure logic over the Save: data in, data out, seeded randomness only.
//
// Decisions (see also the README):
//  - Your matches are played live; the rest are quick-simulated with the real
//    headless sim (src/sim/match.ts) at QUICK_HALF_SECONDS a half. That costs
//    about 80 ms a match, so a round of three CPU ties is ~250 ms, and results
//    reflect the actual squads and CPU skill instead of a dice roll on Elo.
//    The match seed is derived from the competition seed, so a round replays
//    identically.
//  - Competition matches do not change ladder Elo or the ladder record. They
//    pay prize money, training sessions and player development, and are kept
//    in match history labelled with the competition.
//  - A drawn cup tie goes to a penalty shootout settled by a seeded roll
//    weighted by the takers' shooting and the keepers' goalkeeping.

import { autoLineup, ladderSquad, toTeamSetup, type ClubIdentity, type LadderClub } from './club.ts';
import { applyResult, formatMoney, type ResultSummary, type Save } from './game.ts';
import { overall, type Player } from './player.ts';
import { simulate } from '../sim/match.ts';
import { chance, hashString, int, makeRng, type Rng } from '../sim/rng.ts';
import type { CrestPattern } from './names.ts';

export const COMP_SIZE = 8;
export const QUICK_HALF_SECONDS = 60;
export const CUP_ROUNDS = ['Quarter-final', 'Semi-final', 'Final'] as const;

/** Money for reaching each stage of the cup: played a QF, reached the SF, reached the final, won it. */
export const CUP_PRIZES = [40_000, 90_000, 160_000, 320_000] as const;
/** Season prize money by finishing position, 1st to 8th. */
export const SEASON_PRIZES = [450_000, 300_000, 200_000, 140_000, 100_000, 70_000, 50_000, 30_000] as const;

export interface Tie {
  a: string;
  b: string;
  ga?: number;
  gb?: number;
  /** Shootout score when the match was drawn. */
  pens?: [number, number];
  winner?: string;
}

export interface Cup {
  kind: 'cup';
  edition: number;
  seed: number;
  /** Entrant club ids, best seed first. Your club uses its own id. */
  entrants: string[];
  /** rounds[0] = quarter-finals (4 ties), [1] = semis (2), [2] = final (1). */
  rounds: Tie[][];
  round: number;
  done: boolean;
  winner?: string;
  /** Prize money paid to you so far. */
  earned: number;
}

export interface Fixture {
  home: string;
  away: string;
  hg?: number;
  ag?: number;
}

export interface Season {
  kind: 'season';
  edition: number;
  seed: number;
  entrants: string[];
  /** matchdays[d] holds the four fixtures of matchday d. */
  matchdays: Fixture[][];
  matchday: number;
  done: boolean;
  /** Your finishing position, 1-based, once done. */
  finish?: number;
  earned: number;
}

export interface Trophy {
  kind: 'cup' | 'season';
  title: string;
  edition: number;
  /** How many matches your club had played when it was won: a timestamp that needs no clock. */
  atMatch: number;
}

export interface CompClub extends ClubIdentity {
  elo: number;
  you: boolean;
}

/** Fill in defaults for saves written before competitions existed. Safe to call repeatedly. */
export function ensureCompetitionFields(save: Save): void {
  save.cup ??= null;
  save.season ??= null;
  save.trophies ??= [];
  save.cupEditions ??= 0;
  save.seasonEditions ??= 0;
}

export function clubById(save: Save, id: string): CompClub | null {
  if (id === save.club.id) return { ...save.club, you: true };
  const c = save.ladder.find((x) => x.id === id);
  return c ? { ...c, you: false } : null;
}

const name = (save: Save, id: string): string => clubById(save, id)?.name ?? 'Unknown';

/** You plus the seven ladder clubs nearest your Elo, best Elo first. */
export function pickEntrants(save: Save): string[] {
  const others = [...save.ladder]
    .sort((x, y) => Math.abs(x.elo - save.club.elo) - Math.abs(y.elo - save.club.elo) || x.id.localeCompare(y.id))
    .slice(0, COMP_SIZE - 1);
  const all: { id: string; elo: number }[] = [...others, { id: save.club.id, elo: save.club.elo }];
  return all.sort((x, y) => y.elo - x.elo || x.id.localeCompare(y.id)).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Quick simulation

export interface QuickResult {
  ga: number;
  gb: number;
}

/** Plays CPU club a against CPU club b. Swappable so tests can stay fast. */
export type QuickSim = (save: Save, a: LadderClub, b: LadderClub, seed: number) => QuickResult;

export const realQuickSim: QuickSim = (_save, a, b, seed) => {
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const s = simulate({ seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: QUICK_HALF_SECONDS });
  return { ga: s.score[0], gb: s.score[1] };
};

const subSeed = (seed: number, ...parts: (string | number)[]): number => hashString(`${seed}:${parts.join(':')}`) >>> 1;

function ladderClub(save: Save, id: string): LadderClub {
  const c = save.ladder.find((x) => x.id === id);
  if (!c) throw new Error(`Competition club ${id} is not on the ladder`);
  return c;
}

// ---------------------------------------------------------------------------
// Penalties

/** Shooting (0..1) of the five best penalty takers in a lineup, and the keeper's goalkeeping. */
export function penaltySquad(squad: Player[], lineup: string[]): { takers: number[]; keeper: number } {
  const xi = lineup.map((id) => squad.find((p) => p.id === id)).filter((p): p is Player => !!p);
  const keeper = (xi[0]?.attrs.goalkeeping ?? 50) / 100;
  const takers = xi
    .slice(1)
    .map((p) => p.attrs.shooting / 100)
    .sort((x, y) => y - x);
  while (takers.length < 5) takers.push(0.4);
  return { takers: takers.slice(0, 5), keeper };
}

export function penaltyChance(shooting: number, goalkeeping: number): number {
  return Math.min(0.95, Math.max(0.45, 0.74 + 0.35 * (shooting - 0.6) - 0.3 * (goalkeeping - 0.6)));
}

/** Best of five each, then sudden death. Never returns a draw. */
export function penaltyShootout(r: Rng, a: { takers: number[]; keeper: number }, b: { takers: number[]; keeper: number }): [number, number] {
  let sa = 0;
  let sb = 0;
  for (let k = 0; k < 5; k++) {
    if (chance(r, penaltyChance(a.takers[k], b.keeper))) sa++;
    if (chance(r, penaltyChance(b.takers[k], a.keeper))) sb++;
    // Stop once one side can't catch up.
    const left = 4 - k;
    if (sa > sb + left || sb > sa + left) return [sa, sb];
  }
  for (let k = 0; k < 30 && sa === sb; k++) {
    const ia = (5 + k) % a.takers.length;
    const ib = (5 + k) % b.takers.length;
    const ha = chance(r, penaltyChance(a.takers[ia], b.keeper));
    const hb = chance(r, penaltyChance(b.takers[ib], a.keeper));
    sa += ha ? 1 : 0;
    sb += hb ? 1 : 0;
  }
  if (sa === sb) {
    if (chance(r, 0.5)) sa++;
    else sb++;
  }
  return [sa, sb];
}

function penaltySideFor(save: Save, id: string): { takers: number[]; keeper: number } {
  if (id === save.club.id) return penaltySquad(save.squad, save.lineup);
  const squad = ladderSquad(ladderClub(save, id));
  return penaltySquad(squad, autoLineup(squad));
}

function settleTie(save: Save, cup: Cup, tie: Tie, round: number, index: number): void {
  const ga = tie.ga!;
  const gb = tie.gb!;
  if (ga !== gb) {
    tie.winner = ga > gb ? tie.a : tie.b;
    return;
  }
  const r = makeRng(subSeed(cup.seed, 'pens', round, index));
  tie.pens = penaltyShootout(r, penaltySideFor(save, tie.a), penaltySideFor(save, tie.b));
  tie.winner = tie.pens[0] > tie.pens[1] ? tie.a : tie.b;
}

// ---------------------------------------------------------------------------
// Cup

export function canStart(save: Save): { ok: boolean; message: string } {
  if (save.lineup.filter(Boolean).length < 6) return { ok: false, message: 'Pick six players first.' };
  if (save.ladder.length < COMP_SIZE - 1) return { ok: false, message: 'Not enough clubs on the ladder.' };
  return { ok: true, message: '' };
}

export function startCup(save: Save): Cup {
  ensureCompetitionFields(save);
  const entrants = pickEntrants(save);
  // Seeds 1v8, 4v5, 2v7, 3v6, so the top two can only meet in the final.
  const order = [0, 7, 3, 4, 1, 6, 2, 5];
  const qf: Tie[] = [];
  for (let k = 0; k < order.length; k += 2) qf.push({ a: entrants[order[k]], b: entrants[order[k + 1]] });
  const edition = save.cupEditions! + 1;
  save.cupEditions = edition;
  const cup: Cup = { kind: 'cup', edition, seed: int(save.rng, 1, 2 ** 31 - 1), entrants, rounds: [qf, [], []], round: 0, done: false, earned: 0 };
  save.cup = cup;
  const opp = cupOpponent(save, cup);
  save.news.push(`Entered Cup ${edition}. Quarter-final against ${opp?.name ?? 'TBC'}.`);
  return cup;
}

/** Your tie in the current round, or null if you're out or the cup is over. */
export function yourTie(save: Save, cup: Cup): Tie | null {
  if (cup.done) return null;
  return cup.rounds[cup.round].find((t) => (t.a === save.club.id || t.b === save.club.id) && t.winner === undefined) ?? null;
}

export function cupOpponent(save: Save, cup: Cup): LadderClub | null {
  const t = yourTie(save, cup);
  if (!t) return null;
  return ladderClub(save, t.a === save.club.id ? t.b : t.a);
}

export function isOut(save: Save, cup: Cup): boolean {
  return cup.rounds.some((r) => r.some((t) => t.winner !== undefined && (t.a === save.club.id || t.b === save.club.id) && t.winner !== save.club.id));
}

export interface CompOutcome {
  /** One-line summary for the result screen. */
  note: string;
  money: number;
  trophy: Trophy | null;
  /** Training sessions, prize money and player development from this match. */
  summary: ResultSummary;
}

/** Quick-simulate every unplayed CPU tie in the current round, then advance if the round is complete. */
function finishCupRound(save: Save, cup: Cup, sim: QuickSim): void {
  const round = cup.round;
  cup.rounds[round].forEach((t, k) => {
    if (t.winner !== undefined) return;
    if (t.a === save.club.id || t.b === save.club.id) return;
    const r = sim(save, ladderClub(save, t.a), ladderClub(save, t.b), subSeed(cup.seed, 'tie', round, k));
    t.ga = r.ga;
    t.gb = r.gb;
    settleTie(save, cup, t, round, k);
  });
  if (cup.rounds[round].some((t) => t.winner === undefined)) return;
  if (round === CUP_ROUNDS.length - 1) {
    cup.done = true;
    cup.winner = cup.rounds[round][0].winner;
    return;
  }
  const winners = cup.rounds[round].map((t) => t.winner!);
  const nextTies: Tie[] = [];
  for (let k = 0; k < winners.length; k += 2) nextTies.push({ a: winners[k], b: winners[k + 1] });
  cup.rounds[round + 1] = nextTies;
  cup.round = round + 1;
}

/**
 * Record your live cup match (goals for and against), settle a draw on
 * penalties, play the round's other ties, pay prize money and, if it was the
 * final and you won, add the trophy.
 */
export function recordCupMatch(save: Save, gf: number, ga: number, scorers: string[] = [], sim: QuickSim = realQuickSim): CompOutcome {
  ensureCompetitionFields(save);
  const cup = save.cup;
  if (!cup) throw new Error('No cup in progress');
  const tie = yourTie(save, cup);
  if (!tie) throw new Error('You have no cup tie to play');
  const round = cup.round;
  const home = tie.a === save.club.id;
  tie.ga = home ? gf : ga;
  tie.gb = home ? ga : gf;
  settleTie(save, cup, tie, round, cup.rounds[round].indexOf(tie));
  const won = tie.winner === save.club.id;
  const oppId = home ? tie.b : tie.a;
  const opp = ladderClub(save, oppId);
  const stage = CUP_ROUNDS[round];
  const pens = tie.pens ? ` (${home ? tie.pens[0] : tie.pens[1]}–${home ? tie.pens[1] : tie.pens[0]} on penalties)` : '';

  const summary = applyResult(save, null, { name: opp.name, short: opp.short }, gf, ga, false, scorers, `Cup ${stage.toLowerCase()}`);
  save.trainingPoints += 1;
  summary.trainingPoints += 1;

  let money = round === 0 ? CUP_PRIZES[0] : 0;
  if (won) money += CUP_PRIZES[round + 1];
  cup.earned += money;
  save.budget += money;
  summary.money = money;

  finishCupRound(save, cup, sim);
  let trophy: Trophy | null = null;
  let note: string;
  if (won && round === CUP_ROUNDS.length - 1) {
    trophy = { kind: 'cup', title: `Cup ${cup.edition}`, edition: cup.edition, atMatch: save.history.length };
    save.trophies!.push(trophy);
    note = `Cup winners${pens}! +${formatMoney(money)}.`;
    save.news.push(`Won Cup ${cup.edition}, beating ${opp.name} in the final${pens}.`);
  } else if (won) {
    note = `Through to the ${CUP_ROUNDS[round + 1].toLowerCase()}${pens}. +${formatMoney(money)}.`;
  } else {
    note = `Out in the ${stage.toLowerCase()}${pens}.${money ? ` +${formatMoney(money)} for taking part.` : ''}`;
    save.news.push(`Knocked out of Cup ${cup.edition} by ${opp.name} in the ${stage.toLowerCase()}${pens}.`);
  }
  if (save.news.length > 40) save.news.splice(0, save.news.length - 40);
  return { note, money, trophy, summary };
}

/** After you're knocked out: play out the remaining rounds without you. */
export function simulateRestOfCup(save: Save, sim: QuickSim = realQuickSim): void {
  const cup = save.cup;
  if (!cup || cup.done) return;
  for (let guard = 0; guard < CUP_ROUNDS.length && !cup.done; guard++) {
    if (yourTie(save, cup)) return;
    finishCupRound(save, cup, sim);
  }
  if (cup.done && cup.winner) save.news.push(`${name(save, cup.winner)} won Cup ${cup.edition}.`);
}

/** Clear a finished (or abandoned) cup so a new one can start. */
export function closeCup(save: Save): void {
  save.cup = null;
}

// ---------------------------------------------------------------------------
// Season

/** Single round robin by the circle method: n-1 matchdays, n/2 fixtures each, home and away balanced. */
export function roundRobin(ids: string[]): Fixture[][] {
  const n = ids.length;
  const rot = ids.slice(1);
  const days: Fixture[][] = [];
  for (let d = 0; d < n - 1; d++) {
    const ring = [ids[0], ...rot];
    const day: Fixture[] = [];
    for (let k = 0; k < n / 2; k++) {
      const x = ring[k];
      const y = ring[n - 1 - k];
      // The fixed club alternates home and away; the other pairs alternate by position (Berger tables).
      const xHome = k === 0 ? d % 2 === 0 : k % 2 === 1;
      day.push(xHome ? { home: x, away: y } : { home: y, away: x });
    }
    days.push(day);
    rot.unshift(rot.pop()!);
  }
  return days;
}

export function startSeason(save: Save): Season {
  ensureCompetitionFields(save);
  const entrants = pickEntrants(save);
  const edition = save.seasonEditions! + 1;
  save.seasonEditions = edition;
  const seed = int(save.rng, 1, 2 ** 31 - 1);
  // Shuffle the schedule order so you don't always open against the top seed.
  const r = makeRng(subSeed(seed, 'order'));
  const order = [...entrants];
  for (let k = order.length - 1; k > 0; k--) {
    const j = int(r, 0, k);
    [order[k], order[j]] = [order[j], order[k]];
  }
  const season: Season = { kind: 'season', edition, seed, entrants, matchdays: roundRobin(order), matchday: 0, done: false, earned: 0 };
  save.season = season;
  save.news.push(`Season ${edition} kicks off: ${COMP_SIZE} clubs, ${COMP_SIZE - 1} matchdays.`);
  return season;
}

export function yourFixture(save: Save, season: Season): Fixture | null {
  if (season.done) return null;
  return season.matchdays[season.matchday].find((f) => f.home === save.club.id || f.away === save.club.id) ?? null;
}

export function seasonOpponent(save: Save, season: Season): LadderClub | null {
  const f = yourFixture(save, season);
  if (!f) return null;
  return ladderClub(save, f.home === save.club.id ? f.away : f.home);
}

export interface TableRow {
  id: string;
  name: string;
  short: string;
  primary: string;
  secondary: string;
  crest: CrestPattern;
  you: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

/** League table: 3 for a win, 1 for a draw; then goal difference, goals scored, name. */
export function seasonTable(save: Save, season: Season): TableRow[] {
  const rows = new Map<string, TableRow>();
  for (const id of season.entrants) {
    const c = clubById(save, id);
    rows.set(id, {
      id,
      name: c?.name ?? 'Unknown',
      short: c?.short ?? '???',
      primary: c?.primary ?? '#888888',
      secondary: c?.secondary ?? '#ffffff',
      crest: c?.crest ?? 'plain',
      you: id === save.club.id,
      played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0,
    });
  }
  for (const day of season.matchdays) {
    for (const f of day) {
      if (f.hg === undefined || f.ag === undefined) continue;
      const h = rows.get(f.home)!;
      const a = rows.get(f.away)!;
      tally(h, f.hg, f.ag);
      tally(a, f.ag, f.hg);
    }
  }
  return [...rows.values()].sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name));
}

function tally(r: TableRow, gf: number, ga: number): void {
  r.played++;
  r.gf += gf;
  r.ga += ga;
  r.gd = r.gf - r.ga;
  if (gf > ga) {
    r.won++;
    r.points += 3;
  } else if (gf === ga) {
    r.drawn++;
    r.points += 1;
  } else r.lost++;
}

export function seasonVerdict(position: number): string {
  if (position === 1) return 'Champions. Promoted as title winners.';
  if (position === 2) return 'Runners-up. Promoted.';
  if (position <= 4) return 'A top-half finish. Promotion play-off places next time.';
  if (position <= 6) return 'Mid-table. Safe, but the board wants more.';
  return 'Bottom two. Relegation form: the board expects a response.';
}

/**
 * Record your live league match, quick-simulate the rest of the matchday and,
 * after the last matchday, settle the table, prize money and any trophy.
 */
export function recordSeasonMatch(save: Save, gf: number, ga: number, scorers: string[] = [], sim: QuickSim = realQuickSim): CompOutcome {
  ensureCompetitionFields(save);
  const season = save.season;
  if (!season) throw new Error('No season in progress');
  const f = yourFixture(save, season);
  if (!f) throw new Error('You have no league fixture to play');
  const home = f.home === save.club.id;
  f.hg = home ? gf : ga;
  f.ag = home ? ga : gf;
  const opp = ladderClub(save, home ? f.away : f.home);
  const md = season.matchday;
  const summary = applyResult(save, null, { name: opp.name, short: opp.short }, gf, ga, false, scorers, `League matchday ${md + 1}`);
  save.trainingPoints += 1;
  summary.trainingPoints += 1;

  season.matchdays[md].forEach((x, k) => {
    if (x.hg !== undefined) return;
    const r = sim(save, ladderClub(save, x.home), ladderClub(save, x.away), subSeed(season.seed, 'md', md, k));
    x.hg = r.ga;
    x.ag = r.gb;
  });
  season.matchday++;

  const table = seasonTable(save, season);
  const pos = table.findIndex((r) => r.you) + 1;
  if (season.matchday < season.matchdays.length) {
    return { note: `Matchday ${md + 1} of ${season.matchdays.length}. You're ${ordinal(pos)} on ${table[pos - 1].points} point${table[pos - 1].points === 1 ? '' : 's'}.`, money: 0, trophy: null, summary };
  }
  season.done = true;
  season.finish = pos;
  const money = SEASON_PRIZES[pos - 1] ?? 0;
  season.earned += money;
  save.budget += money;
  summary.money = money;
  let trophy: Trophy | null = null;
  if (pos === 1) {
    trophy = { kind: 'season', title: `League ${season.edition}`, edition: season.edition, atMatch: save.history.length };
    save.trophies!.push(trophy);
  }
  save.news.push(`Season ${season.edition} over: finished ${ordinal(pos)}. ${seasonVerdict(pos)} +${formatMoney(money)}.`);
  if (save.news.length > 40) save.news.splice(0, save.news.length - 40);
  return { note: `Final table: ${ordinal(pos)}. ${seasonVerdict(pos)} +${formatMoney(money)}.`, money, trophy, summary };
}

export function closeSeason(save: Save): void {
  save.season = null;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Average overall of a club's starting six, for previews. */
export function clubStrength(save: Save, id: string): number {
  if (id === save.club.id) {
    const xi = save.lineup.map((x) => save.squad.find((p) => p.id === x)).filter((p): p is Player => !!p);
    return Math.round(xi.reduce((t, p) => t + overall(p), 0) / Math.max(1, xi.length));
  }
  const squad = ladderSquad(ladderClub(save, id));
  const xi = autoLineup(squad).map((x) => squad.find((p) => p.id === x)!);
  return Math.round(xi.reduce((t, p) => t + overall(p), 0) / Math.max(1, xi.length));
}
