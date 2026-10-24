// Long-term progression: the club calendar and the end-of-season rollover.
//
// Calendar. `save.week` counts ranked and competition matches (applyResult in
// game.ts adds one per match; practice friendlies don't count), but only once
// the calendar is unlocked at club level 10 (src/meta/levels.ts): before that
// no week passes and nothing rolls over. A "year" is
// SEASON_WEEKS = 10 weeks, so it is the same length whichever mode you play,
// even if you never touch the league. Year N ends when week reaches
// N * SEASON_WEEKS. We chose a fixed calendar over "end of each league" because
// the league is optional and 7 matchdays long: a ladder-only player would never
// see time pass. Callers run maybeRollover(save) after a match has been fully
// recorded (cup/league rounds included), never in the middle of recording one.
//
// Rollover (runRollover), all seeded from save.rng so a save replays
// identically:
//  1. every player ages a year and their attributes move along an age curve
//  2. potential is re-estimated (youngsters can break out or stall)
//  3. players 34+ may retire (never below MIN_SQUAD, never the last keeper)
//  4. 2-3 academy prospects aged 16-17 arrive, if the squad has room; the rest
//     are held as offers you can sign by releasing someone
//  5. the CPU ladder drifts in Elo/quality and every club's squad is regenerated
//     from its seed offset by `era`
// Wages are not modelled (kept simple on purpose).

import { assignNumbers, autoLineup, qualityForElo } from './club.ts';
import { MIN_SQUAD, type Outcome, type Save } from './game.ts';
import { scoutMatchesFor, squadCap } from './levels.ts';
import { ATTR_KEYS, generatePlayer, overall, shortName, type AttrKey, type Player } from './player.ts';
import { gauss, hashString, int, next, pick, type Rng } from '../sim/rng.ts';
import type { Role } from '../sim/constants.ts';

/** Ranked/competition matches in a year. */
export const SEASON_WEEKS = 10;
/** Matches an academy prospect must play before their potential is shown exactly. */
export const SCOUT_MATCHES = 6;
export const MIN_RETIRE_AGE = 34;

// ---------------------------------------------------------------------------
// Review data (stored on the save, so a reload keeps it)

export interface PlayerChange {
  id: string;
  name: string;
  role: Role;
  age: number;
  before: number;
  after: number;
  potBefore: number;
  potAfter: number;
}

export interface RetiredEntry {
  name: string;
  role: Role;
  age: number;
  overall: number;
}

export interface IntakeEntry {
  id: string;
  name: string;
  role: Role;
  age: number;
  overall: number;
  /** Scouting estimate at intake: 1..5 stars and the fogged potential range as text. */
  stars: number;
  range: string;
  /** Joined the squad straight away (otherwise held as an offer). */
  joined: boolean;
}

export interface LadderMove {
  name: string;
  before: number;
  after: number;
}

export interface SeasonRecord {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  eloStart: number;
  eloEnd: number;
  trophies: string[];
}

export interface SeasonReview {
  /** The year that just finished. */
  year: number;
  /** True once the player has dismissed it. */
  seen: boolean;
  record: SeasonRecord;
  improved: number;
  declined: number;
  steady: number;
  /** Biggest overall movers, at most 5, biggest swing first. */
  changes: PlayerChange[];
  retired: RetiredEntry[];
  intake: IntakeEntry[];
  /** Prospects from last year's offers that nobody signed. */
  expiredOffers: number;
  risers: LadderMove[];
  fallers: LadderMove[];
}

// ---------------------------------------------------------------------------
// Save compatibility and calendar

/** Fill in defaults for saves written before the club calendar existed. Safe to call repeatedly. */
export function ensureProgressionFields(save: Save): void {
  if (save.week === undefined) {
    let n = 0;
    for (const m of save.history) {
      if (m.ranked || m.competition) m.week = ++n;
    }
    save.week = n;
  }
  save.year ??= Math.floor(save.week / SEASON_WEEKS) + 1;
  save.review ??= null;
  save.offers ??= [];
}

/** Week within the current year, 0 (before the first match of a year) to SEASON_WEEKS. */
export function weekOfYear(save: Save): number {
  const week = save.week ?? 0;
  const year = save.year ?? 1;
  return Math.max(0, Math.min(SEASON_WEEKS, week - (year - 1) * SEASON_WEEKS));
}

export function rolloverDue(save: Save): boolean {
  return (save.week ?? 0) >= (save.year ?? 1) * SEASON_WEEKS;
}

