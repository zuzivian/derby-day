// Crash safety: one calm full-screen panel for an uncaught error or unhandled rejection, with Reload and
// "Copy error details". It never reloads on its own (so it cannot loop), shows once, and the details hold
// no personal data: message, stack, build, browser and the page path, never the save or the query string.
// If DERBY_ERROR_URL was set at build time the same details are also sent, rate limited, with sendBeacon.

import { BUILD_ID, ERROR_URL } from './build-config.ts';

export interface CrashDetails {
  message: string;
  stack: string;
  source: 'error' | 'rejection';
  build: string;
  time: string;
  page: string;
  userAgent: string;
}

/** Browser noise that is not the game's fault and must not take the screen away. */
const BENIGN = [/ResizeObserver loop/i, /^Script error\.?$/i, /Non-Error promise rejection captured/i, /The play\(\) request was interrupted/i, /AbortError/i, /Failed to fetch/i, /NetworkError/i, /Load failed/i];

export function describe(reason: unknown, source: CrashDetails['source'], now = new Date()): CrashDetails {
  const e = reason as { message?: unknown; stack?: unknown } | null;
  const message = String(typeof reason === 'string' ? reason : (e && e.message) ?? reason ?? 'Unknown error').slice(0, 400);
  const stack = String((e && typeof e === 'object' && e.stack) || '').split('\n').slice(0, 12).join('\n').slice(0, 2000);
  return {
    message,
    stack,
    source,
    build: BUILD_ID,
    time: now.toISOString(),
    page: typeof location === 'undefined' ? '' : location.protocol + '//' + location.host + location.pathname,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };
}

export const isBenign = (d: Pick<CrashDetails, 'message'>): boolean => BENIGN.some((r) => r.test(d.message));

export function detailsText(d: CrashDetails): string {
  return `Derby Day crash report\nbuild: ${d.build}\ntime: ${d.time}\npage: ${d.page}\nkind: ${d.source}\nbrowser: ${d.userAgent}\n\n${d.message}\n${d.stack}`.trim();
}

const MAX_REPORTS = 3;
let reports = 0;
const reported = new Set<string>();

/** Rate limited (3 a page load, none twice) and a no-op unless DERBY_ERROR_URL was set at build time. */
export function report(d: CrashDetails, url = ERROR_URL, send: (u: string, body: string) => boolean = beacon): boolean {
  if (!url || reports >= MAX_REPORTS || reported.has(d.message)) return false;
  reported.add(d.message);
  reports++;
  return send(url, JSON.stringify({ ...d, page: d.page }));
}

function beacon(url: string, body: string): boolean {
  try {
    return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
  } catch {
    return false;
  }
}

export interface CrashHooks {
  /** True when the last save attempt failed, so the panel must not say the club is safe. */
  unsaved?: () => boolean;
  /** An earlier club that can be swapped back in (shown when the crash happens right at start-up). */
  recover?: () => { name: string; run: () => void } | null;
}
let hooks: CrashHooks = {};
const loadedAt = typeof performance === 'undefined' ? 0 : performance.now();
/** A crash this soon after the page loaded is a boot crash: the club itself may be what the game cannot open. */
const BOOT_WINDOW_MS = 15000;

let shown = false;
const seen: CrashDetails[] = [];

function panel(): void {
  if (shown || typeof document === 'undefined') return;
  shown = true;
  try {
    const el = document.createElement('div');
    el.id = 'crash-panel';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'crash-title');
    const box = document.createElement('div');
    box.className = 'crash-box';
    const h = document.createElement('h1');
    h.id = 'crash-title';
    h.tabIndex = -1;
    h.textContent = 'Something went wrong';
    const p = document.createElement('p');
    let unsaved = false;
    try {
      unsaved = !!hooks.unsaved?.();
    } catch {
      /* unknown: say nothing reassuring */
      unsaved = true;
    }
    p.textContent = `Derby Day hit a problem and stopped. ${unsaved ? 'Your latest progress may not be saved.' : 'Your club was saved as you played.'} Reloading usually fixes it.`;
    const row = document.createElement('div');
    row.className = 'crash-actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn primary';
    reload.id = 'crash-reload';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.id = 'crash-copy';
    copy.textContent = 'Copy error details';
    const note = document.createElement('p');
    note.className = 'crash-note';
    note.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      const text = seen.map(detailsText).join('\n\n---\n\n');
      try {
        await navigator.clipboard.writeText(text);
        note.textContent = 'Copied. Paste it into your bug report.';
      } catch {
        const ta = document.createElement('textarea');
        ta.className = 'crash-details';
        ta.readOnly = true;
        ta.value = text;
        box.appendChild(ta);
        ta.select();
        note.textContent = 'Copy this text into your bug report.';
      }
    });
    row.append(reload, copy);
    try {
      const rec = performance.now() - loadedAt < BOOT_WINDOW_MS ? hooks.recover?.() : null;
      if (rec) {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'btn';
        undo.id = 'crash-restore';
        undo.textContent = `Restore my previous club (${rec.name})`;
        undo.addEventListener('click', () => rec.run());
        row.append(undo);
      }
    } catch {
      /* the panel still works without it */
    }
    box.append(h, p, row, note);
    el.appendChild(box);
    document.body.appendChild(el);
    h.focus();
  } catch {
    // The page is too broken to draw on: fall back to the browser's own dialog, once.
    try {
      alert('Derby Day hit a problem. Please reload the page.');
    } catch {
      /* nothing left to try */
    }
  }
}

function handle(reason: unknown, source: CrashDetails['source']): void {
  try {
    const d = describe(reason, source);
    if (isBenign(d)) return;
    if (seen.length < 5) seen.push(d);
    report(d);
    panel();
  } catch {
    /* the handler itself must never throw */
  }
}

let installed = false;
/** Install the global handlers once. Call before anything else runs. */
export function installErrorHandlers(h: CrashHooks = {}): void {
  hooks = h;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // A failed <img>/<script> load dispatches an error event with no message; only real exceptions count.
    if (!e.error && !e.message) return;
    handle(e.error ?? e.message, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => handle(e.reason, 'rejection'));
}
