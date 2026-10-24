// Offline play and safe updates. Registers /sw.js (static/sw.js) where a service worker can run: an
// https page or localhost, and not the sandboxed viewer that hosts dist/derby-day.artifact.html, nor
// file:// (the e2e suite). Anywhere else this does nothing.

export const canRegister = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
  !/\bno-sw\b/.test(location.search);

/**
 * Register the worker after the page has loaded (so it never competes with first paint). `onUpdate` is
 * called when a new version has taken over from an old one; the page already running keeps working, and the
 * next load is the new version.
 */
export function registerServiceWorker(onUpdate: () => void): void {
  if (!canRegister()) return;
  const hadController = !!navigator.serviceWorker.controller;
  let notified = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !notified) {
      notified = true;
      onUpdate();
    }
  });
  const go = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(
      (reg) => {
        // A tab that stays open for days still looks for a new version now and then.
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      },
      () => {
        /* blocked (private mode, sandbox): the game works fine without it */
      },
    );
  };
  if (document.readyState === 'complete') go();
  else addEventListener('load', go, { once: true });
}
