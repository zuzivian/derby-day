import type { Role } from '../sim/constants.ts';
import { chance, gauss, int, next, pick, type Rng } from '../sim/rng.ts';
import type { SimAttrs } from '../sim/types.ts';
import { nationOf, playerName, STYLE_KEYS, type NameStyle } from './names.ts';

export type AttrKey = keyof SimAttrs;
export const ATTR_KEYS: AttrKey[] = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'stamina', 'goalkeeping'];
export const ATTR_LABEL: Record<AttrKey, string> = {
  pace: 'PAC', shooting: 'SHO', passing: 'PAS', dribbling: 'DRI', defending: 'DEF', stamina: 'STA', goalkeeping: 'GK',
};
export const ATTR_NAME: Record<AttrKey, string> = {
  pace: 'Pace', shooting: 'Shooting', passing: 'Passing', dribbling: 'Dribbling', defending: 'Defending', stamina: 'Stamina', goalkeeping: 'Goalkeeping',
};

/** 1..99 */
export type Attributes = Record<AttrKey, number>;

export interface Player {
  id: string;
  first: string;
  last: string;
  style: NameStyle;
  age: number;
  role: Role;
  attrs: Attributes;
  potential: number;
  number: number;
}

const WEIGHTS: Record<Role, Partial<Attributes>> = {
  GK: { goalkeeping: 0.72, passing: 0.1, defending: 0.08, pace: 0.05, stamina: 0.05 },
  DEF: { defending: 0.4, pace: 0.2, passing: 0.15, stamina: 0.15, dribbling: 0.05, shooting: 0.05 },
  MID: { passing: 0.35, dribbling: 0.2, stamina: 0.15, defending: 0.1, shooting: 0.1, pace: 0.1 },
  FWD: { shooting: 0.4, pace: 0.25, dribbling: 0.25, passing: 0.05, stamina: 0.05 },
};

export function ratingAs(p: Player, role: Role): number {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS[role]) as [AttrKey, number][]) sum += p.attrs[k] * w;
  return Math.round(sum);
}

export const overall = (p: Player): number => ratingAs(p, p.role);

export function marketValue(p: Player): number {
  const ovr = overall(p);
  const growth = Math.max(0, p.potential - ovr);
  const ageFactor = p.age <= 21 ? 1.35 : p.age <= 25 ? 1.15 : p.age <= 29 ? 1 : p.age <= 32 ? 0.7 : 0.45;
  const raw = 50_000 * Math.pow(1.12, ovr - 50) * ageFactor * (1 + growth * 0.015);
  return Math.max(10_000, Math.round(raw / 5_000) * 5_000);
}

export const fullName = (p: Player): string => `${p.first} ${p.last}`;
export const shortName = (p: Player): string => `${p.first[0]}. ${p.last}`;
export const nation = (p: Player): string => nationOf(p.style);

const TEMPLATE: Record<Role, Attributes> = {
  GK: { pace: 45, shooting: 25, passing: 50, dribbling: 35, defending: 45, stamina: 55, goalkeeping: 72 },
  DEF: { pace: 62, shooting: 40, passing: 58, dribbling: 50, defending: 72, stamina: 66, goalkeeping: 12 },
  MID: { pace: 62, shooting: 58, passing: 72, dribbling: 66, defending: 55, stamina: 70, goalkeeping: 12 },
  FWD: { pace: 72, shooting: 72, passing: 56, dribbling: 70, defending: 35, stamina: 62, goalkeeping: 10 },
};

let idCounter = 0;
function newId(r: Rng): string {
  idCounter = (idCounter + 1) % 1e6;
  return Math.floor(next(r) * 2 ** 32).toString(36) + idCounter.toString(36);
}

export interface PlayerSpec {
  role?: Role;
  /** Target overall rating, roughly. */
  quality: number;
  age?: number;
  style?: NameStyle;
}

export function generatePlayer(r: Rng, spec: PlayerSpec): Player {
  const role = spec.role ?? pick(r, ['GK', 'DEF', 'DEF', 'MID', 'MID', 'FWD'] as Role[]);
  const style = spec.style ?? pick(r, STYLE_KEYS);
  const { first, last } = playerName(r, style);
  const age = spec.age ?? int(r, 17, 34);
  const attrs = {} as Attributes;
  for (const k of ATTR_KEYS) attrs[k] = TEMPLATE[role][k] + gauss(r) * 9;
  const p: Player = { id: newId(r), first, last, style, age, role, attrs, potential: 0, number: 0 };
  // Scale toward the requested overall, then clamp.
  const shift = spec.quality - ratingAs({ ...p, attrs }, role);
  for (const k of ATTR_KEYS) {
    const weight = k === 'goalkeeping' && role !== 'GK' ? 0 : 1;
    attrs[k] = Math.round(Math.min(99, Math.max(1, attrs[k] + shift * weight)));
  }
  const ovr = overall(p);
  const headroom = age <= 21 ? int(r, 6, 20) : age <= 25 ? int(r, 2, 10) : age <= 29 ? int(r, 0, 4) : 0;
  p.potential = Math.min(95, ovr + headroom);
  return p;
}

/** Attribute growth from one training session. Young players with headroom grow fastest. */
export function trainingGain(r: Rng, p: Player, attr: AttrKey): number {
  const ageFactor = p.age < 21 ? 1.5 : p.age <= 25 ? 1 : p.age <= 29 ? 0.7 : 0.4;
  const atCeiling = overall(p) >= p.potential;
  if (p.attrs[attr] >= 99) return 0;
  if (atCeiling) return chance(r, 0.3 * ageFactor) ? 1 : 0;
  return Math.max(0, Math.min(3, Math.round((1 + next(r) * 2) * ageFactor)));
}

export function toSimAttrs(a: Attributes): SimAttrs {
  const o = {} as SimAttrs;
  for (const k of ATTR_KEYS) o[k] = a[k] / 100;
  return o;
}
