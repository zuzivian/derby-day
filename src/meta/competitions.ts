// Competitions against the CPU: an 8-club knockout cup and an 8-club league
// season. Pure logic over the Save: data in, data out, seeded randomness only.
//
// Decisions (see also the README):
//  - Your matches are played live; the rest get a full-length scoreline from
//    the clubs' XIs (quickScore in world.ts, a Poisson model calibrated against
//    the full-length sim), in microseconds. The match seed is derived from the
//    competition seed, so a round replays identically. realQuickSim, the real
//    headless sim at full length, stays for tests and probes (half a second a
//    match).
//  - Both are played within your division (src/meta/world.ts): the league is
//    the division, the cup adds three clubs from the division above. Prize
//    money and XP scale with the division, and a league finish promotes or
//    relegates you (applyLeagueFinish).
//  - Competition matches move Elo like ranked ones (yours and the opponent's)
//    but not the ladder record. They pay prize money, training sessions and
//    player development, and are kept in match history labelled with the
//    competition.
//  - A new cup can start only after CUP_WAIT ranked or league matches since
//    the last one started (game.ts), so cups can't be chained or restarted.
//  - Forfeits pay nothing: no match money, and a league season's prize money
//    and finish XP are paid for the matchdays actually played. A season with
//    more than MAX_SEASON_FORFEITS forfeits wins no trophy and no promotion.
//  - A drawn cup tie goes to a penalty shootout. Between two CPU clubs it is
//    settled by a seeded roll weighted by the takers' shooting and the
//    keepers' goalkeeping; when you are in the tie it is played live
//    (src/client/shootout.ts, rules in src/meta/shootout.ts) and its score is
//    passed to recordCupMatch.

import { autoLineup, cpuTeam, ladderSquad, type ClubIdentity, type LadderClub } from './club.ts';
import { applyResult, CUP_WAIT, formatMoney, type ResultSummary, type Save } from './game.ts';
import { lifetimeMatches, noteDivision, noteYear } from './history.ts';
import { award, claimMilestone, cupFinishXp, leagueFinishXp, prizeBonus } from './levels.ts';
import { overall, type Player } from './player.ts';
import { applyLeagueFinish, cpuStrength, DIVISIONS, divisionClubs, divisionMoney, divisionName, divisionXp, ensureWorldFields, playerDivision, quickScore } from './world.ts';
import { simulate } from '../sim/match.ts';
import { HALF_SECONDS, TEAM_SIZE } from '../sim/constants.ts';
import { chance, hashString, int, makeRng, type Rng } from '../sim/rng.ts';
import type { CrestPattern } from './names.ts';

export const COMP_SIZE = 8;
export const CUP_ROUNDS = ['Quarter-final', 'Semi-final', 'Final'] as const;
/** Clubs from the division above in each cup (the rest come from yours). */
export const CUP_GUESTS = 3;
/** Forfeited matchdays a league season can carry and still win a trophy or promotion. */
export const MAX_SEASON_FORFEITS = 2;

/** Money for reaching each stage of the cup in the bottom division: played a QF, reached the SF, reached the final, won it. Times DIVISION_MONEY. */
export const CUP_PRIZES = [40_000, 90_000, 160_000, 320_000] as const;
/** Season prize money by finishing position, 1st to 8th, in the bottom division. Times DIVISION_MONEY. */
export const SEASON_PRIZES = [450_000, 300_000, 200_000, 140_000, 100_000, 70_000, 50_000, 30_000] as const;

const round5k = (n: number) => Math.round(n / 5_000) * 5_000;
/** A prize in your division. */
export const prizeIn = (base: number, division: number): number => round5k(base * divisionMoney(division));

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
  /** Your division when it started (prizes and XP are paid at its rates). Missing on older cups: the bottom division. */
  division?: number;
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
  /** The division it is played in (yours when it started). Missing on older seasons: the bottom division. */
  division?: number;
  /** Matchdays you forfeited. */
  forfeits?: number;
  /** Where the finish took you, once done. */
  moved?: 'up' | 'down' | null;
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

