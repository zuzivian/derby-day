// One tab owns the club. Two tabs writing the same localStorage save would overwrite each other.
//
// Ownership is a Web Lock ('derby-day-owner', held for as long as the tab owns the club). Taking a lock is
// atomic across tabs, so two tabs opened in the same instant cannot both win, and the browser drops it when
// the tab closes or crashes, so it can never go stale. Where Web Locks is missing (very old browsers, or a
// sandboxed viewer with an opaque origin) a localStorage lease takes over: a heartbeat plus a deterministic
// tie-break (the lowest tab id keeps the club whenever two tabs find they both claimed it).
//
// A message channel (BroadcastChannel, or storage events where it is missing) carries the hand-over:
//   - A tab that does not get the club does not boot the game: it shows the "open in another tab" screen.
//   - "Play here instead" asks the owner to yield. An owner in a live match answers "busy" and keeps
//     the club until the match is over (its result is saved first); the asking tab waits and takes over then.
//   - "Use as a guest" boots the game read-only (nothing is saved), which is what Link play needs for
//     its second tab.

const LOCK = 'derby-day-owner';
const LEASE_KEY = 'derbyday.lease.v1';
const MSG_KEY = 'derbyday.lease.msg';
const CHANNEL = 'derbyday.lease';
export const HEARTBEAT_MS = 2000;
export const STALE_MS = 7000;
/** How long a taker waits for the owner to answer before treating it as gone. */
const ASK_MS = 1500;
/** After the owner yields, how long a taker waits for the lock to come free before taking it by force. */
const LOCK_WAIT_MS = 3000;

type Msg = { type: 'ask' | 'yield' | 'busy' | 'claim'; from: string; to?: string };
interface Lease {
  id: string;
  t: number;
}

export interface GuardHooks {
  /** This tab lost the club (the owner yielded it). */
  onLost: () => void;
}

let busyProbe: () => boolean = () => false;
/** The game tells the guard when a match, setup or the training ground is on screen: the club is not handed over then. */
export function setBusyProbe(fn: () => boolean): void {
  busyProbe = fn;
}

const me = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let owner = false;
let hooks: GuardHooks | null = null;
let channel: BroadcastChannel | null = null;
let beat: ReturnType<typeof setInterval> | undefined;
let waiting: ((m: Msg) => void) | null = null;
/** This browser did hand out a Web Lock for the club (so the lease is not needed). */
let useLocks = false;
let releaseLock: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Web Locks

const locksAvailable = (): boolean => {
  try {
    return typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
  } catch {
    return false;
  }
};

type Acquired = 'got' | 'busy' | 'timeout' | 'unsupported';

/** Ask for the lock. While this tab owns the club the lock's callback never returns: releaseLock() ends it. */
function acquireLock(opts: { ifAvailable?: boolean; steal?: boolean; timeoutMs?: number }): Promise<Acquired> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Acquired) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const ctl = opts.timeoutMs ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs) : undefined;
    const options: LockOptions = {};
    if (opts.ifAvailable) options.ifAvailable = true;
    if (opts.steal) options.steal = true;
    if (ctl) options.signal = ctl.signal;
    try {
      navigator.locks.request(LOCK, options, (lock) => {
        clearTimeout(timer);
        if (!lock) {
          done('busy');
          return;
        }
        done('got');
        return new Promise<void>((end) => {
          releaseLock = end;
        });
      }).then(
        () => {
          /* released normally */
        },
        (e: unknown) => {
          clearTimeout(timer);
          if (!settled) done((e as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'unsupported');
          else if (owner) stolen(); // another tab took the lock by force: this one stepped aside
        },
      );
    } catch {
      clearTimeout(timer);
      done('unsupported'); // e.g. an opaque-origin sandbox
    }
  });
}

/** The lock was taken from under this tab (it did not answer a hand-over request in time). */
function stolen(): void {
  owner = false;
  releaseLock = null;
  const go = () => {
    // A match in progress finishes and saves its result first; only then does this tab step aside.
    if (busyProbe()) setTimeout(go, 1000);
    else hooks?.onLost();
  };
  go();
}

// ---------------------------------------------------------------------------
// Lease (fallback) and messages

function readLease(): Lease | null {
  try {
    const v = JSON.parse(localStorage.getItem(LEASE_KEY) ?? 'null') as Lease | null;
    return v && typeof v.id === 'string' && typeof v.t === 'number' ? v : null;
  } catch {
    return null;
  }
}

function writeLease(): void {
  try {
    localStorage.setItem(LEASE_KEY, JSON.stringify({ id: me, t: Date.now() } satisfies Lease));
  } catch {
    /* storage unavailable: nothing to guard */
  }
}

const fresh = (l: Lease | null): l is Lease => !!l && Date.now() - l.t < STALE_MS && Date.now() - l.t > -STALE_MS;