/** Runs the rollover if the calendar says so. Returns the review, or null when not due. */
export function maybeRollover(save: Save): SeasonReview | null {
  ensureProgressionFields(save);
  return rolloverDue(save) ? runRollover(save) : null;
}

// ---------------------------------------------------------------------------
// Scouting fog

export const starsFor = (potential: number): number => Math.max(1, Math.min(5, Math.round((potential - 45) / 8)));
export const starText = (n: number): string => '★'.repeat(n) + '☆'.repeat(5 - n);

export interface PotentialView {
  lo: number;
  hi: number;
  stars: number;
  /** True once the potential is known exactly. */
  exact: boolean;
}

/**
 * What the scouts will tell you about a player's potential. Prospects with
 * fog left get a range that narrows (around the truth, deterministically per
 * player) as they play; everyone else is exact.
 */
export function scoutedPotential(p: Player): PotentialView {
  const fog = p.scout ?? 0;
  if (fog <= 0) return { lo: p.potential, hi: p.potential, stars: starsFor(p.potential), exact: true };
  const width = 2 * Math.ceil((fog * 4) / SCOUT_MATCHES);
  const frac = ((hashString(p.id) >>> 0) % 1000) / 1000;
  const lo = Math.max(1, p.potential - Math.round(width * frac));
  const hi = Math.min(99, lo + width);
  return { lo, hi, stars: starsFor((lo + hi) / 2), exact: false };
}

/** "68" for a known player, "62–70" while scouting is still in progress. */
export function potentialText(p: Player): string {
  const v = scoutedPotential(p);
  return v.exact ? String(v.hi) : `${v.lo}–${v.hi}`;
}

// ---------------------------------------------------------------------------
// Ageing

/**
 * Mean yearly change for one attribute at `age` (the age they turn), before
 * noise. Positive while young, ~0 in the prime, negative after 30 with pace
 * and stamina going first. `gap` is potential minus overall.
 */
export function attrDrift(age: number, key: AttrKey, gap: number): number {
  if (age <= 23) return Math.min(7, 0.5 + Math.max(0, gap) * 0.3);
  if (age <= 27) return (gap > 0 ? 0.8 : 0.2) + (age === 24 ? 0.2 : 0);
  if (age <= 30) {
    if (key === 'pace') return age === 30 ? -0.5 : -0.2;
    if (key === 'stamina') return age === 30 ? -0.4 : 0;
    return 0;
  }
  const yrs = age - 30;
  switch (key) {
    case 'pace': return -(1.2 + 0.7 * yrs);
    case 'stamina': return -(1.0 + 0.6 * yrs);
    case 'dribbling': return -(0.4 + 0.4 * yrs);
    case 'shooting': return -(0.3 + 0.3 * yrs);
    case 'defending': return -(0.2 + 0.3 * yrs);
    case 'passing': return -(0.1 + 0.15 * yrs);
    case 'goalkeeping': return -0.2 * Math.max(0, age - 32);
  }
}

function attrDelta(r: Rng, age: number, key: AttrKey, gap: number): number {
  const mean = attrDrift(age, key, gap);
  if (age <= 23) return Math.max(0, Math.round(mean + gauss(r) * 1.2));
  if (age <= 27) return Math.max(-1, Math.min(3, Math.round(mean + gauss(r) * 0.7)));
  if (age <= 30) return Math.max(-1, Math.min(1, Math.round(mean + gauss(r) * 0.6)));
  return Math.max(-7, Math.min(0, Math.round(mean + gauss(r) * 0.8)));
}

/** Re-estimate potential after a year of development. Never below current overall, never above 95. */
function reestimatePotential(r: Rng, p: Player): void {
  const ovr = overall(p);
  let pot = p.potential;
  if (p.age <= 21) {
    const roll = next(r);
    if (roll < 0.1) pot += int(r, 3, 8); // breakout
    else if (roll < 0.18) pot -= int(r, 2, 5); // stalled
    else pot += Math.round(gauss(r) * 1.5);
  } else if (p.age <= 23) pot += Math.round(gauss(r) * 1.5);
  else if (p.age <= 27) pot += Math.round(gauss(r) * 0.7);
  else pot = ovr; // the ceiling is where you are
  p.potential = Math.max(ovr, Math.min(95, pot));
}

/**
 * Age a player one year in place: age, attributes along the curve, then the
 * potential re-estimate. Returns overall before and after.
 */
