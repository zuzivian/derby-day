// Local-first persistence for the prototype. The roadmap moves this behind
// an API; until then the save lives in this browser only.

import { isSave, SAVE_VERSION, type Save } from '../meta/game.ts';
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
  /**
   * Coach tips already shown (src/client/coach.ts). Present only for a club that went through
   * the first-run flow; a player who predates it has none and sees no tips.
   */
  coachSeen?: string[];
  /** Tabs already pointed out with a coach mark. Present only after the first-run flow, like coachSeen. */
  marks?: string[];
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

const BACKUP_KEY = `${SAVE_KEY}.bak`;
const CORRUPT_KEY = `${SAVE_KEY}.corrupt`;
const PRE_IMPORT_KEY = `${SAVE_KEY}.pre-import`;

/** What loading found. `restored`: the main save was unreadable and the previous good save took its place. */
export interface SaveLoad {
  save: Save | null;
  restored: boolean;
  /** Something was stored but neither it nor the backup could be read. The text is kept under `.corrupt`. */
  lost: boolean;
  /** The save was written by a newer build of the game than this page. Never overwritten: the tab runs read-only. */
  newer: boolean;
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
      return { save: main, restored: false, lost: false, newer: false };
    }
    if (raw && isNewer(raw)) return { save: null, restored: false, lost: false, newer: true };
    const bakRaw = localStorage.getItem(BACKUP_KEY);
    const bak = parseSave(bakRaw);
    if (bak && bakRaw) {
      // Keep the unreadable text for support before replacing it.
      try {
        if (raw) localStorage.setItem(CORRUPT_KEY, raw);
        localStorage.setItem(SAVE_KEY, bakRaw);
        lastGood = bakRaw;
      } catch {
        /* read-only or full: the backup still loads */
      }
      return { save: bak, restored: true, lost: false, newer: false };
    }
    // Nothing readable. Whatever was there is kept, so the next write (a fresh club) does not destroy it.
    if (raw) {
      try {
        localStorage.setItem(CORRUPT_KEY, raw);
      } catch {
        /* full */
      }
    }
    return { save: null, restored: false, lost: !!raw, newer: false };
  } catch {
    return { save: null, restored: false, lost: false, newer: false };
  }
}

/** A well-formed save with a version above ours: written by a newer build (a stale cached page can be older than the data). */
function isNewer(raw: string): boolean {
  try {
    const v = (JSON.parse(raw) as { version?: unknown } | null)?.version;
    return typeof v === 'number' && v > SAVE_VERSION;
  } catch {
    return false;
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
export const isSaveGuest = (): boolean => guest;
/** What the most recent save attempt did, for the crash panel's "your club is saved" line. */
let lastResult: WriteResult | null = null;
export const lastWriteFailed = (): boolean => lastResult === 'quota' || lastResult === 'blocked';
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
    // Out of room: give up the safety copies one at a time (the unreadable-save copy, the pre-import copy,
    // then the rolling backup) before giving up on the save itself.
    const ladder = [CORRUPT_KEY, PRE_IMPORT_KEY, BACKUP_KEY];
    for (let i = 0; ; i++) {
      try {
        localStorage.setItem(SAVE_KEY, next);
        break;
      } catch (e) {
        if (!isQuota(e) || i >= ladder.length) throw e;
        localStorage.removeItem(ladder[i]);
      }
    }
    lastGood = next;
    return 'ok';
  } catch (e) {
    return isQuota(e) ? 'quota' : 'blocked';
  }
}

/**
 * Ask the browser once to make this origin's storage durable (not evictable under storage pressure). Chromium and
 * Safari decide silently; Firefox would put up a permission prompt, so it is skipped. Called after the first
 * successful save, never from a guest tab, and any failure is ignored: the backup export remains the real safety net.
 */
let askedPersist = false;
function askForDurableStorage(): void {
  if (askedPersist) return;
  askedPersist = true;
  try {
    if (/Firefox\//.test(navigator.userAgent)) return;
    void navigator.storage?.persist?.()?.catch?.(() => {});
  } catch {
    /* not supported here */
  }
}

export function writeSaveResult(s: Save): WriteResult {
  if (guest) return 'guest';
  lastResult = writeNow(s);
  if (lastResult === 'ok') askForDurableStorage();
  return lastResult;
}

/** True when the save is safe (written, or deliberately not written by a guest tab). */
export function writeSave(s: Save): boolean {
  const r = writeSaveResult(s);
  return r === 'ok' || r === 'guest';
}

/**
 * Put an imported club in place. The club it replaces is kept under its own key (the rolling backup would be
 * overwritten by the very next save), so a wrong restore can be undone by hand. Only the owner tab calls this.
 */
export function replaceSave(s: Save): WriteResult {
  if (guest) return 'guest'; // the owner tab's club is not this tab's to replace
  try {
    const prev = localStorage.getItem(SAVE_KEY);
    if (prev && parseSave(prev)) localStorage.setItem(PRE_IMPORT_KEY, prev);
  } catch {
    /* no room for the safety copy: the import itself still goes ahead */
  }
  return (lastResult = writeNow(s));
}

/** The club that "Undo last restore" and crash recovery would bring back: the pre-import copy, else the rolling backup. */
function previousRaw(): { raw: string; save: Save; key: string } | null {
  try {
    for (const key of [PRE_IMPORT_KEY, BACKUP_KEY]) {
      const raw = localStorage.getItem(key);
      const save = parseSave(raw);
      if (raw && save) return { raw, save, key };
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function previousClub(): { name: string; played: number } | null {
  if (guest) return null;
  const p = previousRaw();
  return p ? { name: p.save.club.name, played: p.save.club.played } : null;
}

/** Swap the previous club back in. What it replaces is kept as the new "previous", so it can be undone again. */
export function restorePrevious(): boolean {
  if (guest) return false;
  const p = previousRaw();
  if (!p) return false;
  try {
    const current = localStorage.getItem(SAVE_KEY);
    localStorage.setItem(SAVE_KEY, p.raw);
    if (current) localStorage.setItem(PRE_IMPORT_KEY, current);
    if (p.key === BACKUP_KEY) localStorage.removeItem(BACKUP_KEY);
    lastGood = p.raw;
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  if (guest) return;
  try {
    for (const k of [SAVE_KEY, BACKUP_KEY, PRE_IMPORT_KEY, CORRUPT_KEY]) localStorage.removeItem(k);
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
      ...(strings(p.coachSeen) ? { coachSeen: strings(p.coachSeen) } : {}),
      ...(strings(p.marks) ? { marks: strings(p.marks) } : {}),
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
