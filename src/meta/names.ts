// Procedural names. Surnames and towns are assembled from syllables so the
// world is original: no real clubs, leagues or player likenesses.

import { int, pick, type Rng } from '../sim/rng.ts';

export type NameStyle = 'nordic' | 'latin' | 'anglo' | 'slavic' | 'westafrican' | 'japanese';

interface StylePool {
  label: string;
  first: string[];
  pre: string[];
  mid?: string[];
  suf: string[];
}

const STYLES: Record<NameStyle, StylePool> = {
  nordic: {
    label: 'Nordvik',
    first: ['Erik', 'Lars', 'Nils', 'Oskar', 'Anton', 'Viktor', 'Emil', 'Jonas', 'Henrik', 'Axel', 'Elias', 'Sven', 'Mats', 'Tobias', 'Linus', 'Hugo'],
    pre: ['Berg', 'Lind', 'Ek', 'Holm', 'Sand', 'Fors', 'Dahl', 'Ny', 'Sjö', 'Ås', 'Grön', 'Vik', 'Hag', 'Ros'],
    suf: ['ström', 'gren', 'qvist', 'berg', 'lund', 'vall', 'mark', 'sten', 'by', 'dal', 'ling', 'stad'],
  },
  latin: {
    label: 'Costaria',
    first: ['Mateo', 'Diego', 'Luca', 'Tiago', 'Rafael', 'Bruno', 'Iker', 'Joaquín', 'Santi', 'Marco', 'Pablo', 'Dario', 'Nico', 'Emilio', 'Gael'],
    pre: ['Var', 'Mon', 'Cas', 'Bel', 'Ro', 'San', 'Pe', 'Al', 'Ve', 'Cor', 'Fer', 'Lo', 'Ma'],
    mid: ['ri', 'la', 'te', 've', 'do', 'ni', 'ca', 'ren'],
    suf: ['ez', 'ano', 'ero', 'ini', 'ado', 'oso', 'illo', 'eda', 'ona', 'etti'],
  },
  anglo: {
    label: 'Albrook',
    first: ['Jack', 'Tom', 'Callum', 'Owen', 'Harry', 'Liam', 'Ryan', 'Ben', 'Kieran', 'Jamie', 'Alfie', 'Reece', 'Connor', 'Ellis', 'Theo'],
    pre: ['Ash', 'Brad', 'Hal', 'Pem', 'Whit', 'Stan', 'Ald', 'Thorn', 'Mar', 'Cart', 'Brook', 'Fen', 'Kirk', 'Hollin'],
    suf: ['ley', 'ford', 'worth', 'ton', 'by', 'wick', 'field', 'more', 'ridge', 'combe', 'well', 'den'],
  },
  slavic: {
    label: 'Varenia',
    first: ['Luka', 'Ivan', 'Marko', 'Filip', 'Pavel', 'Tomas', 'Dominik', 'Mateusz', 'Jakub', 'Andrej', 'Bojan', 'Damir', 'Nikola'],
    pre: ['Kov', 'Nov', 'Pet', 'Mil', 'Rad', 'Bor', 'Vuk', 'Zel', 'Kras', 'Dob', 'Sok', 'Lev'],
    mid: ['a', 'e', 'o', 'i'],
    suf: ['ač', 'ić', 'ski', 'ov', 'enko', 'ek', 'ar', 'ović', 'czyk', 'iak'],
  },
  westafrican: {
    label: 'Kessaro',
    first: ['Kwame', 'Kofi', 'Yaw', 'Sekou', 'Moussa', 'Ibrahima', 'Chidi', 'Emeka', 'Tunde', 'Ade', 'Seydou', 'Mamadou', 'Kojo', 'Femi'],
    pre: ['Ade', 'Oko', 'Ba', 'Di', 'Kou', 'Nwa', 'Ola', 'Sa', 'Tra', 'Ke', 'Asa', 'Obi'],
    suf: ['yemi', 'nkwo', 'ssa', 'bate', 'mara', 'kolo', 'ore', 'ndé', 'gbo', 'du', 'for', 'nye'],
  },
  japanese: {
    label: 'Ishikai',
    first: ['Haruto', 'Ren', 'Yuto', 'Sota', 'Kaito', 'Riku', 'Daiki', 'Kenta', 'Hiro', 'Takumi', 'Shun'],
    pre: ['Taka', 'Yama', 'Kawa', 'Mori', 'Naka', 'Fuji', 'Shima', 'Ishi', 'Kita', 'Hara', 'Aki'],
    suf: ['mura', 'moto', 'hashi', 'da', 'no', 'saki', 'oka', 'zawa', 'gawa', 'ta'],
  },
};

