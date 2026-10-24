// Entry point. Crash safety first, then the one-tab guard, then the game itself (main.ts), which is
// only loaded once this tab owns the club (or is a read-only guest).

import { installErrorHandlers } from './errors.ts';
import { showToast } from './a11y.ts';
import { showGuardScreen } from './guardView.ts';
import { registerServiceWorker } from './pwa.ts';
import { setSaveGuest } from './store.ts';
import { claim } from './tabguard.ts';
import { telemetry } from './telemetry.ts';

installErrorHandlers();

let started = false;
let removeGuard: (() => void) | null = null;

function startGame(): void {
  if (started) return;
  started = true;
  telemetry.track({ name: 'app_open' });
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

function guard(reason: 'other-tab' | 'taken'): void {
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

void claim({
  onLost: () => {
    setSaveGuest(true);
    guard('taken');
  },
}).then((owned) => {
  if (owned) startGame();
  else {
    setSaveGuest(true);
    guard('other-tab');
  }
});
