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
