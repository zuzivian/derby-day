import { formationOf, TEAM_SIZE, type FormationId, type Role } from '../sim/constants.ts';
import { hashString, int, makeRng, next, pick, range, type Rng } from '../sim/rng.ts';
import type { TeamSetup } from '../sim/types.ts';
import { START_ELO } from './elo.ts';
import { clubName, CREST_PATTERNS, KIT_COLORS, STYLE_KEYS, type CrestPattern, type NameStyle } from './names.ts';
import { generatePlayer, overall, ratingAs, shortName, toSimAttrs, type Player } from './player.ts';

export interface ClubIdentity {
  id: string;
  name: string;
  short: string;
  primary: string;
  secondary: string;
  crest: CrestPattern;
}

export interface ClubRecord {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
}

/**
 * A CPU club in the world (src/meta/world.ts). Its players are rebuilt from
 * `slots` (or, for a save from before the world, from `seed`), so saves stay small.
 */
export interface LadderClub extends ClubIdentity, ClubRecord {
  elo: number;
  seed: number;
  /** The club's level: its players are rated around it (slotPlayer). It develops every season. */
  quality: number;
  /** Seasons rolled over so far (src/meta/progression.ts). Mixed into the squad seed; undefined or 0 is the original squad. */
  era?: number;
  /** Division, 1 (top) to DIVISIONS. Missing only on saves from before the world. */
  division?: number;
  /** Where the club aims within its division: added to the division's quality centre. */
  ambition?: number;
  /** The squad, one entry per SQUAD_ROLES slot: the same players season after season, ageing, retiring and moving. */
  slots?: Slot[];
}

/**
 * One CPU squad place: [key, age, talent]. The key seeds the player's name and
 * attribute shape (and `key % STYLE_KEYS.length` is his name style), so a
 * player keeps his identity as he ages and when he moves club. His rating is
 * the club's quality plus his talent plus what his age gives (ageCurve).
 */
export type Slot = [key: number, age: number, talent: number];

export const emptyRecord = (): ClubRecord => ({ played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 });

export function generateIdentity(r: Rng): ClubIdentity {
  const { name, short } = clubName(r);
  const [primary, secondary] = pick(r, KIT_COLORS);
  return { id: Math.floor(next(r) * 2 ** 32).toString(36), name, short, primary, secondary, crest: pick(r, CREST_PATTERNS) };
}

/**
 * A generated squad: 18 players, enough for either formation's XI plus a
 * bench of seven (a keeper and two of each outfield role). The order matters:
 * the first of each role is a little better, and the second keeper is a
 * reserve.
 */
export const SQUAD_ROLES: Role[] = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD', 'FWD'];

export function generateSquad(r: Rng, quality: number, homeStyle?: NameStyle): Player[] {
  const squad = SQUAD_ROLES.map((role, i) => {
    // Most of a squad shares a home nation; a few are imports.
    const style = homeStyle && next(r) < 0.65 ? homeStyle : pick(r, STYLE_KEYS);
    const q = quality + range(r, -7, 6) - (i === 1 ? 6 : 0);
    return generatePlayer(r, { role, quality: q, style });
  });
  assignNumbers(squad);
  return squad;
}

export function assignNumbers(squad: Player[]): void {
  const used = new Set(squad.filter((p) => p.number > 0).map((p) => p.number));
  const preferred: Record<Role, number[]> = { GK: [1, 13, 12, 25], DEF: [2, 5, 4, 3, 6, 15, 16, 22], MID: [8, 6, 10, 7, 14, 16, 17, 18, 20], FWD: [9, 11, 7, 19, 21, 23] };
  for (const p of squad) {
    if (p.number > 0) continue;
    const n = preferred[p.role].find((x) => !used.has(x)) ?? Array.from({ length: 99 }, (_, i) => i + 1).find((x) => !used.has(x))!;
    p.number = n;
    used.add(n);
  }
}

/**
 * Best XI for the formation (default 4-4-2), filling each slot with the best
 * remaining rating at that role: keeper first, then forwards, midfield and
 * defence, so a scarce position gets its best player.
 */
export function autoLineup(squad: Player[], formation?: FormationId): string[] {
  const slots = formationOf(formation);
  const used = new Set<string>();
  const rank = { GK: 0, FWD: 1, MID: 2, DEF: 3 } as const;
  const order = slots.map((_, i) => i).sort((a, b) => rank[slots[a].role] - rank[slots[b].role] || a - b);
  const lineup: string[] = new Array(TEAM_SIZE);
  for (const slot of order) {
    const role = slots[slot].role;
    const best = squad
      .filter((p) => !used.has(p.id))
      .sort((a, b) => ratingAs(b, role) + (b.role === role ? 4 : 0) - (ratingAs(a, role) + (a.role === role ? 4 : 0)))[0];
    if (!best) break;
    used.add(best.id);
    lineup[slot] = best.id;
  }
  return lineup;
}

export function teamStrength(squad: Player[], lineup: string[], formation?: FormationId): number {
  const slots = formationOf(formation);
  let sum = 0;
  let n = 0;
  lineup.forEach((id, slot) => {
    const p = squad.find((x) => x.id === id);
    if (!p || !slots[slot]) return;
    sum += ratingAs(p, slots[slot].role);
    n++;
  });
  return n ? Math.round(sum / n) : 0;
}

