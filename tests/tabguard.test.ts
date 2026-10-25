// The tab guard against a lock manager that answers late. A fake navigator.locks stands in for the browser's.

import { afterAll, expect, test } from 'bun:test';

// Bun runs every test file in one process, so whatever is stubbed here is put back afterwards.
const g = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, PropertyDescriptor | undefined>();
function stub(name: string, value: unknown): void {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const [name, d] of saved) {
    if (d) Object.defineProperty(globalThis, name, d);
    else delete g[name];
  }
});

const mem = new Map<string, string>();
// history.state holds the hand-over expectation; `sess` keeps the old Map-like view of it for the assertions.
let state: Record<string, unknown> | null = null;
stub('history', { get state() { return state; }, replaceState: (v: Record<string, unknown>) => void (state = v) });
const sess = {
  clear: () => void (state = null),
  has: (k: string) => !!state && k in state,
  get: (k: string) => (state && k in state ? JSON.stringify(state[k]) : undefined),
  set: (k: string, v: string) => void (state = { ...(state ?? {}), [k]: JSON.parse(v) }),
};
stub('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) });
stub('addEventListener', () => {});
stub('location', { reload() {} });
stub('document', { visibilityState: 'visible', querySelector: () => null });

type Opts = { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal };
const held: string[] = [];

/** Another tab holds the lock for good. Polite requests wait (and honour their abort signal); a steal is answered after `stealAfterMs`. */
function fakeLocks(stealAfterMs: number) {
  return {
    request(_name: string, o: Opts, cb: (lock: object | null) => unknown): Promise<unknown> {
      if (o.ifAvailable) return Promise.resolve(cb(null));
      if (o.steal) {
        return new Promise((resolve) =>
          setTimeout(() => {
            held.push('stolen');
            resolve(cb({}));
          }, stealAfterMs),
        );
      }
      return new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    },
  };
}

const fresh = async () => (await import(`../src/client/tabguard.ts?fresh=${Math.random()}`)) as typeof import('../src/client/tabguard.ts');
const SAVE = 'derbyday.save.v1';
const EXPECT = 'derbyday.handover';

// First in the file on purpose: a module instance that owns the club (the next test) would also answer this one's ask.
test('take() keeps what the yielding owner says it left, to check after the reload', async () => {
  stub('navigator', { locks: fakeLocks(0) });
  const guard = await fresh();
  expect(await guard.claim({ onLost: () => {} })).toBe(false);
  // The owner tab: answers an ask with a yield that carries its signature.
  const owner = new BroadcastChannel('derbyday.lease');
  owner.onmessage = (e) => {
    if (e.data?.type === 'ask') owner.postMessage({ type: 'yield', from: 'owner-tab', to: e.data.from, sig: '12:abc|0:1' });
  };
  sess.clear();
  try {
    expect(await guard.take()).toBe('taken');
  } finally {
    owner.close();
  }
  expect(JSON.parse(sess.get(EXPECT)!).sig).toBe('12:abc|0:1');
}, 30_000);

test('a steal the lock manager answers after the 3 s patience still makes this tab the owner', async () => {
  stub('navigator', { locks: fakeLocks(3500) });
  const guard = await import('../src/client/tabguard.ts');
  expect(await guard.claim({ onLost: () => {} })).toBe(false); // the other tab owns the club
  expect(guard.owns()).toBe(false);

  let first = await guard.take(); // ask is unanswered (1.5 s), the polite wait runs out (3 s), the steal is not answered in time
  if (first === 'busy') {
    await new Promise((r) => setTimeout(r, 1000)); // the late grant lands
    first = await guard.take();
  }
  expect(first).toBe('taken');
  expect(held).toContain('stolen');
  expect(guard.owns()).toBe(true); // not dropped: nobody-owns-it is the failure
}, 30_000);

test('handover check: nothing to check, or storage that catches up within the wait, lets the game start', async () => {
  const guard = await fresh();
  sess.clear();
  expect(await guard.handoverReady(100)).toBe(true); // no hand-over happened

  mem.set(SAVE, '{"club":"after the last match"}');
  const sig = guard.storageSig();
  mem.set(SAVE, '{"club":"stale"}'); // what the new page starts on
  sess.set(EXPECT, JSON.stringify({ sig, t: Date.now() }));
  setTimeout(() => mem.set(SAVE, '{"club":"after the last match"}'), 200);
  expect(await guard.handoverReady(1500)).toBe(true);
  expect(sess.has(EXPECT)).toBe(false); // consumed
});

test('handover check: storage that never matches is refused, and stays refused on a retry', async () => {
  const guard = await fresh();
  mem.set(SAVE, '{"club":"after the last match"}');
  const sig = guard.storageSig();
  mem.set(SAVE, '{"club":"stale"}');
  sess.set(EXPECT, JSON.stringify({ sig, t: Date.now() }));
  expect(await guard.handoverReady(300)).toBe(false);
  expect(await guard.handoverReady(300)).toBe(false); // the expectation is kept for the retry
  mem.delete(SAVE); // a missing save is as wrong as an old one
  expect(await guard.handoverReady(100)).toBe(false);
});

test('a restore that the browser lost is written again by the page after the reload, and only a restore is', async () => {
  const guard = await fresh();
  sess.clear();
  mem.set(SAVE, '{"club":"restored"}');
  guard.expectRestore();
  expect(JSON.parse(sess.get(EXPECT)!).restore).toBe('{"club":"restored"}');
  mem.set(SAVE, '{"club":"old"}'); // the write never reached the page that loads next
  expect(await guard.handoverReady(200)).toBe(true);
  expect(mem.get(SAVE)).toBe('{"club":"restored"}');
  expect(sess.has(EXPECT)).toBe(false);

  // A hand-over has no club to put back: it stays refused.
  mem.set(SAVE, '{"club":"after the last match"}');
  const sig = guard.storageSig();
  mem.set(SAVE, '{"club":"stale"}');
  sess.set(EXPECT, JSON.stringify({ sig, t: Date.now() }));
  expect(await guard.handoverReady(100)).toBe(false);
  expect(mem.get(SAVE)).toBe('{"club":"stale"}');
});

test('handover check: an old expectation is forgotten', async () => {
  const guard = await fresh();
  mem.set(SAVE, '{"club":"anything"}');
  sess.set(EXPECT, JSON.stringify({ sig: 'does-not-match', t: Date.now() - 60_000 }));
  expect(await guard.handoverReady(100)).toBe(true);
  expect(sess.has(EXPECT)).toBe(false);
});

