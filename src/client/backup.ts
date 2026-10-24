// Export and import of a club: a JSON file, or a copyable code (the same JSON, gzipped, as text).
// Pure functions (plus the standard CompressionStream); the dialog that uses them is settings.ts.

import { isSave, type Save } from '../meta/game.ts';
import { levelForXp } from '../meta/levels.ts';
import { ATTR_KEYS } from '../meta/player.ts';
import { CREST_PATTERNS, STYLE_KEYS } from '../meta/names.ts';

const FORMAT = 1;
const CODE_PREFIX = 'DD1.';
/** A real club is a few hundred KB at most; anything near this is not one. */
const MAX_BYTES = 5_000_000;

export interface BackupPreview {
  name: string;
  level: number;
  played: number;
  elo: number;
  exportedAt: string | null;
}

export type ParsedBackup = { ok: true; save: Save; preview: BackupPreview } | { ok: false; reason: string };

export function backupJson(save: Save, now = new Date()): string {
  return JSON.stringify({ app: 'derby-day', format: FORMAT, exportedAt: now.toISOString(), save });
}

/** derby-day-club-name-2026-10-24.json */
export function backupFilename(save: Save, now = new Date()): string {
  const slug = save.club.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'club';
  return `derby-day-${slug}-${now.toISOString().slice(0, 10)}.json`;
}

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (t: string): Uint8Array => {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(bytes as BufferSource).catch(() => {});
  void w.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export const canMakeCode = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** A single line of text that restores the club. Empty when this browser cannot compress. */
export async function backupCode(save: Save, now = new Date()): Promise<string> {
  if (!canMakeCode()) return '';
  const gz = await pipe(new TextEncoder().encode(backupJson(save, now)), new CompressionStream('gzip'));
  return CODE_PREFIX + toB64(gz);
}

/** Accepts a backup file's text, a bare save's JSON, or a code from backupCode(). */
export async function parseBackup(input: string): Promise<ParsedBackup> {
  const text = input.trim();
  if (!text) return { ok: false, reason: 'Nothing to import.' };
  if (text.length > MAX_BYTES) return { ok: false, reason: 'That is too big to be a Derby Day backup.' };
  let json = text;
  if (text.startsWith(CODE_PREFIX)) {
    if (!canMakeCode()) return { ok: false, reason: 'This browser cannot read backup codes. Use the backup file instead.' };
    try {
      json = new TextDecoder().decode(await pipe(fromB64(text.slice(CODE_PREFIX.length).replace(/\s+/g, '')), new DecompressionStream('gzip')));
    } catch {
      return { ok: false, reason: 'That code is damaged or incomplete. Copy it again in full.' };
    }
    if (json.length > MAX_BYTES * 4) return { ok: false, reason: 'That is too big to be a Derby Day backup.' };
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'That is not a Derby Day backup.' };
  }
  const wrapped = data as { app?: unknown; save?: unknown; exportedAt?: unknown } | null;
  const candidate = wrapped && wrapped.app === 'derby-day' ? wrapped.save : data;
  if (!isSave(candidate) || !sane(candidate)) return { ok: false, reason: 'This backup is from a different version of the game or is damaged.' };
  return {
    ok: true,
    save: candidate,
    preview: {
      name: candidate.club.name,
      level: levelForXp(candidate.xp ?? 0).level,
      played: candidate.club.played,
      elo: candidate.club.elo,
      exportedAt: wrapped && typeof wrapped.exportedAt === 'string' ? wrapped.exportedAt : null,
    },
  };
}

