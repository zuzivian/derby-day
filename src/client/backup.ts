// Export and import of a club: a JSON file, or a copyable code (the same JSON, gzipped, as text).
// Pure functions (plus the standard CompressionStream); the dialog that uses them is settings.ts.

import { isSave, type Save } from '../meta/game.ts';
import { levelForXp } from '../meta/levels.ts';

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

/** What isSave() leaves loose and the game would trip over later. */
function sane(s: Save): boolean {
  const c = s.club;
  return (
    typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 80 &&
    typeof c.elo === 'number' && Number.isFinite(c.elo) &&
    typeof c.played === 'number' && Number.isFinite(c.played) &&
    s.squad.length > 0 && s.squad.length <= 60 && Array.isArray(s.lineup) && Array.isArray(s.market) && Array.isArray(s.history) &&
    typeof s.budget === 'number' && Number.isFinite(s.budget)
  );
}
