// Launch-readiness modules: save safety (store.ts, backup.ts), crash details (errors.ts) and telemetry.
// store.ts and tabguard.ts read the global localStorage, so a small in-memory one is installed first.

import { beforeEach, describe, expect, test } from 'bun:test';
import { newGame } from '../src/meta/game.ts';

class MemStorage {
  data = new Map<string, string>();
  /** Total characters allowed across values (Infinity = no limit). */
  quota = Infinity;
  get length() {
    return this.data.size;
  }
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    const used = [...this.data].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
    if (used + v.length > this.quota) throw Object.assign(new Error('full'), { name: 'QuotaExceededError', code: 22 });
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const mem = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = mem;

const store = await import('../src/client/store.ts');
const backup = await import('../src/client/backup.ts');
const errors = await import('../src/client/errors.ts');
const tele = await import('../src/client/telemetry.ts');
const dry = await import('../src/client/dryrun.ts');

const KEY = 'derbyday.save.v1';
const BAK = `${KEY}.bak`;

beforeEach(() => {
  mem.data.clear();
  mem.quota = Infinity;
  store.setSaveGuest(false);
});

describe('save safety', () => {
  test('a write keeps the previous good save as the backup', () => {
    const a = newGame(1);
    const b = newGame(2);
    expect(store.writeSaveResult(a)).toBe('ok');
    expect(mem.getItem(BAK)).toBeNull();
    expect(store.writeSaveResult(b)).toBe('ok');
    expect(JSON.parse(mem.getItem(BAK)!).club.name).toBe(a.club.name);
    expect(store.loadSave()!.club.name).toBe(b.club.name);
  });

  test('a corrupt main save is restored from the backup and promoted', () => {
    const a = newGame(1);
    store.writeSaveResult(a);
    store.writeSaveResult(newGame(2));
    mem.setItem(KEY, '{"version":1,"squad":'); // truncated write
    const r = store.loadSaveChecked();
    expect(r.restored).toBe(true);
    expect(r.save!.club.name).toBe(a.club.name);
    expect(JSON.parse(mem.getItem(KEY)!).club.name).toBe(a.club.name); // promoted: next load is clean
    expect(mem.getItem(`${KEY}.corrupt`)).toBe('{"version":1,"squad":'); // kept for support
    expect(store.loadSaveChecked().restored).toBe(false);
  });

  test('a corrupt save is not copied over a good backup', () => {
    const a = newGame(1);
    store.writeSaveResult(a);
    store.writeSaveResult(newGame(2));
    mem.setItem(KEY, 'garbage');
    store.writeSaveResult(newGame(3)); // prev is unreadable, so it must not become the backup
    expect(JSON.parse(mem.getItem(BAK)!).club.name).toBe(a.club.name);
  });

  test('corrupt save with no backup reports lost, and nothing stored reports nothing', () => {
    expect(store.loadSaveChecked()).toEqual({ save: null, restored: false, lost: false, newer: false });
    mem.setItem(KEY, 'garbage');
    expect(store.loadSaveChecked()).toEqual({ save: null, restored: false, lost: true, newer: false });
    expect(mem.getItem(`${KEY}.corrupt`)).toBe('garbage'); // never destroyed by the next write
  });

  test('a save of the wrong shape is rejected like a corrupt one', () => {
    mem.setItem(KEY, JSON.stringify({ version: 99, squad: [], ladder: [], club: {} }));
    expect(store.loadSave()).toBeNull();
  });

  test('quota: the backup is given up to make room, and a full disk reports quota instead of throwing', () => {
    const a = newGame(1);
    const size = JSON.stringify(a).length;
    store.writeSaveResult(a);
    store.writeSaveResult(newGame(2));
    expect(mem.getItem(BAK)).not.toBeNull();
    mem.quota = Math.round(size * 1.3); // room for one save, not two
    expect(store.writeSaveResult(newGame(3))).toBe('ok');
    expect(mem.getItem(BAK)).toBeNull();
    mem.quota = 100;
    expect(store.writeSaveResult(newGame(4))).toBe('quota');
    expect(store.writeSave(newGame(4))).toBe(false);
  });

  test('blocked storage reports blocked', () => {
    const real = mem.setItem;
    mem.setItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(store.writeSaveResult(newGame(1))).toBe('blocked');
    } finally {
      mem.setItem = real;
    }
  });

  test('a guest tab never writes the club', () => {
    store.writeSaveResult(newGame(1));
    const before = mem.getItem(KEY);
    store.setSaveGuest(true);
    expect(store.writeSaveResult(newGame(2))).toBe('guest');
    expect(store.writeSave(newGame(2))).toBe(true);
    store.clearSave();
    expect(mem.getItem(KEY)).toBe(before);
    expect(store.replaceSave(newGame(3))).toBe('guest'); // import is the owner tab's act, not a guest's
  });

  test('clearSave removes the backup too, so a new club does not resurrect the old one', () => {
    store.writeSaveResult(newGame(1));
    store.writeSaveResult(newGame(2));
    store.clearSave();
    expect(store.loadSaveChecked()).toEqual({ save: null, restored: false, lost: false, newer: false });
  });

  test('a save from a newer build is reported, left byte for byte alone, and never replaced by the backup', () => {
    const a = newGame(1);
    store.writeSaveResult(a);
    const newer = JSON.stringify({ ...newGame(2), version: 99, shiny: true });
    mem.setItem(KEY, newer);
    const r = store.loadSaveChecked();
    expect(r).toEqual({ save: null, restored: false, lost: false, newer: true });
    expect(mem.getItem(KEY)).toBe(newer);
    store.setSaveGuest(true); // what main.ts does for it
    expect(store.writeSaveResult(newGame(3))).toBe('guest');
    expect(mem.getItem(KEY)).toBe(newer);
  });

  test('a guest tab cannot import over the owner', () => {
    store.writeSaveResult(newGame(1));
    const before = mem.getItem(KEY);
    store.setSaveGuest(true);
    expect(store.replaceSave(newGame(2))).toBe('guest');
    expect(mem.getItem(KEY)).toBe(before);
    expect(store.restorePrevious()).toBe(false);
    expect(store.previousClub()).toBeNull();
  });

  test('restorePrevious swaps the earlier club back in, and can be undone again', () => {
    const old = newGame(1);
    const incoming = newGame(2);
    store.writeSaveResult(old);
    store.replaceSave(incoming);
    expect(store.previousClub()!.name).toBe(old.club.name);
    expect(store.restorePrevious()).toBe(true);
    expect(store.loadSave()!.club.name).toBe(old.club.name);
    expect(store.previousClub()!.name).toBe(incoming.club.name);
    expect(store.restorePrevious()).toBe(true);
    expect(store.loadSave()!.club.name).toBe(incoming.club.name);
  });

  test('a full disk gives up safety copies, in order, before it gives up on the save', () => {
    const a = newGame(1);
    const size = JSON.stringify(a).length;
    store.writeSaveResult(a);
    store.replaceSave(newGame(2));
    mem.setItem(`${KEY}.corrupt`, 'x'.repeat(size));
    mem.quota = Math.round(size * 2.4);
    expect(store.writeSaveResult({ ...a, budget: a.budget + 5 })).toBe('ok');
    expect(mem.getItem(`${KEY}.corrupt`)).toBeNull();
    expect(store.lastWriteFailed()).toBe(false);
    mem.quota = 100;
    expect(store.writeSaveResult(newGame(3))).toBe('quota');
    expect(store.lastWriteFailed()).toBe(true);
  });
});

