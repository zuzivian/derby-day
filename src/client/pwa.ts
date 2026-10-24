// Offline play and safe updates. Registers /sw.js (static/sw.js) where a service worker can run: a secure
// context on https or localhost, and not the sandboxed viewer that hosts dist/derby-day.artifact.html (there
// even *reading* navigator.serviceWorker throws a SecurityError), nor file:// (the e2e suite). Anywhere else
// this does nothing, and nothing in here can throw.

/** The worker container, or null when this page cannot use one. Every access is guarded. */
function container(): ServiceWorkerContainer | null {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    if (!window.isSecureContext) return null;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return null;
    if (/\bno-sw\b/.test(location.search)) return null;
    return navigator.serviceWorker ?? null;
  } catch {
    return null;
  }
}

export const canRegister = (): boolean => container() !== null;

/**
 * Register the worker after the page has loaded (so it never competes with first paint). `onUpdate` is
 * called when a new version has taken over from an old one; the page already running keeps working, and the
 * next load is the new version.
 */
export function registerServiceWorker(onUpdate: () => void): void {
  try {
    const sw = container();
    if (!sw) return;
    const hadController = !!sw.controller;
    let notified = false;
    sw.addEventListener('controllerchange', () => {
      if (hadController && !notified) {
        notified = true;
        onUpdate();
      }
    });
    const go = () => {
      sw.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(
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
  } catch {
    /* no service worker here */
  }
}
