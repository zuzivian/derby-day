// The football world around your club: a pyramid of DIVISIONS divisions of
// DIVISION_SIZE clubs (you and 31 CPU clubs), whose squads age, retire, bring
// through youth and trade players, with promotion and relegation between them.
//
// Decisions:
//  - A CPU club is a level (`quality`) plus 18 squad slots (club.ts Slot: a
//    player key, an age and a talent). A player's rating is quality + talent +
//    what his age gives, so a squad costs three numbers a player in the save,
//    keeps its names season after season and is rebuilt in microseconds.
//  - Every rollover (developWorld, from runRollover in progression.ts) each CPU
//    club ages a year, its veterans retire for academy youngsters, a few good
//    players move up a division, and its quality drifts toward its division's
//    centre (DIVISION_QUALITY) plus its own ambition. The top division's centre
//    rises with your XI (worldLift), so the strongest clubs are never far below
//    you, however good you get.
//  - CPU divisions play a modelled season at each rollover (quickScore: no
//    sim, calibrated to the full-length sim's scores), and the top two of each
//    division swap with the bottom two of the one above. You move only through
//    your own league: top two go up, bottom two go down (applyLeagueFinish),
//    swapping places with a CPU club, so every division keeps eight clubs.
//  - Your division sets your league's and cup's entrants, their prize money
//    (DIVISION_MONEY) and their XP (DIVISION_XP). Ranked matches still pair
//    you with clubs near your Elo, from any division, and pay by the
//    opponent's division and strength (game.ts).
//  - Everything is seeded from the save's rng or the club seeds: the same save
//    rolls over to the same world.

import {
  ageCurve,
  autoLineup,
  clubFormation,
  eloForQuality,
  emptyRecord,
  generateIdentity,
  ladderSquad,
  makeSlots,
  slotKey,
  slotPlayer,
  slotRating,
  SQUAD_ROLES,
  teamStrength,
  type LadderClub,
  type Slot,
} from './club.ts';
import { averageOverall, formatMoney, type Save } from './game.ts';
import { marketValue, shortName } from './player.ts';
import { retireChance } from './progression.ts';
import { STYLE_KEYS } from './names.ts';
import { gauss, int, makeRng, next, pick, type Rng } from '../sim/rng.ts';

export const DIVISIONS = 4;
export const DIVISION_SIZE = 8;
export const WORLD_CPU_CLUBS = DIVISIONS * DIVISION_SIZE - 1;
/** Every new club starts at the bottom. */
export const START_DIVISION = DIVISIONS;
/** Where each division's squads sit, top division first (before worldLift). A new club's XI is about 54. */
export const DIVISION_QUALITY = [81, 72, 63, 54] as const;
/** League and cup prize money multiplier by division, top first. */
export const DIVISION_MONEY = [3, 2.1, 1.45, 1] as const;
/** Match and finish XP multiplier by division, top first. */
export const DIVISION_XP = [1.75, 1.45, 1.2, 1] as const;
export const MIN_QUALITY = 40;
export const MAX_QUALITY = 92;

const clampDiv = (d: number | undefined): number => Math.max(1, Math.min(DIVISIONS, Math.round(d ?? START_DIVISION)));
export const divisionName = (d: number): string => `Division ${clampDiv(d)}`;
export const divisionMoney = (d: number | undefined): number => DIVISION_MONEY[clampDiv(d) - 1];
export const divisionXp = (d: number | undefined): number => DIVISION_XP[clampDiv(d) - 1];

/** Your division (the bottom one for a save that has none yet). */
export const playerDivision = (save: Save): number => clampDiv(save.division);

/** A CPU club's division. */
export const clubDivision = (c: LadderClub): number => clampDiv(c.division);

/** The CPU clubs in division `d`. */
export const divisionClubs = (save: Save, d: number): LadderClub[] => save.ladder.filter((c) => clubDivision(c) === d);

/** How far above the top division's normal level your XI is: the top divisions rise with you. 0 to 9. */
export function worldLift(xi: number): number {
  return Math.max(0, Math.min(9, xi - (DIVISION_QUALITY[0] + 1)));
}

/** The quality division `d` drifts toward, given the lift. The top division takes all of it, the second half. */
export function divisionCentre(d: number, lift = 0): number {
  const share = [1, 0.5, 0.25, 0][clampDiv(d) - 1];
  return DIVISION_QUALITY[clampDiv(d) - 1] + lift * share;
}

/** Average rating of a CPU club's best XI in its own formation. */
export function cpuStrength(c: LadderClub): number {
  const squad = ladderSquad(c);
  const f = clubFormation(c);
  return teamStrength(squad, autoLineup(squad, f), f);
}