export function agePlayer(r: Rng, p: Player): { before: number; after: number; potBefore: number } {
  const before = overall(p);
  const potBefore = p.potential;
  p.age++;
  const gap = p.potential - before;
  for (const k of ATTR_KEYS) {
    if (k === 'goalkeeping' && p.role !== 'GK') continue;
    p.attrs[k] = Math.max(1, Math.min(99, p.attrs[k] + attrDelta(r, p.age, k, gap)));
  }
  reestimatePotential(r, p);
  return { before, after: overall(p), potBefore };
}

/** Chance a player retires after turning `age`: none before 34, then 15%, 35%, 55%, 75%, 95%, certain. */
export const retireChance = (age: number): number => (age < MIN_RETIRE_AGE ? 0 : Math.min(1, 0.15 + 0.2 * (age - MIN_RETIRE_AGE)));

// ---------------------------------------------------------------------------
// Youth intake

/** An academy prospect: 16-17, low overall, varied potential with the odd gem. Scouting fog applies. */
export function generateProspect(r: Rng, year: number): Player {
  const role = pick(r, ['GK', 'DEF', 'DEF', 'MID', 'MID', 'FWD', 'FWD'] as Role[]);
  const p = generatePlayer(r, { role, quality: int(r, 36, 48), age: int(r, 16, 17) });
  const roll = next(r);
  const pot = roll < 0.15 ? int(r, 80, 90) : roll < 0.5 ? int(r, 68, 79) : int(r, 54, 67);
  p.potential = Math.min(95, Math.max(pot, overall(p) + 5));
  p.scout = SCOUT_MATCHES;
  // A seeded id, so the same save rolls over to the same prospects.
  p.id = `y${year}-${Math.floor(next(r) * 2 ** 32).toString(36)}`;
  return p;
}

function dropFromLineup(save: Save): void {
  if (save.lineup.some((id) => !save.squad.some((p) => p.id === id))) save.lineup = autoLineup(save.squad);
}

/** Sign an offered prospect. If the squad is full, `releaseId` names who leaves (a free release). */
export function signProspect(save: Save, id: string, releaseId?: string): Outcome {
  ensureProgressionFields(save);
  const offers = save.offers!;
  const p = offers.find((x) => x.id === id);
  if (!p) return { ok: false, message: 'That prospect is no longer on offer.' };
  const cap = squadCap(save);
  if (save.squad.length >= cap) {
    const out = releaseId ? save.squad.find((x) => x.id === releaseId) : undefined;
    if (!out) return { ok: false, message: `Squad is full (${cap}). Choose a player to release.` };
    save.squad = save.squad.filter((x) => x.id !== out.id);
    save.news.push(`Released ${shortName(out)} to make room for the academy.`);
    dropFromLineup(save);
  }
  save.offers = offers.filter((x) => x.id !== id);
  p.number = 0;
  save.squad.push(p);
  assignNumbers(save.squad);
  save.news.push(`Signed academy prospect ${shortName(p)} (${p.role}, ${p.age}).`);
  return { ok: true, message: `${shortName(p)} joins the squad.` };
}

// ---------------------------------------------------------------------------
// Rollover

function seasonRecord(save: Save, year: number): SeasonRecord {
  const from = (year - 1) * SEASON_WEEKS + 1;
  const to = year * SEASON_WEEKS;
  const rec: SeasonRecord = { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, eloStart: save.club.elo, eloEnd: save.club.elo, trophies: [] };
  let first = -1;
  let last = -1;
  let firstRanked = true;
  save.history.forEach((m, i) => {
    if (m.week === undefined || m.week < from || m.week > to) return;
    if (first < 0) first = i;
    last = i;
    rec.played++;
    rec.gf += m.goalsFor;
    rec.ga += m.goalsAgainst;
    if (m.goalsFor > m.goalsAgainst) rec.won++;
    else if (m.goalsFor === m.goalsAgainst) rec.drawn++;
    else rec.lost++;
    if (m.ranked) {
      if (firstRanked) rec.eloStart = m.eloBefore;
      firstRanked = false;
      rec.eloEnd = m.eloAfter;
    }
  });
  if (first >= 0) {
    // A trophy's atMatch is the history length when it was won.
    rec.trophies = (save.trophies ?? []).filter((t) => t.atMatch >= first + 1 && t.atMatch <= last + 1).map((t) => t.title);
  }
  return rec;
}