/** The sim's only input about a club: its XI in formation slot order (TeamSetup). */
export function toTeamSetup(id: ClubIdentity, squad: Player[], lineup: string[], aiSkill?: number, formation?: FormationId): TeamSetup {
  const players = lineup.map((pid) => {
    const p = squad.find((x) => x.id === pid);
    if (!p) throw new Error(`Lineup player ${pid} not in squad`);
    return { id: p.id, name: shortName(p), number: p.number, role: p.role, attrs: toSimAttrs(p.attrs) };
  });
  const strength = teamStrength(squad, lineup, formation);
  return {
    formation: formation ?? '4-4-2',
    name: id.name,
    short: id.short,
    primary: id.primary,
    secondary: id.secondary,
    players,
    aiSkill: aiSkill ?? Math.min(1, Math.max(0.15, (strength - 40) / 40)),
  };
}

export const qualityForElo = (elo: number): number => Math.round(Math.min(85, Math.max(42, 55 + (elo - START_ELO) / 20)));
/** The Elo a club of this quality settles at, the inverse of qualityForElo (without its clamp). */
export const eloForQuality = (quality: number): number => Math.round(START_ELO + (quality - 55) * 20);

export function generateLadder(seed: number, count: number): LadderClub[] {
  const r = makeRng(seed);
  const clubs: LadderClub[] = [];
  const names = new Set<string>();
  while (clubs.length < count) {
    const id = generateIdentity(r);
    if (names.has(id.name)) continue;
    names.add(id.name);
    const elo = Math.round(START_ELO + range(r, -220, 380));
    clubs.push({ ...id, ...emptyRecord(), elo, seed: int(r, 1, 2 ** 31 - 1), quality: qualityForElo(elo) });
  }
  return clubs;
}

/** The seed a ladder club's squad is generated from: its own seed, offset by how many seasons have passed. */
export const ladderSquadSeed = (c: Pick<LadderClub, 'seed' | 'era'>): number => (c.era ? (c.seed ^ Math.imul(c.era, 0x9e3779b1)) | 0 : c.seed);

export function ladderSquad(c: LadderClub): Player[] {
  if (c.slots?.length === SQUAD_ROLES.length) {
    const squad = c.slots.map((slot, i) => slotPlayer(c.quality, i, slot));
    assignNumbers(squad);
    return squad;
  }
  const r = makeRng(ladderSquadSeed(c));
  return generateSquad(r, c.quality, pick(r, STYLE_KEYS));
}

/** What age does to a CPU player's rating against his club's level: youngsters and veterans below it, 24-29 at it. */
export function ageCurve(age: number): number {
  if (age <= 17) return -9;
  if (age <= 23) return [-7, -6, -4, -3, -2, -1][age - 18];
  if (age <= 29) return 0;
  return age >= 35 ? -9 : [-1, -2, -3, -5, -7][age - 30];
}

/** A slot's rating at a club of `quality`. The reserve keeper (slot 1) sits a little lower, as in generateSquad. */
export const slotRating = (quality: number, i: number, [, age, talent]: Slot): number => quality + talent + ageCurve(age) - (i === 1 ? 6 : 0);

/** The player in CPU squad slot `i`, rebuilt from his key: the same name and shape every time, rated for his club and age. */
export function slotPlayer(quality: number, i: number, slot: Slot): Player {
  const [key, age] = slot;
  const r = makeRng(key);
  const p = generatePlayer(r, { role: SQUAD_ROLES[i], quality: slotRating(quality, i, slot), age, style: STYLE_KEYS[key % STYLE_KEYS.length] });
  p.id = `k${key.toString(36)}`;
  return p;
}

/** A slot key with the given name style (see Slot). */
export function slotKey(r: Rng, style: number): number {
  const base = int(r, 1, 2 ** 31 - 1);
  return base - (base % STYLE_KEYS.length) + (style % STYLE_KEYS.length);
}

/** A whole new CPU squad: mixed ages, most players from the club's home nation, a spread of talent. */
export function makeSlots(r: Rng, homeStyle: number): Slot[] {
  return SQUAD_ROLES.map(() => {
    const style = next(r) < 0.65 ? homeStyle : int(r, 0, STYLE_KEYS.length - 1);
    return [slotKey(r, style), int(r, 18, 33), int(r, -6, 5)] as Slot;
  });
}

/** A CPU club's formation: fixed per club (from its id), half of them 4-3-3. */
export const clubFormation = (c: Pick<ClubIdentity, 'id'>): FormationId => ((hashString(c.id) >>> 3) & 1 ? '4-3-3' : '4-4-2');

/** A CPU club's TeamSetup: its best XI in its own formation. */
export function cpuTeam(c: ClubIdentity, squad: Player[], aiSkill?: number): TeamSetup {
  const f = clubFormation(c);
  return toTeamSetup(c, squad, autoLineup(squad, f), aiSkill, f);
}

export const squadAverage = (squad: Player[]): number => Math.round(squad.reduce((s, p) => s + overall(p), 0) / Math.max(1, squad.length));