function post(m: Omit<Msg, 'from'>): void {
  const msg: Msg = { ...m, from: me };
  try {
    if (channel) channel.postMessage(msg);
    else localStorage.setItem(MSG_KEY, JSON.stringify({ ...msg, n: Math.random() }));
  } catch {
    /* ignore */
  }
}

/** Two tabs both believe they own the club (lease fallback only). The lowest tab id keeps it. */
function conflict(other: string): void {
  if (!owner || useLocks || other >= me || busyProbe()) return;
  release();
  hooks?.onLost();
}

function onMessage(m: Msg): void {
  if (!m || m.from === me || (m.to && m.to !== me)) return;
  if (m.type === 'claim') conflict(m.from);
  else if (m.type === 'ask' && owner && hooks) {
    if (busyProbe()) post({ type: 'busy', to: m.from });
    else {
      // Everything is saved as it changes, so letting go is just stopping.
      release();
      post({ type: 'yield', to: m.from });
      hooks.onLost();
    }
  } else if (waiting && (m.type === 'yield' || m.type === 'busy')) waiting(m);
}

function listen(): void {
  if (typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => onMessage(e.data as Msg);
      return;
    } catch {
      channel = null; // an opaque-origin sandbox: fall back to storage events
    }
  }
  window.addEventListener('storage', (e) => {
    if (e.key === MSG_KEY && e.newValue) {
      try {
        onMessage(JSON.parse(e.newValue) as Msg);
      } catch {
        /* ignore */
      }
    }
  });
}

/** Lease fallback: write the lease, say so, and keep saying so. Any conflict is settled by lowest id. */
function startLease(): void {
  owner = true;
  writeLease();
  post({ type: 'claim' });
  setTimeout(() => owner && post({ type: 'claim' }), 100);
  clearInterval(beat);
  beat = setInterval(() => {
    const l = readLease();
    if (l && l.id !== me && fresh(l)) conflict(l.id);
    if (owner) {
      writeLease();
      post({ type: 'claim' });
    }
  }, HEARTBEAT_MS);
}

function release(): void {
  clearInterval(beat);
  const end = releaseLock;
  releaseLock = null;
  end?.();
  if (owner) {
    owner = false;
    try {
      if (readLease()?.id === me) localStorage.removeItem(LEASE_KEY);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Try to own the club. Resolves true when this tab now owns it, false when another tab does. Call once at
 * boot, before touching the save. With Web Locks the answer is atomic. In the lease fallback, a lease that went
 * stale (a crashed tab, or an owner in a background tab whose timers are throttled) is not simply taken: the
 * owner is asked first, so a tab that is only sleeping still gets to say it is busy.
 */
export async function claim(h: GuardHooks): Promise<boolean> {
  hooks = h;
  listen();
  // A page restored from the back-forward cache has let go of the club, so it reloads (pageshow below).
  addEventListener('pagehide', release);
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
  addEventListener('visibilitychange', () => {
    if (owner && !useLocks && document.visibilityState === 'visible') writeLease();
  });
  if (locksAvailable()) {
    const r = await acquireLock({ ifAvailable: true });
    if (r === 'got') {
      useLocks = true;
      owner = true;
      return true;
    }
    if (r === 'busy') {
      useLocks = true;
      return false;
    }
    // 'unsupported': fall through to the lease
  }
  const l = readLease();
  if (!l || l.id === me) {
    startLease();
    return true;
  }
  if (fresh(l)) return false;
  return (await take()) === 'taken';
}

export type TakeResult = 'taken' | 'busy';

/** Ask the owner to let go. 'none' when nobody answers in time. */
function ask(): Promise<'yield' | 'busy' | 'none'> {
  return new Promise((resolve) => {
    const finish = (r: 'yield' | 'busy' | 'none') => {
      clearTimeout(timer);
      waiting = null;
      resolve(r);
    };
    const timer = setTimeout(() => finish('none'), ASK_MS);
    waiting = (m) => finish(m.type === 'busy' ? 'busy' : 'yield');
    post({ type: 'ask' });
  });
}

/**
 * Ask the owner for the club. 'taken' once it yielded (or did not answer: gone). 'busy' while it is in a
 * match; call again later, or use takeWhenFree().
 */
export async function take(): Promise<TakeResult> {
  const answer = await ask();
  if (answer === 'busy') return 'busy';
  if (useLocks) {
    // The owner let go (or never answered): wait briefly for the lock to come free, then take it by force.
    let r: Acquired = answer === 'yield' ? await acquireLock({ timeoutMs: LOCK_WAIT_MS }) : 'timeout';
    if (r !== 'got') r = await acquireLock({ steal: true });
    if (r !== 'got') return 'busy';
    owner = true;
    return 'taken';
  }
  startLease();
  return 'taken';
}

/** Keep asking every few seconds until the owner is out of its match. */
export async function takeWhenFree(onBusy: () => void, every = 2500): Promise<void> {
  for (;;) {
    if ((await take()) === 'taken') return;
    onBusy();
    await new Promise((r) => setTimeout(r, every));
  }
}

export const owns = (): boolean => owner;
export const tabId = (): string => me;
