// Local-first persistence for the prototype. The roadmap moves this behind
// an API; until then the save lives in this browser only.

import { isSave, type Save } from '../meta/game.ts';

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
  halfSeconds: number;
  controls: ControlStyle;
  /** false while first-run setup is unfinished; missing means an older save that never saw it. */
  onboarded?: boolean;
}

export function loadSave(): Save | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSave(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSave(s: Save): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      halfSeconds: typeof p.halfSeconds === 'number' ? p.halfSeconds : 120,
      controls: p.controls === 'keys' ? 'keys' : 'mouse',
      ...(typeof p.onboarded === 'boolean' ? { onboarded: p.onboarded } : {}),
    };
  } catch {
    return { halfSeconds: 120, controls: 'mouse' };
  }
}

export function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
