import { FORMATION, TEAM_SIZE, type Role } from '../sim/constants.ts';
import { int, makeRng, next, pick, range, type Rng } from '../sim/rng.ts';
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

const SQUAD_ROLES: Role[] = ['GK', 'GK', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'FWD', 'FWD'];

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
  const preferred: Record<Role, number[]> = { GK: [1, 12, 13], DEF: [2, 3, 4, 5, 6], MID: [8, 6, 10, 7, 14], FWD: [9, 11, 7, 19] };
  for (const p of squad) {
    if (p.number > 0) continue;
    const n = preferred[p.role].find((x) => !used.has(x)) ?? Array.from({ length: 99 }, (_, i) => i + 1).find((x) => !used.has(x))!;
    p.number = n;
    used.add(n);
  }
}

/** Best XI for the 1-2-2-1, filling each slot with the best remaining rating at that role. */
export function autoLineup(squad: Player[]): string[] {
  const used = new Set<string>();
  const order = [0, 5, 1, 2, 3, 4]; // fill GK and striker first
  const lineup: string[] = new Array(TEAM_SIZE);
  for (const slot of order) {
    const role = FORMATION[slot].role;
    const best = squad
      .filter((p) => !used.has(p.id))
      .sort((a, b) => ratingAs(b, role) + (b.role === role ? 4 : 0) - (ratingAs(a, role) + (a.role === role ? 4 : 0)))[0];
    if (!best) break;
    used.add(best.id);
    lineup[slot] = best.id;
  }
  return lineup;
}

export function teamStrength(squad: Player[], lineup: string[]): number {
  const ps = lineup.map((id) => squad.find((p) => p.id === id)).filter((p): p is Player => !!p);
  if (!ps.length) return 0;
  return Math.round(ps.reduce((s, p, slot) => s + ratingAs(p, FORMATION[slot].role), 0) / ps.length);
}

export function toTeamSetup(id: ClubIdentity, squad: Player[], lineup: string[], aiSkill?: number): TeamSetup {
  const players = lineup.map((pid) => {
    const p = squad.find((x) => x.id === pid);
    if (!p) throw new Error(`Lineup player ${pid} not in squad`);
    return { id: p.id, name: shortName(p), number: p.number, role: p.role, attrs: toSimAttrs(p.attrs) };
  });
  const strength = teamStrength(squad, lineup);
  return {
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

export const squadAverage = (squad: Player[]): number => Math.round(squad.reduce((s, p) => s + overall(p), 0) / Math.max(1, squad.length));