/**
 * The entrants, best Elo first, you included. A league is your division. A cup
 * is your division's clubs nearest your Elo plus the CUP_GUESTS nearest it from
 * the division above (in the top division, the whole division). Your Elo only
 * picks among your division, so losing it on purpose can't buy an easier draw.
 */
export function pickEntrants(save: Save, kind: 'cup' | 'league' = 'league'): string[] {
  ensureWorldFields(save);
  const d = playerDivision(save);
  const near = (cs: LadderClub[]) => [...cs].sort((x, y) => Math.abs(x.elo - save.club.elo) - Math.abs(y.elo - save.club.elo) || x.id.localeCompare(y.id));
  const own = near(divisionClubs(save, d));
  const guests = kind === 'cup' && d > 1 ? near(divisionClubs(save, d - 1)).slice(0, CUP_GUESTS) : [];
  let others = [...guests, ...own.slice(0, COMP_SIZE - 1 - guests.length)];
  // A division short of clubs (it never should be) borrows the nearest Elo from anywhere.
  if (others.length < COMP_SIZE - 1) others = [...others, ...near(save.ladder.filter((c) => !others.includes(c))).slice(0, COMP_SIZE - 1 - others.length)];
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

/** The default: a full-length scoreline from the two XIs (quickScore in world.ts). */
export const modelQuickSim: QuickSim = (_save, a, b, seed) => {
  const [ga, gb] = quickScore(makeRng(seed), cpuStrength(a), cpuStrength(b));
  return { ga, gb };
};

/** The real headless sim at full length (half a second a match), for tests and probes. */
export const realQuickSim: QuickSim = (_save, a, b, seed) => {
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const s = simulate({ seed, home: cpuTeam(a, sa), away: cpuTeam(b, sb), halfSeconds: HALF_SECONDS });
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

/** The score of a live shootout you played, from your side. It always has a winner. */
export interface HumanPens {
  you: number;
  opp: number;
}

function settleTie(save: Save, cup: Cup, tie: Tie, round: number, index: number, humanPens?: HumanPens): void {
  const ga = tie.ga!;
  const gb = tie.gb!;
  if (ga !== gb) {
    tie.winner = ga > gb ? tie.a : tie.b;
    return;
  }
  if (humanPens && humanPens.you !== humanPens.opp && (tie.a === save.club.id || tie.b === save.club.id)) {
    tie.pens = tie.a === save.club.id ? [humanPens.you, humanPens.opp] : [humanPens.opp, humanPens.you];
    tie.winner = tie.pens[0] > tie.pens[1] ? tie.a : tie.b;
    return;
  }
  const r = makeRng(subSeed(cup.seed, 'pens', round, index));
  tie.pens = penaltyShootout(r, penaltySideFor(save, tie.a), penaltySideFor(save, tie.b));
  tie.winner = tie.pens[0] > tie.pens[1] ? tie.a : tie.b;
}

// ---------------------------------------------------------------------------
// Cup

/** Ranked or league matches still to play before a new cup can start (0 when it can). */
export const cupWaitLeft = (save: Save): number => Math.max(0, save.cupWait ?? 0);

/** "Next cup after 3 more ranked or league matches." */
export const cupWaitText = (n: number): string => `Next cup after ${n} more ranked or league match${n === 1 ? '' : 'es'}.`;

export function canStart(save: Save, kind: 'cup' | 'league' = 'league'): { ok: boolean; message: string } {
  if (save.lineup.filter(Boolean).length < TEAM_SIZE) return { ok: false, message: 'Pick a full XI first.' };
  if (save.ladder.length < COMP_SIZE - 1) return { ok: false, message: 'Not enough clubs on the ladder.' };
  if (kind === 'cup' && cupWaitLeft(save) > 0) return { ok: false, message: cupWaitText(cupWaitLeft(save)) };
  return { ok: true, message: '' };
}

export function startCup(save: Save): Cup {
  ensureCompetitionFields(save);
  const entrants = pickEntrants(save, 'cup');
  // Seeds 1v8, 4v5, 2v7, 3v6, so the top two can only meet in the final.
  const order = [0, 7, 3, 4, 1, 6, 2, 5];
  const qf: Tie[] = [];
  for (let k = 0; k < order.length; k += 2) qf.push({ a: entrants[order[k]], b: entrants[order[k + 1]] });
  const edition = save.cupEditions! + 1;
  save.cupEditions = edition;
  const cup: Cup = { kind: 'cup', edition, seed: int(save.rng, 1, 2 ** 31 - 1), entrants, rounds: [qf, [], []], round: 0, done: false, earned: 0, division: playerDivision(save) };
  save.cup = cup;
  save.cupWait = CUP_WAIT;
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
 * final and you won, add the trophy. A drawn match is settled by `humanPens`
 * (the live shootout you played) when given, else by the seeded roll.
 */
export function recordCupMatch(save: Save, gf: number, ga: number, scorers: string[] = [], sim: QuickSim = modelQuickSim, forfeited = false, humanPens?: HumanPens): CompOutcome {
  ensureCompetitionFields(save);
  const cup = save.cup;
  if (!cup) throw new Error('No cup in progress');
  const tie = yourTie(save, cup);
  if (!tie) throw new Error('You have no cup tie to play');
  const round = cup.round;
  const home = tie.a === save.club.id;
  tie.ga = home ? gf : ga;
  tie.gb = home ? ga : gf;
  settleTie(save, cup, tie, round, cup.rounds[round].indexOf(tie), humanPens);
  const won = tie.winner === save.club.id;
  const oppId = home ? tie.b : tie.a;
  const opp = ladderClub(save, oppId);
  const stage = CUP_ROUNDS[round];
  const pens = tie.pens ? ` (${home ? tie.pens[0] : tie.pens[1]}–${home ? tie.pens[1] : tie.pens[0]} on penalties)` : '';

  const division = cup.division ?? DIVISIONS;
  const summary = applyResult(save, opp, { name: opp.name, short: opp.short }, gf, ga, false, scorers, `Cup ${stage.toLowerCase()}`, forfeited, 'normal', 'cup');
  // A forfeit knocks you out but pays nothing, so walking off can't be farmed.
  if (!forfeited) {
    save.trainingPoints += 1;
    summary.trainingPoints += 1;
  }

  let money = round === 0 && !forfeited ? prizeIn(CUP_PRIZES[0] * prizeBonus(save), division) : 0;
  if (won) money += prizeIn(CUP_PRIZES[round + 1] * prizeBonus(save), division);
  cup.earned += money;
  save.budget += money;
  summary.money = money;

  finishCupRound(save, cup, sim);
  // XP for how far you went (going out in the semis, the final, winning it). A forfeit earns nothing.
  if (!forfeited) award(save, [cupFinishXp(round, won, divisionXp(division)), won && round === CUP_ROUNDS.length - 1 ? claimMilestone(save, 'first-trophy') : null], summary.xp);
  if (!won || round === CUP_ROUNDS.length - 1) noteYear(save, `Cup ${cup.edition}: ${won ? 'winners' : round === 2 ? 'runners-up' : `out in the ${stage.toLowerCase()}`}`);
  let trophy: Trophy | null = null;
  let note: string;
  if (won && round === CUP_ROUNDS.length - 1) {
    trophy = { kind: 'cup', title: `Cup ${cup.edition}`, edition: cup.edition, atMatch: lifetimeMatches(save) };
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
export function simulateRestOfCup(save: Save, sim: QuickSim = modelQuickSim): void {
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
  const entrants = pickEntrants(save, 'league');
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
  const division = playerDivision(save);
  const season: Season = { kind: 'season', edition, seed, entrants, matchdays: roundRobin(order), matchday: 0, done: false, earned: 0, division, forfeits: 0 };
  save.season = season;
  // "League N" everywhere, so "Season N" only ever means the calendar year.
  save.news.push(`League ${edition} kicks off in ${divisionName(division)}: ${COMP_SIZE} clubs, ${COMP_SIZE - 1} matchdays.`);
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

/**
 * One line on a finish in `division`. `moved` is where it took you
 * (applyLeagueFinish); without it, the line says what the place normally means.
 */
export function seasonVerdict(position: number, division: number = DIVISIONS, moved?: 'up' | 'down' | null): string {
  const up = moved === undefined ? position <= 2 && division > 1 : moved === 'up';
  const down = moved === undefined ? position >= COMP_SIZE - 1 && division < DIVISIONS : moved === 'down';
  if (position === 1) return division === 1 ? 'Champions of the top division.' : up ? `Champions. Promoted to ${divisionName(division - 1)}.` : 'Champions.';
  if (position === 2) return up ? `Runners-up. Promoted to ${divisionName(division - 1)}.` : 'Runners-up.';
  if (position <= 4) return 'A top-half finish.';
  if (position <= 6) return 'Mid-table. Safe, but the board wants more.';
  return down ? `Bottom two. Relegated to ${divisionName(division + 1)}.` : 'Bottom two: the board expects a response.';
}

/**
 * Record your live league match, quick-simulate the rest of the matchday and,
 * after the last matchday, settle the table, prize money and any trophy.
 */
export function recordSeasonMatch(save: Save, gf: number, ga: number, scorers: string[] = [], sim: QuickSim = modelQuickSim, forfeited = false): CompOutcome {
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
  const summary = applyResult(save, opp, { name: opp.name, short: opp.short }, gf, ga, false, scorers, `League matchday ${md + 1}`, forfeited, 'normal', 'league');
  if (forfeited) season.forfeits = (season.forfeits ?? 0) + 1;
  else {
    save.trainingPoints += 1;
    summary.trainingPoints += 1;
  }

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
  const division = season.division ?? DIVISIONS;
  // Prize money and the finish bonus are paid for the matchdays you played; a forfeited season earns nothing.
  const days = season.matchdays.length;
  const share = Math.max(0, days - (season.forfeits ?? 0)) / days;
  const money = Math.round((prizeIn((SEASON_PRIZES[pos - 1] ?? 0) * prizeBonus(save), division) * share) / 5_000) * 5_000;
  season.earned += money;
  save.budget += money;
  summary.money = money;
  // A title or promotion has to be played for. Relegation needs no such proof.
  const honest = (season.forfeits ?? 0) <= MAX_SEASON_FORFEITS;
  let trophy: Trophy | null = null;
  if (pos === 1 && honest) {
    trophy = { kind: 'season', title: `League ${season.edition}`, edition: season.edition, atMatch: lifetimeMatches(save) };
    save.trophies!.push(trophy);
  }
  const finish = leagueFinishXp(pos, divisionXp(division) * share);
  award(save, [finish, trophy ? claimMilestone(save, 'first-trophy') : null], summary.xp);
  // Promotion and relegation, from the division the season was played in.
  const move = honest || pos > 2 ? applyLeagueFinish(save, pos) : { moved: null, division: playerDivision(save) };
  season.moved = move.moved;
  if (move.moved) noteDivision(save, move.division);
  const verdict = seasonVerdict(pos, division, move.moved);
  noteYear(save, `League ${season.edition}: ${ordinal(pos)} in ${divisionName(division)}${move.moved === 'up' ? ', promoted' : move.moved === 'down' ? ', relegated' : ''}`);
  const swap = move.moved && 'swapped' in move && move.swapped ? ` ${move.swapped} go${move.moved === 'up' ? ' down' : ' up'} in your place.` : '';
  save.news.push(`League ${season.edition} over: finished ${ordinal(pos)} in ${divisionName(division)}. ${verdict}${swap} +${formatMoney(money)}.`);
  if (save.news.length > 40) save.news.splice(0, save.news.length - 40);
  return { note: `Final table: ${ordinal(pos)}. ${verdict} +${formatMoney(money)}.`, money, trophy, summary };
}

export function closeSeason(save: Save): void {
  save.season = null;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Average overall of a club's starting eleven, for previews. */
export function clubStrength(save: Save, id: string): number {
  if (id === save.club.id) {
    const xi = save.lineup.map((x) => save.squad.find((p) => p.id === x)).filter((p): p is Player => !!p);
    return Math.round(xi.reduce((t, p) => t + overall(p), 0) / Math.max(1, xi.length));
  }
  const squad = ladderSquad(ladderClub(save, id));
  const xi = autoLineup(squad).map((x) => squad.find((p) => p.id === x)!);
  return Math.round(xi.reduce((t, p) => t + overall(p), 0) / Math.max(1, xi.length));
}
