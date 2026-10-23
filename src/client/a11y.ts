// Accessibility plumbing shared by the management screens, the match and the
// onboarding: live regions that survive innerHTML re-renders, focus that comes
// back to the same control after a re-render, a focus trap for dialogs, and
// arrow-key tabs.

// ---------------------------------------------------------------------------
// Live regions. Both live on <body>, outside #app, so re-rendering the app
// never recreates them (a recreated region is often not announced).

function region(id: string, make: (el: HTMLElement) => void): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    make(el);
    document.body.appendChild(el);
  }
  return el;
}

const announcer = () =>
  region('sr-announcer', (el) => {
    el.className = 'sr-only';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
  });

const toastRegion = () =>
  region('toast-region', (el) => {
    el.className = 'toast-region';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
  });

let announceTimer = 0;
/** Say something to screen readers without showing it. Repeating the same text still announces. */
export function announce(text: string): void {
  const el = announcer();
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => (el.textContent = text), 60);
}

let toastTimer = 0;
let toastShowTimer = 0;
/** Visible toast inside a persistent polite status region. */
export function showToast(text: string, ok = true, ms = 3600): void {
  const el = toastRegion();
  el.replaceChildren();
  clearTimeout(toastTimer);
  clearTimeout(toastShowTimer);
  const t = document.createElement('div');
  t.className = `toast ${ok ? 'ok' : 'bad'}`;
  t.textContent = text;
  // Empty first, then fill, so an identical message is announced again.
  toastShowTimer = window.setTimeout(() => el.appendChild(t), 30);
  toastTimer = window.setTimeout(hideToast, ms);
}

export function hideToast(): void {
  clearTimeout(toastTimer);
  clearTimeout(toastShowTimer);
  document.getElementById('toast-region')?.replaceChildren();
}

export function initLiveRegions(): void {
  announcer();
  toastRegion();
}

// ---------------------------------------------------------------------------
// Focus that survives root.innerHTML = ...

const KEY_ATTRS = ['action', 'id', 'screen', 'attr', 'role', 'level', 'slot', 'ob'] as const;

export interface FocusKey {
  elId: string;
  data: Partial<Record<(typeof KEY_ATTRS)[number], string>>;
  /** Position among controls with the same data-action, for when the exact one is gone. */
  index: number;
}

/** Actions that replace each other in place (Sell -> Confirm sale and so on). */
const ALIASES: Record<string, string[]> = {
  sell: ['sell-confirm'],
  'sell-confirm': ['sell'],
  reset: ['reset-confirm'],
  'reset-confirm': ['reset'],
  'reset-cancel': ['reset'],
};

export function focusKeyOf(el: HTMLElement, root: HTMLElement): FocusKey {
  const data: FocusKey['data'] = {};
  for (const k of KEY_ATTRS) if (el.dataset[k] !== undefined) data[k] = el.dataset[k];
  const action = el.dataset.action;
  const peers = action ? [...root.querySelectorAll<HTMLElement>(`[data-action="${CSS.escape(action)}"]`)] : [];
  return { elId: el.id, data, index: Math.max(0, peers.indexOf(el)) };
}

export function captureFocus(root: HTMLElement): FocusKey | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || !root.contains(el)) return null;
  return focusKeyOf(el, root);
}

const selectorFor = (data: FocusKey['data']) =>
  Object.entries(data)
    .map(([k, v]) => `[data-${k}="${CSS.escape(v!)}"]`)
    .join('');

function visible(el: HTMLElement): boolean {
  return !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;
}

/** Find the best stand-in for a control that was focused before a re-render, and focus it. */
export function restoreFocus(root: HTMLElement, key: FocusKey | null, fallback?: string): void {
  if (!key) return;
  const pick = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].filter(visible);
  const tries: (() => HTMLElement | undefined)[] = [
    () => (key.elId ? pick(`#${CSS.escape(key.elId)}`)[0] : undefined),
    () => (Object.keys(key.data).length ? pick(selectorFor(key.data))[0] : undefined),
    () => (key.data.id ? pick(`[data-id="${CSS.escape(key.data.id)}"]`)[0] : undefined),
    () => {
      const a = key.data.action;
      if (!a) return undefined;
      for (const name of [a, ...(ALIASES[a] ?? [])]) {
        const peers = pick(`[data-action="${CSS.escape(name)}"]`);
        if (peers.length) return peers[Math.min(key.index, peers.length - 1)];
      }
      return undefined;
    },
    () => (fallback ? pick(fallback)[0] : undefined),
  ];
  for (const t of tries) {
    const el = t();
    if (el) {
      el.focus({ preventScroll: false });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Dialogs

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab and Shift+Tab inside `box`. Call from a keydown handler. */
export function trapTab(box: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && box.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------
// Tabs: Left/Right/Home/End move between tabs. Returns the tab to activate.

export function tabFromKey(e: KeyboardEvent, tabs: HTMLElement[]): HTMLElement | null {
  const i = tabs.indexOf(e.target as HTMLElement);
  if (i < 0) return null;
  const n = tabs.length;
  const to: Record<string, number> = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 };
  if (!(e.key in to)) return null;
  e.preventDefault();
  return tabs[to[e.key]];
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