export const STYLE_KEYS = Object.keys(STYLES) as NameStyle[];

/** Fictional nation each name style belongs to. */
export const nationOf = (style: NameStyle): string => STYLES[style].label;

export function playerName(r: Rng, style: NameStyle): { first: string; last: string } {
  const s = STYLES[style];
  const mid = s.mid && int(r, 0, 2) === 0 ? pick(r, s.mid) : '';
  return { first: pick(r, s.first), last: pick(r, s.pre) + mid + pick(r, s.suf) };
}

const TOWN_PRE = ['Brenn', 'Ash', 'Kald', 'Mar', 'Vest', 'Holt', 'Oster', 'Lun', 'Sor', 'Ely', 'Tarn', 'Rav', 'Wyn', 'Gal', 'Corv', 'Fen', 'Hald', 'Sel', 'Quarr', 'Dun', 'Kest', 'Lom', 'Pell', 'Iver'];
const TOWN_SUF = ['holm', 'by', 'ford', 'mouth', 'stad', 'wick', 'haven', 'vik', 'gate', 'ton', 'mere', 'dal', 'borough', 'field', 'ness', 'bridge', 'port', 'stow'];
const AFTER = ['Athletic', 'Rovers', 'United', 'City', 'Town', 'Wanderers', 'Albion', 'Harriers', 'Rangers', 'Olympic', 'FC', 'IF', 'SC', 'Borough'];
const BEFORE = ['FC', 'Sporting', 'Dynamo', 'Racing', 'AC', 'Union'];

export function townName(r: Rng): string {
  const base = pick(r, TOWN_PRE) + pick(r, TOWN_SUF);
  const roll = int(r, 0, 9);
  if (roll === 0) return `Port ${base}`;
  if (roll === 1) return `${base} Vale`;
  return base;
}

export function clubName(r: Rng): { name: string; short: string } {
  const town = townName(r);
  const name = int(r, 0, 3) === 0 ? `${pick(r, BEFORE)} ${town}` : `${town} ${pick(r, AFTER)}`;
  const letters = town.replace(/^Port /, '').replace(/ Vale$/, '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const short = (letters[0] + letters[Math.floor(letters.length / 2)] + letters[letters.length - 1]).slice(0, 3);
  return { name, short };
}

export const KIT_COLORS: [string, string][] = [
  ['#c8102e', '#ffffff'], ['#1d3f8f', '#ffffff'], ['#0b7a3e', '#f4d03f'], ['#f2a900', '#1a1a1a'],
  ['#5b2a86', '#ffffff'], ['#111827', '#e5e7eb'], ['#0e7490', '#fde68a'], ['#9f1239', '#93c5fd'],
  ['#ea580c', '#0f172a'], ['#e5e7eb', '#1e3a8a'], ['#166534', '#ffffff'], ['#7c2d12', '#38bdf8'],
];

export type CrestPattern = 'plain' | 'stripes' | 'halves' | 'sash' | 'hoops' | 'chevron';
export const CREST_PATTERNS: CrestPattern[] = ['plain', 'stripes', 'halves', 'sash', 'hoops', 'chevron'];
