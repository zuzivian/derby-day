// Club identity edits made by the player during setup: a typed club name,
// a new generated name, or new colours. Plain data in, plain data out.

import { pick } from '../sim/rng.ts';
import { formatMoney, type Save } from './game.ts';
import { asciiFold, clubName, CREST_PATTERNS, isBlockedClub, KIT_COLORS } from './names.ts';

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