const homeStyleOf = (c: Pick<LadderClub, 'seed'>): number => (c.seed >>> 3) % STYLE_KEYS.length;

/** A CPU club for division `d`, its squad and Elo to match. */
function makeClub(r: Rng, d: number, names: Set<string>): LadderClub {
  let id = generateIdentity(r);
  while (names.has(id.name)) id = generateIdentity(r);
  names.add(id.name);
  const ambition = int(r, -4, 4);
  const quality = Math.round(divisionCentre(d) + ambition + gauss(r) * 1.5);
  const seed = int(r, 1, 2 ** 31 - 1);
  const elo = Math.round(eloForQuality(quality) + gauss(r) * 40);
  return { ...id, ...emptyRecord(), elo, seed, quality, division: d, ambition, slots: makeSlots(r, homeStyleOf({ seed })) };
}

/** A new world: eight clubs in each division, seven in the bottom one, where your club starts. */
export function generateWorld(seed: number): LadderClub[] {
  const r = makeRng(seed);
  const names = new Set<string>();
  const clubs: LadderClub[] = [];
  for (let d = 1; d <= DIVISIONS; d++) {
    const n = d === START_DIVISION ? DIVISION_SIZE - 1 : DIVISION_SIZE;
    for (let k = 0; k < n; k++) clubs.push(makeClub(r, d, names));
  }
  return clubs;
}

// ---------------------------------------------------------------------------
// Older saves

/**
 * Bring a save from before the world up to it. Safe to call on every load.
 *  - Your division is the one whose level is nearest your XI.
 *  - Ladder clubs keep their name, Elo, record and quality, get a division near
 *    their quality and a squad (new names: the old squads were regenerated each
 *    season anyway), and new clubs fill the places left, so nothing anyone was
 *    playing against gets weaker or stronger on load.
 *  - A cup or league in progress keeps its entrants, who are all still here.
 */
export function ensureWorldFields(save: Save): void {
  const complete = save.division !== undefined && save.ladder.every((c) => c.division !== undefined && c.slots?.length === SQUAD_ROLES.length);
  if (complete && save.ladder.length === WORLD_CPU_CLUBS) return;
  const r = makeRng((save.seed ^ 0x3011d) | 0);
  const xi = averageOverall(save);
  const nearest = (q: number) => [...Array(DIVISIONS).keys()].map((k) => k + 1).sort((a, b) => Math.abs(DIVISION_QUALITY[a - 1] - q) - Math.abs(DIVISION_QUALITY[b - 1] - q) || b - a);
  const you = save.division !== undefined ? clampDiv(save.division) : nearest(xi)[0];
  save.division = you;
  const room = Array.from({ length: DIVISIONS }, (_, k) => DIVISION_SIZE - (k + 1 === you ? 1 : 0));
  const placed = save.ladder.filter((c) => c.division !== undefined);
  for (const c of placed) room[clampDiv(c.division) - 1]--;
  // Strongest first, each to the free division nearest its quality.
  const toPlace = save.ladder.filter((c) => c.division === undefined).sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id));
  for (const c of toPlace) {
    const d = nearest(c.quality).find((x) => room[x - 1] > 0) ?? clampDiv(nearest(c.quality)[0]);
    c.division = d;
    room[d - 1]--;
  }
  for (const c of save.ladder) {
    c.ambition ??= Math.max(-4, Math.min(4, Math.round(c.quality - divisionCentre(clubDivision(c)))));
    if (c.slots?.length !== SQUAD_ROLES.length) c.slots = makeSlots(makeRng((c.seed ^ 0x51075) | 0), homeStyleOf(c));
  }
  const names = new Set(save.ladder.map((c) => c.name));
  names.add(save.club.name);
  let added = 0;
  for (let d = 1; d <= DIVISIONS; d++) {
    for (; room[d - 1] > 0; room[d - 1]--) {
      save.ladder.push(makeClub(r, d, names));
      added++;
    }
  }
  if (added) save.news.push(`The league pyramid opens: ${DIVISIONS} divisions of ${DIVISION_SIZE}, ${added} new clubs. ${save.club.name} start in ${divisionName(you)}.`);
}

// ---------------------------------------------------------------------------
// Modelled results (CPU fixtures and CPU seasons)

