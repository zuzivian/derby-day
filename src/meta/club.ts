import { formationOf, mentalityOf, TEAM_SIZE, type FormationId, type Mentality, type Role } from '../sim/constants.ts';
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

/** A CPU club on the ladder. Its squad is regenerated from `seed`, so saves stay small. */
export interface LadderClub extends ClubIdentity, ClubRecord {
  elo: number;
  seed: number;
  quality: number;
  /** Seasons rolled over so far (src/meta/progression.ts). Mixed into the squad seed; undefined or 0 is the original squad. */
  era?: number;
}

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
const SQUAD_ROLES: Role[] = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD', 'FWD'];

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

/**
 * The sim's only input about a club: its XI in formation slot order (TeamSetup).
 * `mentality` is left off the setup when it is Balanced, the sim's default, so
 * a Balanced team looks the same as one from before mentalities existed.
 */
export function toTeamSetup(id: ClubIdentity, squad: Player[], lineup: string[], aiSkill?: number, formation?: FormationId, mentality?: Mentality): TeamSetup {
  const players = lineup.map((pid) => {
    const p = squad.find((x) => x.id === pid);
    if (!p) throw new Error(`Lineup player ${pid} not in squad`);
    return { id: p.id, name: shortName(p), number: p.number, role: p.role, attrs: toSimAttrs(p.attrs) };
  });
  const strength = teamStrength(squad, lineup, formation);
  const m = mentalityOf(mentality);
  return {
    formation: formation ?? '4-4-2',
    ...(m === 'balanced' ? {} : { mentality: m }),
    name: id.name,
    short: id.short,
    primary: id.primary,
    secondary: id.secondary,
    players,
    aiSkill: aiSkill ?? Math.min(1, Math.max(0.15, (strength - 40) / 40)),
  };
}

export const qualityForElo = (elo: number): number => Math.round(Math.min(85, Math.max(42, 55 + (elo - START_ELO) / 20)));

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
  const r = makeRng(ladderSquadSeed(c));
  return generateSquad(r, c.quality, pick(r, STYLE_KEYS));
}

/** Pick from a weighted table with a 0..1 roll. */
function weighted<T>(table: [T, number][], roll: number): T {
  const total = table.reduce((t, [, w]) => t + w, 0);
  let x = roll * total;
  for (const [v, w] of table) if ((x -= w) < 0) return v;
  return table[table.length - 1][0];
}

/** How often CPU clubs line up in each formation: the common back fours most, back threes and fives now and then. */
const CPU_FORMATIONS: [FormationId, number][] = [
  ['4-4-2', 18], ['4-3-3', 18], ['4-2-3-1', 16], ['4-1-4-1', 8], ['4-4-1-1', 8], ['3-5-2', 10], ['3-4-3', 8], ['5-3-2', 5], ['5-4-1', 4],
];
/** Most CPU clubs play Balanced or go for it (more fun to play against); a few sit deep or press high. */
const CPU_MENTALITIES: [Mentality, number][] = [
  ['park', 5], ['defensive', 15], ['balanced', 42], ['attacking', 26], ['press', 12],
];

/** A stable 0..1 roll per club id and purpose. */
const clubRoll = (c: Pick<ClubIdentity, 'id'>, salt: number): number => (Math.imul(hashString(c.id) ^ salt, 2654435761) >>> 0) / 2 ** 32;

/** A CPU club's formation: fixed per club (from its id), weighted toward the common shapes. */
export const clubFormation = (c: Pick<ClubIdentity, 'id'>): FormationId => weighted(CPU_FORMATIONS, clubRoll(c, 0x0f0f));

/** A CPU club's mentality: fixed per club (from its id). A back five leans one step more cautious. */
export function clubMentality(c: Pick<ClubIdentity, 'id'>): Mentality {
  const m = weighted(CPU_MENTALITIES, clubRoll(c, 0x7a3c));
  const f = clubFormation(c);
  if ((f === '5-3-2' || f === '5-4-1') && (m === 'attacking' || m === 'press')) return m === 'press' ? 'attacking' : 'balanced';
  return m;
}

/** A CPU club's TeamSetup: its best XI in its own formation and mentality. */
export function cpuTeam(c: ClubIdentity, squad: Player[], aiSkill?: number): TeamSetup {
  const f = clubFormation(c);
  return toTeamSetup(c, squad, autoLineup(squad, f), aiSkill, f, clubMentality(c));
}

export const squadAverage = (squad: Player[]): number => Math.round(squad.reduce((s, p) => s + overall(p), 0) / Math.max(1, squad.length));
