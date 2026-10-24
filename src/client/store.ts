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
  /**
   * Coach tips already shown (src/client/coach.ts). Present only for a club that went through
   * the first-run flow; a player who predates it has none and sees no tips.
   */
  coachSeen?: string[];
  /** Tabs already pointed out with a coach mark. Present only after the first-run flow, like coachSeen. */
  marks?: string[];
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);

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
