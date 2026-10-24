// Entry point. Crash safety first, then the one-tab guard, then the game itself (main.ts), which is
// only loaded once this tab owns the club (or is a read-only guest).

import { installErrorHandlers } from './errors.ts';
import { showToast } from './a11y.ts';
import { showGuardScreen } from './guardView.ts';
import { registerServiceWorker } from './pwa.ts';
import { lastWriteFailed, previousClub, restorePrevious, setSaveGuest } from './store.ts';
import { SAVE_VERSION } from '../meta/game.ts';
import { claim } from './tabguard.ts';
import { telemetry } from './telemetry.ts';

/** The web-font sheet is linked as media=print so it cannot block first paint; switch it on once it has loaded. */
function enableWebFonts(): void {
  try {
    const link = document.getElementById('gfonts') as HTMLLinkElement | null;
    if (!link) return;
    const on = () => {
      link.media = 'all';
    };
    if (link.sheet) on();
    else link.addEventListener('load', on, { once: true });
  } catch {
    /* system fonts it is */
  }
}
enableWebFonts();

installErrorHandlers({
  unsaved: lastWriteFailed,
  recover: () => {
    const prev = previousClub();
    return prev ? { name: prev.name, run: () => restorePrevious() && location.reload() } : null;
  },
});

let started = false;
let removeGuard: (() => void) | null = null;

function startGame(): void {
  if (started) return;
  started = true;
  try {
    telemetry.track({ name: 'app_open' });
  } catch {
    /* analytics must never stop the game */
  }
  void import('./main.ts');
  registerServiceWorker(() => {
    // The page keeps running; the next load is the new version. Do not interrupt a match with the notice.
    const tell = () => {
      if (document.querySelector('#pitch')) setTimeout(tell, 15000);
      else showToast('Derby Day updated. Reload to get the latest version.', true, 10000);
    };
    tell();
  });
}

function guard(reason: 'other-tab' | 'taken' | 'newer'): void {
  removeGuard?.();
  removeGuard = showGuardScreen({
    reason,
    onTaken: () => location.reload(),
    onGuest: () => {
      setSaveGuest(true);
      removeGuard?.();
      removeGuard = null;
      startGame();
    },
  });
}

/** Cheap check (no JSON parse): the stored save starts {"version":N and N is above what this page understands. */
function newerSave(): boolean {
  try {
    const m = /^\{\s*"version"\s*:\s*(\d+)/.exec((localStorage.getItem('derbyday.save.v1') ?? '').slice(0, 40));
    return !!m && Number(m[1]) > SAVE_VERSION;
  } catch {
    return false;
  }
}

/**
 * Test-only escape hatch: when the e2e harness sets window.__e2eSkipTabGuard (its openApp/nextVisit helpers open a
 * second page while the first stays open and owns the club), the guard does nothing for that page, exactly as before
 * the guard existed. It is a flag of its own, separate from window.__e2e, so the guard's own tests (which never set it)
 * still run the real guard. Nothing in the shipped page sets it.
 */
function guardSkippedForTests(): boolean {
  try {
    return (window as unknown as { __e2eSkipTabGuard?: unknown }).__e2eSkipTabGuard === true;
  } catch {
    return false;
  }
}

if (guardSkippedForTests()) startGame();
else
  void claim({
    onLost: () => {
      setSaveGuest(true);
      guard('taken');
    },
  }).then((owned) => {
    if (owned && newerSave()) {
      setSaveGuest(true);
      guard('newer');
    } else if (owned) startGame();
    else {
      setSaveGuest(true);
      guard('other-tab');
    }
  });
