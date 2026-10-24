// Club identity edits made by the player during setup: a typed club name,
// a new generated name, or new colours. Plain data in, plain data out.

import { pick } from '../sim/rng.ts';
import { formatMoney, type Save } from './game.ts';
import { isUnlocked } from './levels.ts';
import { asciiFold, clubName, CREST_PATTERNS, isBlockedClub, KIT_COLORS, type CrestPattern } from './names.ts';

export const NAME_MIN = 3;
export const NAME_MAX = 28;
const ALLOWED = /^[\p{L}\p{N} .'\-&]+$/u;

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Trims, collapses spaces and checks a typed club name. */
export function validateClubName(raw: string): NameCheck {
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN) return { ok: false, error: `Use at least ${NAME_MIN} characters.` };
  if (name.length > NAME_MAX) return { ok: false, error: `Use ${NAME_MAX} characters or fewer.` };
  if (!ALLOWED.test(name)) return { ok: false, error: "Use letters, numbers, spaces and . ' - & only." };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: 'Include at least one letter or number.' };
  if (isBlockedClub(name)) return { ok: false, error: 'That is a real club. Pick an original name.' };
  return { ok: true, name };
}

/** Words that describe the kind of club rather than the place, skipped when making a short code. */
const FILLER = new Set([
  'FC', 'AFC', 'CF', 'AC', 'SC', 'IF', 'FK', 'SK', 'THE', 'OF', 'AND', 'UNITED', 'CITY', 'TOWN', 'ATHLETIC', 'ROVERS',
  'WANDERERS', 'ALBION', 'HARRIERS', 'RANGERS', 'OLYMPIC', 'BOROUGH', 'SPORTING', 'DYNAMO', 'RACING', 'UNION', 'REAL',
  'INTER', 'ATLETICO', 'CLUB', 'FOOTBALL', 'SPORT',
]);

/** Three ASCII capitals for the scoreboard, from the distinctive words of the name. */
export function deriveShort(name: string): string {
  const words = asciiFold(name)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const core = words.filter((w) => !FILLER.has(w));
  const use = core.length ? core : words;
  let code: string;
  if (use.length >= 3) code = use.slice(0, 3).map((w) => w[0]).join('');
  else if (use.length === 2) code = use[0][0] + use[1].slice(0, 2);
  else {
    const w = use[0] ?? '';
    code = w.length >= 3 ? w[0] + w[Math.floor(w.length / 2)] + w[w.length - 1] : w;
  }
  return (code + words.join('') + 'XXX').slice(0, 3);
}

function refreshFoundedNews(save: Save): void {
  const line = `${save.club.name} founded. The board has given you ${formatMoney(save.budget)} to build a squad.`;
  const i = save.news.findIndex((n) => n.includes(' founded. The board has given you'));
  if (i >= 0) save.news[i] = line;
  else save.news.push(line);
}

/** Only allowed before the first match, like rerollIdentity. Returns false if refused. */
export function renameClub(save: Save, name: string, short = deriveShort(name)): boolean {
  if (save.club.played > 0) return false;
  const check = validateClubName(name);
  if (!check.ok) return false;
  save.club = { ...save.club, name: check.name, short };
  refreshFoundedNews(save);
  return true;
}

/**
 * Rename the club at any time (the welcome promises "you can rename your club"). Unlike renameClub this works after
 * matches have been played; the founding news line keeps the name it was written with once there is a record.
 */
export function setClubName(save: Save, name: string): boolean {
  const check = validateClubName(name);
  if (!check.ok) return false;
  save.club = { ...save.club, name: check.name, short: deriveShort(check.name) };
  if (save.club.played === 0) refreshFoundedNews(save);
  return true;
}

/** New generated name and short code, same colours and crest. */
export function rerollName(save: Save): void {
  if (save.club.played > 0) return;
  const prev = save.club.name;
  let next = clubName(save.rng);
  for (let i = 0; i < 5 && next.name === prev; i++) next = clubName(save.rng);
  save.club = { ...save.club, ...next };
  refreshFoundedNews(save);
}

/** New kit colours and crest pattern, same name. Always changes the kit. */
export function rerollColours(save: Save): void {
  if (save.club.played > 0) return;
  const c = save.club;
  const options = KIT_COLORS.filter(([p, s]) => p !== c.primary || s !== c.secondary);
  const [primary, secondary] = pick(save.rng, options);
  save.club = { ...c, primary, secondary, crest: pick(save.rng, CREST_PATTERNS) };
}

// ---------------------------------------------------------------------------
// Club-level perks: crest pattern (level 18) and kit colours (level 22). Unlike
// the setup rerolls above these work after the first match too.

/** Every colour used by the generated kits, with a name for the picker. */
export const KIT_PALETTE: { hex: string; name: string }[] = [
  { hex: '#c8102e', name: 'Red' }, { hex: '#9f1239', name: 'Claret' }, { hex: '#ea580c', name: 'Orange' }, { hex: '#f2a900', name: 'Amber' },
  { hex: '#f4d03f', name: 'Yellow' }, { hex: '#fde68a', name: 'Cream' }, { hex: '#0b7a3e', name: 'Green' }, { hex: '#166534', name: 'Forest' },
  { hex: '#0e7490', name: 'Teal' }, { hex: '#38bdf8', name: 'Sky' }, { hex: '#93c5fd', name: 'Ice blue' }, { hex: '#1d3f8f', name: 'Royal blue' },
  { hex: '#1e3a8a', name: 'Navy' }, { hex: '#5b2a86', name: 'Purple' }, { hex: '#7c2d12', name: 'Brown' }, { hex: '#0f172a', name: 'Midnight' },
  { hex: '#111827', name: 'Charcoal' }, { hex: '#1a1a1a', name: 'Black' }, { hex: '#e5e7eb', name: 'Silver' }, { hex: '#ffffff', name: 'White' },
];

/** Change the crest pattern. Needs the Crest pattern perk. Returns false if refused. */
export function setCrest(save: Save, crest: CrestPattern): boolean {
  if (!isUnlocked(save, 'crest') || !CREST_PATTERNS.includes(crest)) return false;
  save.club = { ...save.club, crest };
  return true;
}

/** Change the kit colours (two different palette colours). Needs the Custom kit perk. Returns false if refused. */
export function setKit(save: Save, primary: string, secondary: string): boolean {
  const ok = (h: string) => KIT_PALETTE.some((c) => c.hex === h);
  if (!isUnlocked(save, 'kit') || !ok(primary) || !ok(secondary) || primary === secondary) return false;
  save.club = { ...save.club, primary, secondary };
  return true;
}