/**
 * A full-length scoreline for two XIs, from a Poisson model: about 2.6 goals
 * and a quarter of matches drawn between equal sides (like your own matches,
 * not the 1 goal a match and 40% 0-0s of the old 60 s quick sim), and a
 * stronger XI scoring e^(QUICK_SLOPE x gap) times as often, the strength
 * effect measured from 600 full-length CPU v CPU sims (docs/ROADMAP.md, "CPU
 * fixtures"). Microseconds, where a full-length sim takes half a second.
 */
export function quickScore(r: Rng, xa: number, xb: number): [number, number] {
  const d = Math.max(-30, Math.min(30, xa - xb));
  return [poisson(r, QUICK_BASE * Math.exp(QUICK_SLOPE * d)), poisson(r, QUICK_BASE * Math.exp(-QUICK_SLOPE * d))];
}
/** Goals a side scores against an equal XI. */
export const QUICK_BASE = 1.3;
/** Per point of XI difference, on the log scale (the full-length sim fits 0.09; a little gentler keeps upsets alive). */
export const QUICK_SLOPE = 0.07;

function poisson(r: Rng, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = next(r);
  while (p > limit && k < 12) {
    k++;
    p *= next(r);
  }
  return k;
}

interface Standing {
  club: LadderClub;
  points: number;
  gd: number;
  gf: number;
}

/** A modelled single round robin between CPU clubs: the table, best first. */
function cpuSeason(r: Rng, clubs: LadderClub[]): Standing[] {
  const rows = clubs.map((club) => ({ club, points: 0, gd: 0, gf: 0, xi: cpuStrength(club) }));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [ga, gb] = quickScore(r, rows[i].xi, rows[j].xi);
      rows[i].gf += ga;
      rows[j].gf += gb;
      rows[i].gd += ga - gb;
      rows[j].gd += gb - ga;
      rows[i].points += ga > gb ? 3 : ga === gb ? 1 : 0;
      rows[j].points += gb > ga ? 3 : ga === gb ? 1 : 0;
    }
  }
  return rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.club.id.localeCompare(b.club.id));
}

// ---------------------------------------------------------------------------
// The season rollover

export interface ClubMove {
  name: string;
  from: number;
  to: number;
}

/** What happened in the world over a season, for the season review. */
export interface WorldReview {
  /** Top of each division's CPU table, top division first. Your own division is left out (your league decides it). */
  champions: { division: number; name: string }[];
  promoted: ClubMove[];
  relegated: ClubMove[];
  /** "J. Okafor (MID, 24) joins Harrow Albion from Kelmere for ƒ1.20m." */
  transfers: string[];
  /** Notable retirements: "Kelmere's T. Sato (GK, 36) retires." */
  retired: string[];
  /** Quality of the strongest CPU club after the season. */
  topQuality: number;
}

/** Age a CPU squad a year: veterans retire for academy youngsters. Returns the retirements worth a line in the review. */
function ageSquad(r: Rng, c: LadderClub, notable: string[]): void {
  const slots = c.slots!;
  slots.forEach((slot, i) => {
    slot[1]++;
    const roll = next(r); // always drawn, so a kept veteran doesn't shift later rolls
    if (roll >= retireChance(slot[1])) return;
    const rating = slotRating(c.quality, i, slot);
    if (rating >= c.quality + 2 && notable.length < 4) notable.push(`${c.name}'s ${shortName(slotPlayer(c.quality, i, slot))} (${SQUAD_ROLES[i]}, ${slot[1]}) retires.`);
    slots[i] = youth(r, c);
  });
}

/** An academy graduate: 17-19, mostly from the club's home nation, the odd gem. */
function youth(r: Rng, c: LadderClub): Slot {
  const style = next(r) < 0.7 ? homeStyleOf(c) : int(r, 0, STYLE_KEYS.length - 1);
  const talent = next(r) < 0.08 ? int(r, 6, 9) : int(r, -6, 4);
  return [slotKey(r, style), int(r, 17, 19), talent];
}

