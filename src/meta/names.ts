// Procedural names. Surnames and towns are assembled from syllables so the
// world is original: no real clubs, leagues or player likenesses. Anything that
// lands on a real famous player or club name is re-rolled against the blocklists.

import { int, pick, type Rng } from '../sim/rng.ts';

export type NameStyle =
  | 'nordic'
  | 'latin'
  | 'anglo'
  | 'slavic'
  | 'westafrican'
  | 'japanese'
  | 'lusophone'
  | 'germanic'
  | 'arabic'
  | 'korean';

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
  lusophone: {
    label: 'Morvalia',
    first: ['João', 'Rúben', 'Gonçalo', 'Duarte', 'Bernardo', 'Afonso', 'Diogo', 'Vasco', 'Rodrigo', 'Renato', 'Caio', 'Miguel', 'André', 'Heitor', 'Thiago', 'Gabriel'],
    pre: ['Cam', 'Par', 'Ser', 'Mon', 'Alv', 'Bar', 'Fer', 'Rod', 'Vas', 'Cor', 'Lou', 'Nun', 'Sil', 'Mel'],
    mid: ['ei', 'al', 'ou', 'ar', 'im', 'en'],
    suf: ['eira', 'ques', 'inho', 'ado', 'ão', 'ira', 'ente', 'ola', 'ício', 'ares', 'ada', 'nha'],
  },
  germanic: {
    label: 'Eisenmark',
    first: ['Felix', 'Jonas', 'Leon', 'Florian', 'Lukas', 'Maximilian', 'Benedikt', 'Matthias', 'Konrad', 'Niklas', 'Moritz', 'Gustav', 'Richard', 'Julian', 'Paul', 'Dieter'],
    pre: ['Brun', 'Hart', 'Eisen', 'Falk', 'Stein', 'Wolf', 'Rot', 'Hoff', 'Kessel', 'Wald', 'Adler', 'Lenz', 'Ober', 'Brenn'],
    mid: ['er', 'ing', 'en', 'el'],
    suf: ['mann', 'hardt', 'feld', 'brand', 'egger', 'kamp', 'wurm', 'steiner', 'hauser', 'lach', 'ruth', 'berg'],
  },
  arabic: {
    label: 'Almazra',
    first: ['Omar', 'Karim', 'Youssef', 'Tarek', 'Rami', 'Hamza', 'Samir', 'Adel', 'Bilal', 'Nasser', 'Amir', 'Zakaria', 'Khalil', 'Idris', 'Faisal', 'Walid'],
    pre: ['Al', 'Ben', 'Ha', 'Naj', 'Zah', 'Qa', 'Sa', 'Dar', 'Fat', 'Kha', 'Ras', 'Mus'],
    mid: ['ri', 'sa', 'ba', 'da', 'ha', 'ra'],
    suf: ['ran', 'ouri', 'nasi', 'mir', 'daad', 'ouf', 'ylah', 'ayan', 'iba', 'eed', 'ama', 'rah'],
  },
  korean: {
    label: 'Sanhae',
    first: ['Min-jun', 'Seo-jun', 'Ji-hoon', 'Hyun-woo', 'Joon-ho', 'Tae-yang', 'Dong-hyun', 'Sung-min', 'Ki-tae', 'Woo-jin', 'Jae-won', 'Hae-sung', 'Young-jae', 'Chan-ho'],
    pre: ['Ka', 'Mu', 'Sin', 'Do', 'Jeo', 'Gu', 'Hae', 'Ryo', 'Bo', 'Sa', 'Taek', 'Wol', 'Yeo', 'Chu'],
    mid: ['ang', 'un', 'eon', 'yo', 'ik'],
    suf: ['bong', 'rim', 'seok', 'yeong', 'gil', 'wan', 'ju', 'min', 'dal', 'san', 'hyun', 'ram'],
  },
};

export const STYLE_KEYS = Object.keys(STYLES) as NameStyle[];

/** Fictional nation each name style belongs to. */
export const nationOf = (style: NameStyle): string => STYLES[style].label;

// ---- Normalisation and blocklists -------------------------------------------