const MAX_SEED = 2 ** 53;
const ROLES = ['GK', 'DEF', 'MID', 'FWD'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const SHORT = /^[A-Z0-9]{1,4}$/;
/** Characters that can break out of markup or an attribute. No real name, id or news line contains them. */
const MARKUP = /[<>"`\u0000-\u001f]/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown, max = 80): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
/** A finite number in [lo, hi]. */
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function goodPlayer(p: unknown): boolean {
  if (!isObj(p) || !ID.test(String(p.id)) || !isStr(p.first) || !isStr(p.last)) return false;
  if (!STYLE_KEYS.includes(p.style as never) || !ROLES.includes(p.role as string)) return false;
  if (!num(p.age, 10, 70) || !num(p.potential, 0, 100) || !num(p.number, 0, 999)) return false;
  if (p.scout !== undefined && !num(p.scout, 0, 1000)) return false;
  return isObj(p.attrs) && ATTR_KEYS.every((k) => num((p.attrs as Record<string, unknown>)[k], 0, 100));
}

function goodIdentity(c: Record<string, unknown>): boolean {
  return ID.test(String(c.id)) && isStr(c.name) && SHORT.test(String(c.short)) && COLOR.test(String(c.primary)) && COLOR.test(String(c.secondary)) && CREST_PATTERNS.includes(c.crest as never);
}

function goodRecord(c: Record<string, unknown>): boolean {
  return (['played', 'won', 'drawn', 'lost', 'gf', 'ga'] as const).every((k) => num(c[k], 0, 1e6)) && num(c.elo, 0, 10_000);
}

/**
 * The shape the game relies on, field by field. isSave() only checks the top level, and a club whose squad or
 * ladder is subtly wrong passes it and then crashes every boot, so an import has to get through this first
 * (and through dryRunBoot() in dryrun.ts).
 */
/** True if any string anywhere in the value could break out of markup (backups get shared, so treat them as hostile). */
function hostile(v: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof v === 'string') return v.length > 300 || MARKUP.test(v);
  if (Array.isArray(v)) return v.some((x) => hostile(x, depth + 1));
  if (isObj(v)) return Object.entries(v).some(([k, x]) => MARKUP.test(k) || hostile(x, depth + 1));
  return false;
}

export function deepCheck(s: Save): string | null {
  if (hostile(s)) return 'unsafe text';
  if (!num(s.seed, -MAX_SEED, MAX_SEED) || !isObj(s.rng) || !num((s.rng as { s: unknown }).s, -MAX_SEED, MAX_SEED)) return 'club seed';
  const c = s.club as unknown as Record<string, unknown>;
  if (!isObj(c) || !goodIdentity(c) || !goodRecord(c)) return 'club';
  if (!num(s.budget, -1e12, 1e12) || !num(s.trainingPoints, 0, 1e9)) return 'budget';
  if (!Array.isArray(s.squad) || s.squad.length < 1 || s.squad.length > 60 || !s.squad.every(goodPlayer)) return 'squad';
  const ids = new Set(s.squad.map((p) => p.id));
  if (ids.size !== s.squad.length) return 'squad ids';
  if (!Array.isArray(s.market) || s.market.length > 200 || !s.market.every(goodPlayer)) return 'transfer market';
  if (!Array.isArray(s.lineup) || s.lineup.length > 11 || !s.lineup.every((id) => typeof id === 'string' && ids.has(id)) || new Set(s.lineup).size !== s.lineup.length) return 'lineup';
  if (!Array.isArray(s.ladder) || s.ladder.length < 1 || s.ladder.length > 100) return 'ladder';
  for (const l of s.ladder as unknown as Record<string, unknown>[]) {
    if (!isObj(l) || !goodIdentity(l) || !goodRecord(l) || !num(l.seed, -MAX_SEED, MAX_SEED) || !num(l.quality, 0, 100)) return 'ladder';
    if (l.era !== undefined && !num(l.era, 0, 1e4)) return 'ladder';
  }
  if (!Array.isArray(s.eloHistory) || s.eloHistory.length > 20_000 || !s.eloHistory.every((n) => num(n, 0, 10_000))) return 'elo history';
  if (!Array.isArray(s.history) || s.history.length > 20_000) return 'match history';
  for (const m of s.history as unknown as Record<string, unknown>[]) {
    if (!isObj(m) || typeof m.opponent !== 'string' || typeof m.opponentShort !== 'string' || !num(m.goalsFor, 0, 1000) || !num(m.goalsAgainst, 0, 1000) || !num(m.eloBefore, 0, 10_000) || !num(m.eloAfter, 0, 10_000) || !Array.isArray(m.scorers)) return 'match history';
  }
  if (!Array.isArray(s.news) || s.news.length > 5000 || !s.news.every((n) => typeof n === 'string')) return 'news';
  if (s.xp !== undefined && !num(s.xp, 0, 1e9)) return 'experience';
  if (s.formation !== undefined && typeof s.formation !== 'string') return 'formation';
  return null;
}

/** What isSave() leaves loose and the game would trip over later. */
function sane(s: Save): boolean {
  return deepCheck(s) === null;
}
