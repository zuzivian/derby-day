// Telemetry hooks for the Phase 1 feel-lab metrics. OFF unless DERBY_TELEMETRY_URL was set at build time,
// and even then silent when the browser sends Do Not Track or Global Privacy Control, or the player turned
// it off in Settings. No cookies. The only identifier is a random install id kept in localStorage. Events
// carry no club name, no player data and no free text. They are batched and sent with sendBeacon.
// Privacy note: docs/OPS.md.

import { TELEMETRY_URL } from './build-config.ts';

export type TelemetryEvent =
  | { name: 'app_open' }
  | { name: 'first_match_start' }
  | { name: 'match_start'; kind: string; controls: 'mouse' | 'keys' }
  | { name: 'match_end'; kind: string; score: [number, number]; forfeit: boolean }
  | { name: 'second_session' }
  | { name: 'level_up'; level: number }
  | { name: 'control_mode'; mode: 'mouse' | 'keys' };

interface Stored {
  name: string;
  t: number;
  [k: string]: unknown;
}

export interface TelemetryDeps {
  url: string;
  dnt: boolean;
  gpc: boolean;
  store: Pick<Storage, 'getItem' | 'setItem'>;
  send: (url: string, body: string) => boolean;
  now: () => number;
  random: () => string;
  /** Called to arrange flushes (default: timers and page-hide listeners). */
  schedule?: (flush: () => void) => void;
}

const IID_KEY = 'derbyday.iid.v1';
const OFF_KEY = 'derbyday.telemetry.off';
const SEEN_KEY = 'derbyday.telemetry.seen.v1';
/** A visit more than this long after the last one counts as a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;
const BATCH_MAX = 20;
const QUEUE_MAX = 100;

export interface Telemetry {
  readonly enabled: boolean;
  track(e: TelemetryEvent): void;
  /** Report the club level; sends level_up when it rose since the last call. */
  level(level: number): void;
  flush(): void;
  setOptOut(off: boolean): void;
  optedOut(): boolean;
}

export function createTelemetry(d: TelemetryDeps): Telemetry {
  const get = (k: string): string | null => {
    try {
      return d.store.getItem(k);
    } catch {
      return null;
    }
  };
  const set = (k: string, v: string): void => {
    try {
      d.store.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  };
  const optedOut = () => get(OFF_KEY) === '1';
  const compiledIn = !!d.url && !d.dnt && !d.gpc;
  const on = () => compiledIn && !optedOut();
  let queue: Stored[] = [];
  let lastLevel = -1;
  /** The last send failed: wait for the next timed flush instead of retrying on every event. */
  let failing = false;

  const iid = (): string => {
    let v = get(IID_KEY);
    if (!v) set(IID_KEY, (v = d.random()));
    return v;
  };

  const flush = () => {
    if (!on() || !queue.length) return;
    const events = queue.splice(0, queue.length);
    const ok = d.send(d.url, JSON.stringify({ v: 1, iid: iid(), events }));
    failing = !ok;
    if (!ok) queue = events.concat(queue).slice(-QUEUE_MAX);
  };

  const push = (e: TelemetryEvent) => {
    if (!on()) return;
    const { name, ...props } = e;
    queue.push({ name, t: d.now(), ...props });
    if (queue.length > QUEUE_MAX) queue.shift();
    if (queue.length >= BATCH_MAX && !failing) flush();
  };

  // Seen-state: { first: ms of first visit, last: ms of last visit, sessions, matches }. Counts only, no ids.
  const seen = (): { first: number; last: number; sessions: number; matches: number } => {
    try {
      const v = JSON.parse(get(SEEN_KEY) ?? 'null');
      if (v && typeof v.first === 'number') return { first: v.first, last: v.last ?? v.first, sessions: v.sessions ?? 1, matches: v.matches ?? 0 };
    } catch {
      /* fall through */
    }
    return { first: 0, last: 0, sessions: 0, matches: 0 };
  };

  const t: Telemetry = {
    enabled: compiledIn,
    optedOut,
    setOptOut(off) {
      set(OFF_KEY, off ? '1' : '0');
      if (off) queue = [];
    },
    flush,
    level(level) {
      if (lastLevel >= 0 && level > lastLevel) push({ name: 'level_up', level });
      lastLevel = level;
    },
    track(e) {
      if (!on()) return;
      const s = seen();
      if (e.name === 'app_open') {
        const now = d.now();
        const newSession = !s.first || now - s.last > SESSION_GAP_MS;
        const sessions = s.sessions + (newSession ? 1 : 0);
        set(SEEN_KEY, JSON.stringify({ first: s.first || now, last: now, sessions, matches: s.matches }));
        push(e);
        if (newSession && s.sessions === 1) push({ name: 'second_session' });
        return;
      }
      if (e.name === 'match_start') {
        set(SEEN_KEY, JSON.stringify({ ...s, matches: s.matches + 1 }));
        if (s.matches === 0) push({ name: 'first_match_start' });
        push(e);
        push({ name: 'control_mode', mode: e.controls });
        return;
      }
      push(e);
    },
  };
  d.schedule?.(flush);
  return t;
}

function browserDeps(): TelemetryDeps {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const dntVal = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack;
  return {
    url: TELEMETRY_URL,
    dnt: dntVal === '1' || dntVal === 'yes',
    gpc: nav.globalPrivacyControl === true,
    store: localStorage,
    send: (url, body) => {
      try {
        return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
    random: () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)),
    schedule: (flush) => {
      setInterval(flush, 15000);
      addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
      addEventListener('pagehide', flush);
    },
  };
}

const noop: Telemetry = { enabled: false, track() {}, level() {}, flush() {}, setOptOut() {}, optedOut: () => false };

/** The page's telemetry. A do-nothing object when none is compiled in, so call sites stay one line. */
export const telemetry: Telemetry = (() => {
  if (!TELEMETRY_URL || typeof window === 'undefined') return noop;
  try {
    return createTelemetry(browserDeps());
  } catch {
    return noop;
  }
})();