describe('durable storage request', () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const calls = { n: 0 };
  const realStorage = Object.getOwnPropertyDescriptor(nav, 'storage');
  const realUA = Object.getOwnPropertyDescriptor(nav, 'userAgent');
  const set = (storage: unknown, ua?: string) => {
    Object.defineProperty(nav, 'storage', { value: storage, configurable: true });
    if (ua !== undefined) Object.defineProperty(nav, 'userAgent', { value: ua, configurable: true });
  };
  const restore = () => {
    if (realStorage) Object.defineProperty(nav, 'storage', realStorage);
    else delete nav.storage;
    if (realUA) Object.defineProperty(nav, 'userAgent', realUA);
  };

  test('asks once, after the first successful save, and never from a guest tab', async () => {
    // A fresh module instance, because the request is made once per page load.
    const fresh = await import(`../src/client/store.ts?persist=${Math.random()}`);
    calls.n = 0;
    set({ persist: async () => (calls.n++, true) }, 'Mozilla/5.0 Chrome/130');
    try {
      fresh.setSaveGuest(true);
      fresh.writeSaveResult(newGame(1));
      expect(calls.n).toBe(0);
      fresh.setSaveGuest(false);
      mem.quota = 10; // a failed save is not a reason to ask
      fresh.writeSaveResult(newGame(1));
      expect(calls.n).toBe(0);
      mem.quota = Infinity;
      fresh.writeSaveResult(newGame(1));
      fresh.writeSaveResult(newGame(2));
      expect(calls.n).toBe(1);
    } finally {
      restore();
    }
  });

  test('is skipped on Firefox (it would prompt) and where the API is missing or throws', async () => {
    for (const [storage, ua] of [
      [{ persist: async () => (calls.n++, true) }, 'Mozilla/5.0 Gecko/20100101 Firefox/130.0'],
      [undefined, 'Chrome'],
      [{ persist: () => { throw new Error('nope'); } }, 'Chrome'],
      [{ persist: () => Promise.reject(new Error('denied')) }, 'Chrome'],
    ] as const) {
      const fresh = await import(`../src/client/store.ts?persist=${Math.random()}`);
      calls.n = 0;
      set(storage, ua);
      try {
        expect(fresh.writeSaveResult(newGame(3))).toBe('ok'); // never breaks saving
        expect(calls.n).toBe(0);
      } finally {
        restore();
      }
    }
  });
});

