// Local-first persistence for the prototype. The roadmap moves this behind
// an API; until then the save lives in this browser only.

import { isSave, type Save } from '../meta/game.ts';
import { HALF_SECONDS } from '../sim/constants.ts';

const SAVE_KEY = 'derbyday.save.v1';
const PREFS_KEY = 'derbyday.prefs.v1';

// The game was called Overlap, then briefly Through Ball, before Derby Day (2026-10-24).
// Copy anything saved under the old keys so existing clubs, settings and replays
// carry over. Runs once, on import; the first old key found wins.
const LEGACY_KEYS: [string, string][] = [
  ['throughball.save.v1', SAVE_KEY],
  ['throughball.prefs.v1', PREFS_KEY],
  ['throughball.replays.v1', 'derbyday.replays.v1'],
  ['throughball.audio.muted.v1', 'derbyday.audio.muted.v1'],
  ['overlap.save.v1', SAVE_KEY],
  ['overlap.prefs.v1', PREFS_KEY],
  ['overlap.replays.v1', 'derbyday.replays.v1'],
  ['overlap.audio.muted.v1', 'derbyday.audio.muted.v1'],
];
try {
  for (const [from, to] of LEGACY_KEYS) {
    const old = localStorage.getItem(from);
    if (old !== null && localStorage.getItem(to) === null) localStorage.setItem(to, old);
  }
} catch {
  /* storage unavailable */
}

export type ControlStyle = 'mouse' | 'keys';

export interface Prefs {
  /**
   * Seconds per half for live matches. NOT a user setting: every match is the
   * standard 2 × HALF_SECONDS (src/sim/constants.ts) and there is no selector.
   * loadPrefs() fills it with HALF_SECONDS unless the stored prefs carry a
   * TEST-ONLY override (the e2e suite stores e.g. { halfSeconds: 3 } for short
   * matches). writePrefs() only keeps a value that differs from the standard,
   * so a real player's prefs never hold one.
   */
  halfSeconds: number;
  controls: ControlStyle;
  /** false while first-run setup is unfinished; missing means an older save that never saw it. */
  onboarded?: boolean;
}

const BACKUP_KEY = `${SAVE_KEY}.bak`;

/** What loading found. `restored`: the main save was unreadable and the previous good save took its place. */
export interface SaveLoad {
  save: Save | null;
  restored: boolean;
  /** Something was stored but neither it nor the backup could be read. */
  lost: boolean;
}

/** The last text known to hold a readable save (loaded or written by this page), so a write need not parse it again. */
let lastGood: string | null = null;

export function parseSave(raw: string | null): Save | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSave(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the club. A corrupt main save falls back to the backup (the save before the last write) and the
 * backup is promoted, so the next load is clean; the caller tells the player when `restored` or `lost`.
 */
export function loadSaveChecked(): SaveLoad {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const main = parseSave(raw);
    if (main) {
      lastGood = raw;
      return { save: main, restored: false, lost: false };
    }
    const bakRaw = localStorage.getItem(BACKUP_KEY);
    const bak = parseSave(bakRaw);
    if (bak && bakRaw) {
      // Keep the unreadable text for support before replacing it.
      try {
        if (raw) localStorage.setItem(`${SAVE_KEY}.corrupt`, raw);
        localStorage.setItem(SAVE_KEY, bakRaw);
      } catch {
        /* read-only or full: the backup still loads */
      }
      return { save: bak, restored: true, lost: false };
    }
    return { save: null, restored: false, lost: !!raw };
  } catch {
    return { save: null, restored: false, lost: false };
  }
}

export function loadSave(): Save | null {
  return loadSaveChecked().save;
}

/**
 * 'ok' written; 'quota' storage is full; 'blocked' storage is unavailable;
 * 'guest' this tab does not own the club (see tabguard.ts), nothing was written on purpose.
 */
export type WriteResult = 'ok' | 'quota' | 'blocked' | 'guest';

let guest = false;
/** A guest tab (Derby Day is open elsewhere) never writes the club: that would overwrite the owner's save. */
export function setSaveGuest(v: boolean): void {
  guest = v;
}

const isQuota = (e: unknown): boolean => {
  const x = e as { name?: string; code?: number } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014);
};

function writeNow(s: Save): WriteResult {
  const next = JSON.stringify(s);
  try {
    const prev = localStorage.getItem(SAVE_KEY);
    // The backup is the last save that was readable. Best effort: a full disk must not block the real write.
    if (prev && prev !== next && (prev === lastGood || parseSave(prev))) {
      try {
        localStorage.setItem(BACKUP_KEY, prev);
      } catch {
        /* no room for a backup */
      }
    }
    try {
      localStorage.setItem(SAVE_KEY, next);
    } catch (e) {
      if (!isQuota(e)) throw e;
      // Make room by giving up the backup, then try once more.
      localStorage.removeItem(BACKUP_KEY);
      localStorage.setItem(SAVE_KEY, next);
    }
    lastGood = next;
    return 'ok';
  } catch (e) {
    return isQuota(e) ? 'quota' : 'blocked';
  }
}

export function writeSaveResult(s: Save): WriteResult {
  return guest ? 'guest' : writeNow(s);
}

/** True when the save is safe (written, or deliberately not written by a guest tab). */
export function writeSave(s: Save): boolean {
  const r = writeSaveResult(s);
  return r === 'ok' || r === 'guest';
}

const PRE_IMPORT_KEY = `${SAVE_KEY}.pre-import`;

/**
 * Put an imported club in place. The club it replaces is kept under its own key (the rolling backup would be
 * overwritten by the very next save), so a wrong restore can be undone by hand. Only the owner tab calls this.
 */
export function replaceSave(s: Save): WriteResult {
  try {
    const prev = localStorage.getItem(SAVE_KEY);
    if (prev && parseSave(prev)) localStorage.setItem(PRE_IMPORT_KEY, prev);
  } catch {
    /* no room for the safety copy: the import itself still goes ahead */
  }
  return writeNow(s);
}

export function clearSave(): void {
  if (guest) return;
  try {
    localStorage.removeItem(SAVE_KEY);
    localStorage.removeItem(BACKUP_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The 1, 2 and 4 minute halves the old match length selector stored. Ignored now: everyone plays the standard length. */
const LEGACY_LENGTHS = [60, 120, 240];

/** A stored half length counts only as the test-only override: a positive number that the old selector could not have written. */
function testHalfSeconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600 && !LEGACY_LENGTHS.includes(v) ? v : null;
}

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      halfSeconds: testHalfSeconds(p.halfSeconds) ?? HALF_SECONDS,
      controls: p.controls === 'keys' ? 'keys' : 'mouse',
      ...(typeof p.onboarded === 'boolean' ? { onboarded: p.onboarded } : {}),
    };
  } catch {
    return { halfSeconds: HALF_SECONDS, controls: 'mouse' };
  }
}

export function writePrefs(p: Prefs): void {
  try {
    const { halfSeconds, ...rest } = p;
    const override = halfSeconds !== HALF_SECONDS ? testHalfSeconds(halfSeconds) : null;
    localStorage.setItem(PREFS_KEY, JSON.stringify(override === null ? rest : { ...rest, halfSeconds: override }));
  } catch {
    /* storage unavailable */
  }
}