/** A few good players move up a division each season. */
function transferWindow(r: Rng, save: Save, lines: string[]): void {
  const deals = int(r, 3, 5);
  for (let k = 0; k < deals; k++) {
    const d = int(r, 1, DIVISIONS - 1);
    const buyers = divisionClubs(save, d);
    const sellers = divisionClubs(save, d + 1);
    if (!buyers.length || !sellers.length) continue;
    const buyer = pick(r, buyers);
    const seller = pick(r, sellers);
    // The seller's best player of 30 or under (never the reserve keeper).
    let best = -1;
    seller.slots!.forEach((s, i) => {
      if (i === 1 || s[1] > 30) return;
      if (best < 0 || slotRating(seller.quality, i, s) > slotRating(seller.quality, best, seller.slots![best])) best = i;
    });
    if (best < 0) continue;
    const role = SQUAD_ROLES[best];
    const star = seller.slots![best];
    const rating = slotRating(seller.quality, best, star);
    // He replaces the buyer's weakest player in his position, if he is an upgrade.
    let worst = -1;
    buyer.slots!.forEach((s, i) => {
      if (SQUAD_ROLES[i] !== role || i === 1) return;
      if (worst < 0 || slotRating(buyer.quality, i, s) < slotRating(buyer.quality, worst, buyer.slots![worst])) worst = i;
    });
    if (worst < 0 || rating <= slotRating(buyer.quality, worst, buyer.slots![worst]) + 1) continue;
    const player = slotPlayer(seller.quality, best, star);
    const fee = marketValue(player);
    const talent = Math.max(-8, Math.min(10, Math.round(rating - buyer.quality - ageCurve(star[1]))));
    buyer.slots![worst] = [star[0], star[1], talent];
    seller.slots![best] = youth(r, seller);
    lines.push(`${shortName(player)} (${role}, ${star[1]}) joins ${buyer.name} from ${seller.name} for ${formatMoney(fee)}.`);
  }
}

/**
 * The CPU world's season: squads age and trade, clubs develop toward their
 * division, the CPU tables are played and clubs go up and down. Called once per
 * rollover with the save's rng, after your own squad has aged.
 */
export function developWorld(save: Save, r: Rng): WorldReview {
  ensureWorldFields(save);
  const retired: string[] = [];
  const transfers: string[] = [];
  for (const c of save.ladder) ageSquad(r, c, retired);
  transferWindow(r, save, transfers);

  // Clubs develop toward their division's level, plus their own ambition.
  const lift = worldLift(averageOverall(save));
  for (const c of save.ladder) {
    const target = divisionCentre(clubDivision(c), lift) + (c.ambition ?? 0);
    c.quality = Math.round(Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, c.quality + (target - c.quality) * 0.3 + gauss(r) * 1.5)));
    // Elo follows strength: a club the ladder undersold (or oversold) moves a quarter of the way back.
    c.elo = Math.round(c.elo + (eloForQuality(c.quality) - c.elo) * 0.25);
    c.era = (c.era ?? 0) + 1;
  }

  // The CPU tables, then promotion and relegation between CPU clubs.
  const you = playerDivision(save);
  const tables = Array.from({ length: DIVISIONS }, (_, k) => cpuSeason(r, divisionClubs(save, k + 1)));
  const champions = tables.flatMap((t, k) => (k + 1 === you || !t.length ? [] : [{ division: k + 1, name: t[0].club.name }]));
  const promoted: ClubMove[] = [];
  const relegated: ClubMove[] = [];
  for (let d = 1; d < DIVISIONS; d++) {
    const upper = tables[d - 1];
    const lower = tables[d];
    for (const s of upper.slice(-2)) {
      s.club.division = d + 1;
      relegated.push({ name: s.club.name, from: d, to: d + 1 });
    }
    for (const s of lower.slice(0, 2)) {
      s.club.division = d;
      promoted.push({ name: s.club.name, from: d + 1, to: d });
    }
  }
  const topQuality = Math.max(...save.ladder.map((c) => c.quality));
  return { champions, promoted, relegated, transfers, retired, topQuality };
}

// ---------------------------------------------------------------------------
// Your league finish

export interface LeagueMove {
  /** 'up', 'down', or null when you stay. */
  moved: 'up' | 'down' | null;
  /** Your division now. */
  division: number;
  /** The CPU club that went the other way. */
  swapped?: string;
}

/**
 * Promotion or relegation after you finish a league in position `pos`: the top
 * two go up (unless already in the top division), the bottom two go down (unless
 * already at the bottom). The CPU club you swap with is the weakest of the
 * division you join (going up) or the strongest (going down).
 */
export function applyLeagueFinish(save: Save, pos: number): LeagueMove {
  ensureWorldFields(save);
  const from = playerDivision(save);
  const up = pos <= 2 && from > 1;
  const down = pos >= DIVISION_SIZE - 1 && from < DIVISIONS;
  if (!up && !down) return { moved: null, division: from };
  const to = up ? from - 1 : from + 1;
  const there = divisionClubs(save, to).sort((a, b) => (up ? a.quality - b.quality : b.quality - a.quality) || a.id.localeCompare(b.id));
  const other = there[0];
  if (other) other.division = from;
  save.division = to;
  save.nextOpp = null; // a new division: a fresh ranked offer
  return { moved: up ? 'up' : 'down', division: to, swapped: other?.name };
}