const FOLD: Partial<Record<string, string>> = {
  ß: 'ss', Æ: 'AE', æ: 'ae', Ø: 'O', ø: 'o', Œ: 'OE', œ: 'oe', Ł: 'L', ł: 'l',
  Đ: 'D', đ: 'd', Ð: 'D', ð: 'd', Þ: 'Th', þ: 'th', ı: 'i',
};

/** Folds to plain ASCII: 'Å' -> 'A', 'ö' -> 'o', 'Ø' -> 'O'. Characters with no ASCII form are dropped. */
export function asciiFold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, (ch) => FOLD[ch] ?? '');
}

/** Canonical comparison key: ASCII, lower-case, single spaces, no punctuation. */
export const nameKey = (s: string): string => asciiFold(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Real famous footballers (current and historic), as "first last" in nameKey form. */
export const FAMOUS_BLOCKLIST: ReadonlySet<string> = new Set([
  'lionel messi', 'cristiano ronaldo', 'kylian mbappe', 'erling haaland', 'kevin de bruyne',
  'mohamed salah', 'virgil van dijk', 'karim benzema', 'luka modric', 'robert lewandowski',
  'sergio ramos', 'andres iniesta', 'xavi hernandez', 'gerard pique', 'sergio busquets',
  'iker casillas', 'thomas muller', 'manuel neuer', 'philipp lahm', 'franz beckenbauer',
  'gerd muller', 'lothar matthaus', 'zinedine zidane', 'thierry henry', 'david beckham',
  'wayne rooney', 'steven gerrard', 'frank lampard', 'john terry', 'ryan giggs',
  'paul scholes', 'roy keane', 'alan shearer', 'michael owen', 'harry kane',
  'gary lineker', 'ricardo kaka', 'ronaldo nazario', 'diego maradona', 'johan cruyff',
  'marco van basten', 'ruud gullit', 'frank rijkaard', 'dennis bergkamp', 'patrick kluivert',
  'ronald koeman', 'carles puyol', 'fernando torres', 'david villa', 'david silva',
  'cesc fabregas', 'eden hazard', 'sadio mane', 'george weah', 'didier drogba',
  'samuel etoo', 'yaya toure', 'kolo toure', 'michael essien', 'jay jay okocha',
  'nwankwo kanu', 'zlatan ibrahimovic', 'andriy shevchenko', 'ruud van nistelrooy', 'hernan crespo',
  'gabriel batistuta', 'paolo maldini', 'francesco totti', 'alessandro del piero', 'roberto baggio',
  'gianluigi buffon', 'andrea pirlo', 'raul gonzalez', 'xabi alonso', 'pep guardiola',
  'gareth bale', 'luis suarez', 'edinson cavani', 'antoine griezmann', 'paul pogba',
  'ngolo kante', 'sergio aguero', 'carlos tevez', 'juan roman riquelme', 'javier mascherano',
  'mario gotze', 'miroslav klose', 'oliver kahn', 'jurgen klinsmann', 'bobby charlton',
  'george best', 'ferenc puskas', 'lev yashin', 'gordon banks', 'bobby moore',
  'mario kempes', 'hristo stoichkov',
]);

/** Single-name icons, blocked on the surname alone. */
export const SURNAME_BLOCKLIST: ReadonlySet<string> = new Set([
  'pele', 'garrincha', 'eusebio', 'ronaldinho', 'romario', 'kaka', 'cafu', 'messi',
  'maradona', 'cruyff', 'neymar', 'zico', 'puskas', 'ronaldo',
]);

/** Famous real club names, in nameKey form. */
export const CLUB_BLOCKLIST: ReadonlySet<string> = new Set([
  'arsenal', 'chelsea', 'liverpool', 'everton', 'manchester united', 'manchester city',
  'tottenham hotspur', 'leeds united', 'newcastle united', 'aston villa', 'west ham united',
  'sunderland', 'nottingham forest', 'leicester city', 'port vale', 'queens park rangers',
  'celtic', 'rangers', 'hibernian', 'real madrid', 'barcelona', 'fc barcelona',
  'atletico madrid', 'sevilla', 'valencia', 'juventus', 'ac milan', 'inter milan',
  'internazionale', 'as roma', 'lazio', 'napoli', 'ajax', 'psv eindhoven', 'feyenoord',
  'benfica', 'sporting cp', 'porto', 'bayern munich', 'borussia dortmund', 'schalke 04',
  'hamburger sv', 'paris saint germain', 'olympique marseille', 'olympique lyonnais', 'monaco',
  'galatasaray', 'fenerbahce', 'besiktas', 'boca juniors', 'river plate', 'flamengo',
  'corinthians', 'palmeiras', 'santos', 'penarol', 'independiente', 'racing club',
  'union berlin', 'dynamo kyiv', 'dynamo moscow', 'spartak moscow', 'cska moscow', 'zenit',
  'red star belgrade', 'partizan', 'olympiacos', 'panathinaikos', 'anderlecht', 'club brugge',
  'basel', 'shakhtar donetsk', 'steaua bucharest', 'legia warsaw', 'sparta prague',
  'slavia prague', 'real sociedad', 'celta vigo',
]);

/** True if a generated first/last pair is a famous player, by full name or by iconic surname. */
export function isBlockedPlayer(first: string, last: string): boolean {
  return FAMOUS_BLOCKLIST.has(nameKey(`${first} ${last}`)) || SURNAME_BLOCKLIST.has(nameKey(last));
}

/** True if a generated club name matches a famous real club. */
export const isBlockedClub = (name: string): boolean => CLUB_BLOCKLIST.has(nameKey(name));

/** Re-roll budget before the fallback suffix kicks in. */
const MAX_REROLLS = 10;

// ---- Players ----------------------------------------------------------------

function rollPlayer(r: Rng, s: StylePool): { first: string; last: string } {
  const mid = s.mid && int(r, 0, 2) === 0 ? pick(r, s.mid) : '';
  return { first: pick(r, s.first), last: pick(r, s.pre) + mid + pick(r, s.suf) };
}

export function playerName(r: Rng, style: NameStyle): { first: string; last: string } {
  const s = STYLES[style];
  let out = rollPlayer(r, s);
  for (let i = 1; i < MAX_REROLLS && isBlockedPlayer(out.first, out.last); i++) out = rollPlayer(r, s);
  // Practically unreachable. Extending the surname until it is clear keeps the guarantee absolute.
  while (isBlockedPlayer(out.first, out.last)) out = { first: out.first, last: `${out.last}o` };
  return out;
}

// ---- Towns and clubs --------------------------------------------------------

const TOWN_PRE = [
  'Brenn', 'Ash', 'Kald', 'Mar', 'Vest', 'Holt', 'Oster', 'Lun', 'Sor', 'Ely', 'Tarn', 'Rav', 'Wyn', 'Gal',
  'Corv', 'Fen', 'Hald', 'Sel', 'Quarr', 'Dun', 'Kest', 'Lom', 'Pell', 'Iver',
  'Alder', 'Strand', 'Ost', 'Threy', 'Kelv', 'Morr', 'Bryn', 'Cael', 'Ås', 'Örn',
];
const TOWN_SUF = [
  'holm', 'by', 'ford', 'mouth', 'stad', 'wick', 'haven', 'vik', 'gate', 'ton', 'mere', 'dal', 'borough',
  'field', 'ness', 'bridge', 'port', 'stow',
  'hythe', 'wood', 'cliff', 'lea', 'thorpe', 'grove', 'sund', 'hamn', 'stead', 'fjord',
];
const AFTER = ['Athletic', 'Rovers', 'United', 'City', 'Town', 'Wanderers', 'Albion', 'Harriers', 'Rangers', 'Olympic', 'FC', 'IF', 'SC', 'Borough'];
const BEFORE = ['FC', 'Sporting', 'Dynamo', 'Racing', 'AC', 'Union', 'Inter', 'Real', 'Atletico'];
const CLUB_WORDS = ['Central', 'Northern', 'Coastal', 'Academical', 'Juniors', 'Lowland'];

export function townName(r: Rng): string {
  const base = pick(r, TOWN_PRE) + pick(r, TOWN_SUF);
  const roll = int(r, 0, 9);
  if (roll === 0) return `Port ${base}`;
  if (roll === 1) return `${base} Vale`;
  return base;
}

function clubTitle(r: Rng, town: string): string {
  const roll = int(r, 0, 9);
  if (roll < 2 && !town.startsWith('Port ')) return `${pick(r, BEFORE)} ${town}`;
  if (roll === 2) return `${town} ${pick(r, CLUB_WORDS)} FC`;
  return `${town} ${pick(r, AFTER)}`;
}

const asciiLetters = (s: string): string => asciiFold(s).replace(/[^A-Za-z]/g, '').toUpperCase();

/** Exactly three ASCII capitals: first, middle and last letter of the town, padded from the name if the town is short. */
function shortCode(town: string, name: string): string {
  const core = asciiLetters(town.replace(/^Port /, '').replace(/ Vale$/, ''));
  if (core.length >= 3) return core[0] + core[Math.floor(core.length / 2)] + core[core.length - 1];
  return (core + asciiLetters(name) + 'XXX').slice(0, 3);
}

export function clubName(r: Rng): { name: string; short: string } {
  let town = townName(r);
  let name = clubTitle(r, town);
  for (let i = 1; i < MAX_REROLLS && isBlockedClub(name); i++) {
    town = townName(r);
    name = clubTitle(r, town);
  }
  // Practically unreachable. A numeric suffix keeps the guarantee absolute.
  for (let n = 2; isBlockedClub(name); n++) name = `${name} ${n}`;
  return { name, short: shortCode(town, name) };
}

// ---- Stadiums and nicknames -------------------------------------------------

const STADIUM_FEATURES = ['Harbour', 'Meadow', 'Orchard', 'Quarry', 'Millfield', 'Lakeside', 'Hilltop', 'Riverside', 'Beacon', 'Foundry', 'Saltmarsh', 'Copper', 'Windmill', 'Lantern'];
const STADIUM_TYPES = ['Ground', 'Park', 'Stadium', 'Arena', 'Road', 'Lane', 'Fields'];
const NICKNAME_NOUNS = [
  'Gulls', 'Herons', 'Kestrels', 'Ferrymen', 'Lanterns', 'Brickmakers', 'Ravens', 'Stags', 'Otters',
  'Ploughmen', 'Lamplighters', 'Shipwrights', 'Mallards', 'Kingfishers', 'Wrens', 'Gannets', 'Woodcutters', 'Bargemen',
];

/** Either "The Harbour Ground" or a town-based "Brennholm Park". */
export function stadiumName(r: Rng): string {
  const type = pick(r, STADIUM_TYPES);
  if (int(r, 0, 2) === 0) return `${pick(r, TOWN_PRE)}${pick(r, TOWN_SUF)} ${type}`;
  return `The ${pick(r, STADIUM_FEATURES)} ${type}`;
}

/** Club nickname, e.g. "The Gulls". */
export function clubNickname(r: Rng): string {
  return `The ${pick(r, NICKNAME_NOUNS)}`;
}

// ---- Kits -------------------------------------------------------------------

export const KIT_COLORS: [string, string][] = [
  ['#c8102e', '#ffffff'], ['#1d3f8f', '#ffffff'], ['#0b7a3e', '#f4d03f'], ['#f2a900', '#1a1a1a'],
  ['#5b2a86', '#ffffff'], ['#111827', '#e5e7eb'], ['#0e7490', '#fde68a'], ['#9f1239', '#93c5fd'],
  ['#ea580c', '#0f172a'], ['#e5e7eb', '#1e3a8a'], ['#166534', '#ffffff'], ['#7c2d12', '#38bdf8'],
];

export type CrestPattern = 'plain' | 'stripes' | 'halves' | 'sash' | 'hoops' | 'chevron';
export const CREST_PATTERNS: CrestPattern[] = ['plain', 'stripes', 'halves', 'sash', 'hoops', 'chevron'];
