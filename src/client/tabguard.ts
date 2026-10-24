// One tab owns the club. Two tabs writing the same localStorage save would overwrite each other, so a
// lease in localStorage says who owns it (heartbeat, stale after STALE_MS) and a message channel
// (BroadcastChannel, or storage events where it is missing) lets a second tab ask for it.
//
//   - A tab that finds a fresh lease does not boot the game: it shows the "open in another tab" screen.
//   - "Play here instead" asks the owner to yield. An owner in a live match answers "busy" and keeps
//     the club until the match is over (its result is saved first); the asking tab waits and takes over then.
//   - "Use as a guest" boots the game read-only (nothing is saved), which is what Link play needs for
//     its second tab.

const LEASE_KEY = 'derbyday.lease.v1';
const MSG_KEY = 'derbyday.lease.msg';
const CHANNEL = 'derbyday.lease';
export const HEARTBEAT_MS = 2000;
export const STALE_MS = 7000;
/** How long a taker waits for the owner to answer before treating it as gone. */
const ASK_MS = 1500;
/** After claiming, how long until the tab double-checks that no other tab claimed at the same moment. */
const RACE_CHECK_MS = 120;

type Msg = { type: 'ask' | 'yield' | 'busy'; from: string; to?: string };
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

function onMessage(m: Msg): void {
  if (!m || m.from === me || (m.to && m.to !== me)) return;
  if (m.type === 'ask' && owner && hooks) {
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
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => onMessage(e.data as Msg);
  } else {
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
}

/** Another tab holds a fresh lease while this one believed it owned the club (it was frozen, or two tabs raced). */
const lostTo = (): boolean => {
  const l = readLease();
  return !!l && l.id !== me && fresh(l);
};

function start(): void {
  owner = true;
  writeLease();
  clearInterval(beat);
  beat = setInterval(() => {
    if (lostTo()) {
      // A match in progress finishes and saves its result first; only then does this tab step aside.
      if (busyProbe()) return;
      release();
      hooks?.onLost();
    } else writeLease();
  }, HEARTBEAT_MS);
  // Two tabs opened in the same instant can both read "no lease" and both write one. The last write wins,
  // so a short while later exactly one of them still finds its own id there; the other steps aside.
  setTimeout(() => {
    if (owner && lostTo() && !busyProbe()) {
      release();
      hooks?.onLost();
    }
  }, RACE_CHECK_MS);
}

function release(): void {
  clearInterval(beat);
  if (owner) {
    owner = false;
    try {
      if (readLease()?.id === me) localStorage.removeItem(LEASE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Try to own the club. Resolves true when this tab now owns it, false when another tab does. Call once at
 * boot, before touching the save. With no lease it is immediate. A lease that went stale (a crashed tab, or an
 * owner in a background tab whose timers are throttled) is not simply taken: the owner is asked first, so a
 * tab that is only sleeping still gets to say it is busy.
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
    if (owner && document.visibilityState === 'visible') writeLease();
  });
  const l = readLease();
  if (!l || l.id === me) {
    start();
    return true;
  }
  if (fresh(l)) return false;
  return (await take()) === 'taken';
}

export type TakeResult = 'taken' | 'busy';

/**
 * Ask the owner for the club. 'taken' once it yielded (or did not answer: gone). 'busy' while it is in a
 * match; call again later, or use takeWhenFree().
 */
export function take(): Promise<TakeResult> {
  return new Promise((resolve) => {
    const finish = (r: TakeResult) => {
      clearTimeout(timer);
      waiting = null;
      if (r === 'taken') start();
      resolve(r);
    };
    const timer = setTimeout(() => finish('taken'), ASK_MS);
    waiting = (m) => finish(m.type === 'busy' ? 'busy' : 'taken');
    post({ type: 'ask' });
  });
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