describe('backup export and import', () => {
  test('file round trip keeps the whole club', async () => {
    const s = newGame(7);
    s.xp = 1500;
    const r = await backup.parseBackup(backup.backupJson(s, new Date('2026-10-24T12:00:00Z')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save).toEqual(JSON.parse(JSON.stringify(s)));
    expect(r.preview.name).toBe(s.club.name);
    expect(r.preview.level).toBeGreaterThan(1);
    expect(r.preview.exportedAt).toBe('2026-10-24T12:00:00.000Z');
  });

  test('code round trip, and the code is one short line of URL-safe text', async () => {
    const s = newGame(8);
    const code = await backup.backupCode(s);
    expect(code.startsWith('DD1.')).toBe(true);
    expect(code).toMatch(/^DD1\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(JSON.stringify(s).length / 2);
    const r = await backup.parseBackup(`  ${code}\n`);
    expect(r.ok && r.preview.name).toBe(s.club.name);
  });

  test('a bare save file (no wrapper) imports too', async () => {
    const s = newGame(9);
    const r = await backup.parseBackup(JSON.stringify(s));
    expect(r.ok).toBe(true);
  });

  test('rejects nonsense, damaged codes, other versions and absurd values with a reason', async () => {
    const s = newGame(10);
    const bad: string[] = [
      '',
      'hello',
      '{"a":1}',
      'DD1.not-a-real-code',
      JSON.stringify({ ...s, version: 999 }),
      JSON.stringify({ ...s, squad: [] }),
      JSON.stringify({ ...s, club: { ...s.club, name: 'x'.repeat(500) } }),
      JSON.stringify({ ...s, budget: 'rich' }),
    ];
    for (const text of bad) {
      const r = await backup.parseBackup(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
    }
    const code = await backup.backupCode(s);
    expect((await backup.parseBackup(code.slice(0, code.length - 40))).ok).toBe(false); // truncated paste
  });

  test('file names are safe and dated', () => {
    const s = newGame(11);
    s.club.name = `Rovers / "Utd" <3`;
    expect(backup.backupFilename(s, new Date('2026-10-24T08:00:00Z'))).toBe('derby-day-rovers-utd-3-2026-10-24.json');
  });

  test('replaceSave puts the import in place and keeps the old club under its own key, which later saves do not overwrite', () => {
    const old = newGame(1);
    const incoming = newGame(2);
    store.writeSaveResult(old);
    expect(store.replaceSave(incoming)).toBe('ok');
    expect(store.loadSave()!.club.name).toBe(incoming.club.name);
    incoming.budget += 1;
    store.writeSaveResult(incoming);
    store.writeSaveResult({ ...incoming, budget: incoming.budget + 1 });
    expect(JSON.parse(mem.getItem(`${KEY}.pre-import`)!).club.name).toBe(old.club.name);
  });
});

describe('a restore that the browser did not keep', () => {
  test('replaceSave reports a mismatch when the key reads back as something else, so the page does not reload into the old club', () => {
    const old = newGame(1);
    store.writeSaveResult(old);
    const set = mem.setItem.bind(mem);
    // A storage that accepts the write and then reads back the old value (the write was dropped).
    mem.setItem = (k: string, v: string) => (k === KEY ? undefined : set(k, v));
    try {
      expect(store.replaceSave(newGame(2))).toBe('mismatch');
      expect(store.lastWriteFailed()).toBe(true);
    } finally {
      mem.setItem = set;
    }
    expect(store.loadSave()!.club.name).toBe(old.club.name); // nothing was changed
  });

  test('a safety copy that does not read back is a mismatch too', () => {
    store.writeSaveResult(newGame(1));
    const set = mem.setItem.bind(mem);
    mem.setItem = (k: string, v: string) => (k === `${KEY}.pre-import` ? undefined : set(k, v));
    try {
      expect(store.replaceSave(newGame(2))).toBe('mismatch');
    } finally {
      mem.setItem = set;
    }
  });
});

describe('damaged backups are refused before they can brick the club', () => {
  const good = () => JSON.parse(JSON.stringify(newGame(21)));
  const mutations: [string, (s: any) => void][] = [
    ['squad entry with no fields', (s) => (s.squad[0] = { foo: 1 })],
    ['player with no attrs', (s) => delete s.squad[3].attrs],
    ['player attr out of range', (s) => (s.squad[2].attrs.pace = 1e9)],
    ['player attr missing goalkeeping', (s) => delete s.squad[2].attrs.goalkeeping],
    ['unknown role', (s) => (s.squad[1].role = 'WIZ')],
    ['colours null', (s) => (s.club.primary = null)],
    ['colour not a colour', (s) => (s.club.secondary = 'red')],
    ['ladder of numbers', (s) => (s.ladder = [1, 2])],
    ['ladder club without colours', (s) => delete s.ladder[0].primary],
    ['lineup ids not in the squad', (s) => (s.lineup = ['nope'])],
    ['lineup longer than a team', (s) => (s.lineup = s.squad.map((p: any) => p.id).slice(0, 14))],
    ['elo 1e308', (s) => (s.club.elo = 1e308)],
    ['budget 1e308', (s) => (s.budget = 1e308)],
    ['negative games played', (s) => (s.club.played = -4)],
    ['huge history', (s) => (s.history = new Array(30000).fill({}))],
    ['rng not a number', (s) => (s.rng = { s: 'x' })],
    ['hostile colour (markup injection)', (s) => (s.club.primary = '#f00"/><img src=x onerror=alert(1)>')],
    ['hostile ladder colour', (s) => (s.ladder[2].secondary = '#00f"onload="alert(1)')],
    ['hostile short code', (s) => (s.club.short = '<svg onload=alert(1)>')],
    ['hostile short code on a ladder club', (s) => (s.ladder[0].short = 'A</text><script>')],
    ['hostile club name', (s) => (s.club.name = 'Rovers<img src=x onerror=alert(1)>')],
    ['hostile player id', (s) => (s.squad[0].id = 'a" data-x="y')],
    ['hostile news line', (s) => s.news.push('<script>alert(1)</script>')],
    ['markup hidden deep in an optional field', (s) => (s.cup = { kind: 'cup', note: { a: ['"><b>'] } })],
    ['squad ids repeat', (s) => (s.squad[1].id = s.squad[0].id)],
    ['a forfeit debt that would halve XP forever', (s) => (s.xpOwed = 1e15)],
    ['a negative forfeit debt', (s) => (s.xpOwed = -500)],
    ['a money debt out of range', (s) => (s.moneyOwed = 1e13)],
    ['a voided-match marker from the future, blocking voids for good', (s) => (s.voidAt = 1e9)],
  ];
  for (const [name, mutate] of mutations) {
    test(name, async () => {
      const s = good();
      mutate(s);
      const r = await backup.parseBackup(JSON.stringify(s));
      expect(r.ok).toBe(false);
    });
  }

  test('a hostile backup shared as a code is refused too, with a reason and nothing imported', async () => {
    const s = good();
    s.club.primary = '#f00"/><img src=x onerror=alert(1)>';
    const code = await backup.backupCode(s);
    const r = await backup.parseBackup(code);
    expect(r.ok).toBe(false);
  });

  test('a healthy club passes both the field check and the boot dry run, and the dry run does not touch it', async () => {
    const s = good();
    const r = await backup.parseBackup(JSON.stringify(s));
    expect(r.ok).toBe(true);
    const before = JSON.stringify(s);
    expect(dry.dryRunBoot(s)).toBeNull();
    expect(JSON.stringify(s)).toBe(before);
  });

  test('the dry run catches a club the field check lets through but the game cannot open', () => {
    const s = good();
    s.ladder[0].quality = 'high'; // a shape isSave() does not look at
    s.squad[0].attrs = null; // what "Cannot read goalkeeping" looked like
    expect(dry.dryRunBoot(s)).not.toBeNull();
  });
});

describe('crash details', () => {
  test('hold the message, stack and build, and no save data', () => {
    mem.setItem(KEY, JSON.stringify(newGame(5)));
    const d = errors.describe(new Error('boom'), 'error', new Date('2026-10-24T00:00:00Z'));
    const text = errors.detailsText(d);
    expect(text).toContain('boom');
    expect(text).toContain('build:');
    expect(text).toContain('2026-10-24');
    expect(text).not.toContain(newGame(5).club.name);
  });

  test('strings, non-errors and null are described without throwing', () => {
    expect(errors.describe('plain', 'rejection').message).toBe('plain');
    expect(errors.describe(null, 'rejection').message.length).toBeGreaterThan(0);
    expect(errors.describe({ message: 'm', stack: 'a\nb' }, 'error').stack).toBe('a\nb');
    expect(errors.describe(new Error('x'.repeat(5000)), 'error').message.length).toBeLessThanOrEqual(400);
  });

  test('browser noise is benign, real exceptions are not', () => {
    for (const m of ['ResizeObserver loop completed with undelivered notifications.', 'Script error.', 'The play() request was interrupted by a call to pause()']) {
      expect(errors.isBenign({ message: m })).toBe(true);
    }
    expect(errors.isBenign({ message: "Cannot read properties of undefined (reading 'x')" })).toBe(false);
  });

  test('reporting is off without a URL, rate limited to 3, and never repeats a message', () => {
    const sent: string[] = [];
    const send = (_u: string, body: string) => (sent.push(body), true);
    const d = (m: string) => errors.describe(new Error(m), 'error');
    expect(errors.report(d('off'), '', send)).toBe(false);
    expect(errors.report(d('a'), 'https://x.test/e', send)).toBe(true);
    expect(errors.report(d('a'), 'https://x.test/e', send)).toBe(false);
    expect(errors.report(d('b'), 'https://x.test/e', send)).toBe(true);
    expect(errors.report(d('c'), 'https://x.test/e', send)).toBe(true);
    expect(errors.report(d('d'), 'https://x.test/e', send)).toBe(false);
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[0]).message).toBe('a');
  });
});

describe('telemetry', () => {
  function make(over: Partial<import('../src/client/telemetry.ts').TelemetryDeps> = {}) {
    const store = new MemStorage();
    const sent: { url: string; body: { v: number; iid: string; events: { name: string; t: number; [k: string]: unknown }[] } }[] = [];
    let now = 1_000_000;
    let n = 0;
    const t = tele.createTelemetry({
      url: 'https://t.test/e',
      dnt: false,
      gpc: false,
      store,
      send: (url, body) => (sent.push({ url, body: JSON.parse(body) }), true),
      now: () => now,
      random: () => `iid-${++n}`,
      ...over,
    });
    return { t, store, sent, advance: (ms: number) => (now += ms) };
  }
  const names = (s: ReturnType<typeof make>) => s.sent.flatMap((x) => x.body.events.map((e) => e.name));

  test('is off with no endpoint: nothing queued, nothing sent, nothing stored', () => {
    const s = make({ url: '' });
    s.t.track({ name: 'app_open' });
    s.t.flush();
    expect(s.t.enabled).toBe(false);
    expect(s.sent).toHaveLength(0);
    expect(s.store.length).toBe(0);
  });

  test('respects Do Not Track and Global Privacy Control', () => {
    for (const over of [{ dnt: true }, { gpc: true }]) {
      const s = make(over);
      s.t.track({ name: 'app_open' });
      s.t.flush();
      expect(s.sent).toHaveLength(0);
      expect(s.store.length).toBe(0);
    }
  });

  test('a guest tab counts nothing', () => {
    let guest = true;
    const s = make({ suspended: () => guest });
    s.t.track({ name: 'app_open' });
    s.t.track({ name: 'match_start', kind: 'Ranked', controls: 'mouse' });
    s.t.flush();
    expect(s.sent).toHaveLength(0);
    expect(s.store.length).toBe(0); // no install id, no seen-state
    guest = false;
    s.t.track({ name: 'app_open' });
    s.t.flush();
    expect(names(s)).toEqual(['app_open']);
  });

  test('the player can opt out, and opting out drops what is queued', () => {
    const s = make();
    s.t.track({ name: 'app_open' });
    s.t.setOptOut(true);
    s.t.flush();
    s.t.track({ name: 'match_start', kind: 'Ranked', controls: 'mouse' });
    s.t.flush();
    expect(s.sent).toHaveLength(0);
    expect(s.t.optedOut()).toBe(true);
    s.t.setOptOut(false);
    s.t.track({ name: 'app_open' });
    s.t.flush();
    expect(names(s)).toEqual(['app_open']);
  });

  test('events are batched into one beacon with a stable random install id and nothing else identifying', () => {
    const s = make();
    s.t.track({ name: 'app_open' });
    s.t.track({ name: 'match_start', kind: 'Ranked', controls: 'keys' });
    s.t.track({ name: 'match_end', kind: 'Ranked', score: [2, 1], forfeit: false });
    expect(s.sent).toHaveLength(0);
    s.t.flush();
    s.t.track({ name: 'app_open' });
    s.t.flush();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[0].url).toBe('https://t.test/e');
    expect(s.sent[0].body.iid).toBe('iid-1');
    expect(s.sent[1].body.iid).toBe('iid-1');
    expect(Object.keys(s.sent[0].body).sort()).toEqual(['events', 'iid', 'v']);
    expect(names(s).slice(0, 5)).toEqual(['app_open', 'first_match_start', 'match_start', 'control_mode', 'match_end']);
    const end = s.sent[0].body.events.find((e) => e.name === 'match_end')!;
    expect(end.score).toEqual([2, 1]);
    expect(end.forfeit).toBe(false);
  });

  test('first_match_start fires once; second_session fires once, on the first visit after a 30 minute gap', () => {
    const s = make();
    s.t.track({ name: 'app_open' });
    s.t.track({ name: 'match_start', kind: 'Ranked', controls: 'mouse' });
    s.advance(5 * 60_000);
    s.t.track({ name: 'app_open' }); // same session (reload)
    s.advance(40 * 60_000);
    s.t.track({ name: 'app_open' }); // second session
    s.t.track({ name: 'match_start', kind: 'Ranked', controls: 'mouse' });
    s.advance(24 * 3600_000);
    s.t.track({ name: 'app_open' }); // third session
    s.t.flush();
    const n = names(s);
    expect(n.filter((x) => x === 'first_match_start')).toHaveLength(1);
    expect(n.filter((x) => x === 'second_session')).toHaveLength(1);
    expect(n.filter((x) => x === 'app_open')).toHaveLength(4);
  });

  test('level_up fires on a rise only, not on the first reading', () => {
    const s = make();
    s.t.level(3);
    s.t.level(3);
    s.t.level(4);
    s.t.level(4);
    s.t.flush();
    const ups = s.sent[0].body.events.filter((e) => e.name === 'level_up');
    expect(ups).toHaveLength(1);
    expect(ups[0].level).toBe(4);
  });

  test('a failed send keeps the events for the next flush; the queue is capped at 100', () => {
    let ok = false;
    const bodies: { events: unknown[] }[] = [];
    const s = make({ send: (_u, b) => (bodies.push(JSON.parse(b)), ok) });
    s.t.track({ name: 'app_open' });
    s.t.flush(); // fails
    ok = true;
    s.t.flush(); // retried
    expect(bodies.map((b) => b.events.length)).toEqual([1, 1]);
    s.t.flush(); // nothing left
    expect(bodies).toHaveLength(2);
    ok = false;
    for (let i = 0; i < 250; i++) s.t.track({ name: 'level_up', level: i });
    ok = true;
    s.t.flush();
    expect(bodies).toHaveLength(2 + 1 + 1); // one failed batch-size attempt, then the explicit flush
    expect(bodies[3].events.length).toBe(100);
  });

  test('the shared instance is a harmless no-op when no endpoint was built in', () => {
    expect(tele.telemetry.enabled).toBe(false);
    tele.telemetry.track({ name: 'app_open' });
    tele.telemetry.level(5);
    tele.telemetry.flush();
  });
});