/** Let every CPU club drift, then bump its era so its squad regenerates from the offset seed. */
function driftLadder(save: Save, r: Rng): { risers: LadderMove[]; fallers: LadderMove[] } {
  const mean = save.ladder.reduce((s, c) => s + c.elo, 0) / Math.max(1, save.ladder.length);
  const moves: LadderMove[] = save.ladder.map((c) => {
    const before = c.elo;
    c.elo = Math.round(Math.max(650, Math.min(1600, c.elo + gauss(r) * 50 + (mean - c.elo) * 0.1)));
    c.quality = qualityForElo(c.elo);
    c.era = (c.era ?? 0) + 1;
    return { name: c.name, before, after: c.elo };
  });
  const byGain = [...moves].sort((a, b) => b.after - b.before - (a.after - a.before));
  return {
    risers: byGain.slice(0, 2).filter((m) => m.after > m.before),
    fallers: byGain.slice(-2).reverse().filter((m) => m.after < m.before),
  };
}

/**
 * The end-of-season rollover. Mutates the save, writes the review to
 * `save.review` and returns it. Call through maybeRollover() unless testing.
 */
export function runRollover(save: Save): SeasonReview {
  ensureProgressionFields(save);
  const r = save.rng;
  const year = save.year!;
  const record = seasonRecord(save, year);

  // 1-2. Age everyone, then retire.
  const changes: PlayerChange[] = [];
  const retired: RetiredEntry[] = [];
  let improved = 0;
  let declined = 0;
  let steady = 0;
  const everyone = [...save.squad];
  const goneIds = new Set<string>();
  for (const p of everyone) {
    const { before, after, potBefore } = agePlayer(r, p);
    const roll = next(r); // always drawn, so a blocked retirement doesn't shift later rolls
    const keepersLeft = everyone.filter((x) => x.role === 'GK' && !goneIds.has(x.id)).length;
    const blocked = everyone.length - goneIds.size <= MIN_SQUAD || (p.role === 'GK' && keepersLeft <= 1);
    if (roll < retireChance(p.age) && !blocked) {
      goneIds.add(p.id);
      retired.push({ name: shortName(p), role: p.role, age: p.age, overall: after });
      save.news.push(`${shortName(p)} (${p.role}, ${p.age}) retires from football.`);
      continue;
    }
    if (after > before) improved++;
    else if (after < before) declined++;
    else steady++;
    if (after !== before) changes.push({ id: p.id, name: shortName(p), role: p.role, age: p.age, before, after, potBefore, potAfter: p.potential });
  }
  save.squad = save.squad.filter((p) => !goneIds.has(p.id));
  changes.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || b.potAfter - a.potAfter || a.name.localeCompare(b.name));
  dropFromLineup(save);

  // 3. Youth intake. Last year's unsigned offers move on.
  const expiredOffers = save.offers!.length;
  save.offers = [];
  const intake: IntakeEntry[] = [];
  const count = int(r, 2, 3);
  for (let k = 0; k < count; k++) {
    const p = generateProspect(r, year);
    p.scout = scoutMatchesFor(save, SCOUT_MATCHES); // one match fewer with the Sharper scouts perk
    const joined = save.squad.length < squadCap(save);
    const view = scoutedPotential(p);
    intake.push({ id: p.id, name: shortName(p), role: p.role, age: p.age, overall: overall(p), stars: view.stars, range: `${view.lo}–${view.hi}`, joined });
    if (joined) {
      p.number = 0;
      save.squad.push(p);
      assignNumbers(save.squad);
      save.news.push(`Academy intake: ${shortName(p)} (${p.role}, ${p.age}) joins the squad.`);
    } else {
      save.offers.push(p);
      save.news.push(`Academy offers ${shortName(p)} (${p.role}, ${p.age}), but the squad is full.`);
    }
  }

  // 4. The CPU world moves on.
  const { risers, fallers } = driftLadder(save, r);

  const review: SeasonReview = {
    year,
    seen: false,
    record,
    improved,
    declined,
    steady,
    changes: changes.slice(0, 5),
    retired,
    intake,
    expiredOffers,
    risers,
    fallers,
  };
  save.review = review;
  save.year = year + 1;
  const top = changes[0];
  save.news.push(
    `Season ${year} review: ${record.won}W ${record.drawn}D ${record.lost}L.${top ? ` Biggest mover: ${top.name} ${top.before} → ${top.after}.` : ''}${retired.length ? ` ${retired.length} retired.` : ''}`,
  );
  if (save.news.length > 40) save.news.splice(0, save.news.length - 40);
  return review;
}
