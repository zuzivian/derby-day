// Local-first persistence for the prototype. The roadmap moves this behind
// an API; until then the save lives in this browser only.

import { isSave, type Save } from '../meta/game.ts';

const SAVE_KEY = 'overlap.save.v1';
const PREFS_KEY = 'overlap.prefs.v1';

export interface Prefs {
  halfSeconds: number;
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
    return { halfSeconds: typeof p.halfSeconds === 'number' ? p.halfSeconds : 120 };
  } catch {
    return { halfSeconds: 120 };
  }
}

export function writePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
