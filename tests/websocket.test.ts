// The WebSocket transport against the real relay core, over a fake network with
// a fake clock: pairing, a lockstep match surviving a dropped socket, refusals,
// and giving up. The last block runs the same thing over real sockets against
// the Bun adapter (server/bun.ts) on a free local port.

import { afterAll, describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { RelayCore, type RelayLimits, type RelaySocket } from '../server/relay-core.ts';
import { clientIp, startRelay } from '../server/bun.ts';
import { Lockstep, syncHash, type LockstepMsg } from '../src/net/lockstep.ts';
import { botInput } from '../src/net/memory.ts';
import { ABANDON_MS, PeerWatch } from '../src/net/presence.ts';
import { netVersion, WebSocketTransport, type LinkEvent, type SocketLike, type Timers } from '../src/net/websocket.ts';
import { createMatch, fingerprint } from '../src/sim/match.ts';
import { makeRng, next } from '../src/sim/rng.ts';
import type { HumanInput } from '../src/sim/types.ts';

/** Seeded 0..1 randoms, so backoff jitter and room codes are the same on every run. */
let seedCounter = 0;
function seeded(): () => number {
  const r = makeRng(1000 + seedCounter++);
  return () => next(r);
}

/** Fake clock and timer queue. */
class Sched implements Timers {
  t = 0;
  private q: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    this.q.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    const i = this.q.indexOf(h as never);
    if (i >= 0) this.q.splice(i, 1);
  };
  /** Run everything due up to now + ms, in time order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let k = -1;
      for (let i = 0; i < this.q.length; i++) if (this.q[i].at <= end && (k < 0 || this.q[i].at < this.q[k].at || (this.q[i].at === this.q[k].at && this.q[i].seq < this.q[k].seq))) k = i;
      if (k < 0) break;
      const [h] = this.q.splice(k, 1);
      this.t = Math.max(this.t, h.at);
      h.fn();
    }
    this.t = end;
  }
}

/** A relay core reached through fake sockets with a fixed one-way latency. `down` makes new connections fail. */
function fakeRelay(sched: Sched, latency = 20, limits: Partial<RelayLimits> = {}) {
  let tokens = 0;
  const core = new RelayCore({ now: sched.now, random: seeded(), token: () => `t${++tokens}`, limits });
  const net = { down: false, sockets: [] as SocketLike[] };
  const connect = (_url: string): SocketLike => {
    let serverOpen = true;
    const client: SocketLike & { readyState: number } = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(d: string) {
        if (client.readyState !== 1) throw new Error('not open');
        sched.setTimeout(() => serverOpen && core.message(server, d), latency);
      },
      close(code = 1000, reason = '') {
        if (client.readyState >= 2) return;
        client.readyState = 3;
        sched.setTimeout(() => {
          serverOpen = false;
          core.close(server);
        }, latency);
        sched.setTimeout(() => client.onclose?.({ code, reason }), 1);
      },
    };
    const server: RelaySocket = {
      send: (t) => sched.setTimeout(() => client.readyState === 1 && client.onmessage?.({ data: t }), latency),
      close: (code, reason) => {
        if (!serverOpen) return;
        serverOpen = false;
        sched.setTimeout(() => {
          core.close(server);
          if (client.readyState >= 2) return;
          client.readyState = 3;
          client.onclose?.({ code, reason });
        }, latency);
      },
    };
    net.sockets.push(client);
    sched.setTimeout(() => {
      if (net.down) {
        client.readyState = 3;
        client.onclose?.({ code: 1006, reason: '' });
        return;
      }
      core.open(server, '');
      client.readyState = 1;
      client.onopen?.({});
    }, latency);
    return client;
  };
  return { core, net, connect };
}

const V = netVersion(2, 3);

function setup(seed = 11) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

function linkPair(sched: Sched, relay: ReturnType<typeof fakeRelay>) {
  const events: LinkEvent[][] = [[], []];
  const host = new WebSocketTransport<LockstepMsg>({ url: 'ws://relay', version: V, role: { host: true }, connect: relay.connect, timers: sched, random: seeded() });
  host.onEvent((e) => events[0].push(e));
  sched.advance(100);
  expect(host.status).toBe('open');
  expect(host.code).toMatch(/^[A-Z0-9]{6}$/);
  const guest = new WebSocketTransport<LockstepMsg>({ url: 'ws://relay', version: V, role: { join: host.code! }, connect: relay.connect, timers: sched, random: seeded() });
  guest.onEvent((e) => events[1].push(e));
  sched.advance(100);
  return { host, guest, events };
}

/** Tick both peers at 60 Hz on the fake clock until both reach `until` or `maxMs` passes. */
function drive(sched: Sched, peers: [Lockstep, Lockstep], until: number, maxMs: number, each?: (ms: number) => void) {
  const samplers: [() => HumanInput, () => HumanInput] = [botInput(1), botInput(2)];
  const acc = [0, 0];
  for (let ms = 0; ms < maxMs && (peers[0].s.tick < until || peers[1].s.tick < until); ms++) {
    sched.advance(1);
    each?.(ms);
    for (const i of [0, 1] as const) {
      if (peers[i].s.tick >= until) continue;
      acc[i] += 1;
      while (acc[i] >= 1000 / 60) {
        if (peers[i].tick(samplers[i])) acc[i] -= 1000 / 60;
        else {
          acc[i] = Math.min(acc[i], 1000 / 60);
          break;
        }
      }
    }
  }
}

describe('websocket transport over the relay core', () => {
  test('host and guest pair, then a lockstep match stays in sync through a dropped socket', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched, 25);
    const { host, guest, events } = linkPair(sched, relay);
    expect(guest.status).toBe('open');
    expect(guest.seat).toBe(1);
    expect(events[0]).toContainEqual({ type: 'peer', s: 'joined' });

    const teams = setup();
    const mk = () => createMatch({ seed: 9, ...structuredClone(teams), halfSeconds: 20, humans: [true, true] });
    const peers: [Lockstep, Lockstep] = [
      new Lockstep({ state: mk(), side: 0, transport: host, delay: 4, now: sched.now }),
      new Lockstep({ state: mk(), side: 1, transport: guest, delay: 4, now: sched.now }),
    ];
    drive(sched, peers, 600, 30_000);
    expect(peers[0].s.tick).toBe(600);

    // The guest's socket dies. Both sides stall; the host hears "away"; the guest reconnects and resumes.
    guest.drop();
    const statuses: string[] = [];
    guest.onEvent((e) => e.type === 'status' && statuses.push(e.status));
    drive(sched, peers, 2400, 60_000);
    expect(statuses).toEqual(['reconnecting', 'open']);
    expect(guest.resumes).toBe(1);
    expect(events[0].filter((e) => e.type === 'peer').map((e) => (e as { s: string }).s)).toEqual(['joined', 'away', 'back']);
    expect(peers[0].s.tick).toBe(2400);
    expect(peers[1].s.tick).toBe(2400);
    sched.advance(500);
    expect(peers[0].desync).toBeNull();
    expect(peers[1].desync).toBeNull();
    expect(peers[0].checksPassed).toBeGreaterThan(30);
    expect(fingerprint(peers[0].s)).toBe(fingerprint(peers[1].s));
    expect(syncHash(peers[0].s)).toBe(syncHash(peers[1].s));
  });

  test('the presence watch shows a countdown while the peer is gone and clears when it is back', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched, 25);
    const { host, guest } = linkPair(sched, relay);
    const teams = setup();
    const mk = () => createMatch({ seed: 4, ...structuredClone(teams), halfSeconds: 20, humans: [true, true] });
    const peers: [Lockstep, Lockstep] = [
      new Lockstep({ state: mk(), side: 0, transport: host, delay: 4, now: sched.now }),
      new Lockstep({ state: mk(), side: 1, transport: guest, delay: 4, now: sched.now }),
    ];
    drive(sched, peers, 300, 20_000);
    const watch = new PeerWatch();
    const seen: string[] = [];
    relay.net.down = true; // the guest's reconnects fail for a while
    guest.drop();
    let minRemaining = Infinity;
    drive(sched, peers, 1200, 60_000, (ms) => {
      if (ms === 6000) relay.net.down = false;
      const p = watch.update({ now: sched.t, stalled: peers[0].stalled, lastHeardAt: peers[0].lastHeardAt, away: host.peer === 'away' });
      if (seen[seen.length - 1] !== p.state) seen.push(p.state);
      if (p.state === 'lost') minRemaining = Math.min(minRemaining, p.remainingMs);
    });
    expect(seen).toEqual(['ok', 'lost', 'ok']);
    // Lost for at least the 6 s outage, and at most the outage plus one full backoff step
    // (4 s, +25% jitter) plus a little latency: the reconnect that lands after the relay is back.
    expect(minRemaining).toBeLessThan(ABANDON_MS - 6000);
    expect(minRemaining).toBeGreaterThan(ABANDON_MS - 6000 - 5000 - 1000);
    expect(peers[0].s.tick).toBe(1200);
  });

  test('a peer that never comes back: the relay says "left" and the watch abandons at 20 s', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched, 25, { graceMs: 30_000 });
    const { host, guest, events } = linkPair(sched, relay);
    const teams = setup();
    const ls = new Lockstep({ state: createMatch({ seed: 4, ...structuredClone(teams), humans: [true, true] }), side: 0, transport: host, delay: 4, now: sched.now });
    relay.net.down = true;
    guest.drop();
    const watch = new PeerWatch();
    let abandonedAt = -1;
    for (let ms = 0; ms < 40_000; ms += 10) {
      sched.advance(10);
      if (ms % 1000 === 0) relay.core.sweep();
      ls.tick(() => ({}));
      const p = watch.update({ now: sched.t, stalled: ls.stalled, lastHeardAt: ls.lastHeardAt, away: host.peer === 'away' });
      if (p.state === 'abandoned' && abandonedAt < 0) abandonedAt = ms;
    }
    expect(abandonedAt).toBeGreaterThan(ABANDON_MS - 100);
    expect(abandonedAt).toBeLessThan(ABANDON_MS + 500);
    // The guest gave up reconnecting (25 s), and the relay told the host after its 30 s grace.
    expect(guest.status).toBe('closed');
    expect(guest.error?.code).toBe('network');
    expect(events[0].filter((e) => e.type === 'peer').map((e) => (e as { s: string }).s)).toEqual(['joined', 'away', 'left']);
  });

  test('version mismatch, a full room and a bad code end the link with a reason, without retrying', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched);
    const { host } = linkPair(sched, relay);
    const lonely = new WebSocketTransport({ url: 'ws://relay', version: V, role: { host: true }, connect: relay.connect, timers: sched, random: seeded() });
    sched.advance(100);
    const old = new WebSocketTransport({ url: 'ws://relay', version: netVersion(1, 3), role: { join: lonely.code! }, connect: relay.connect, timers: sched, random: seeded() });
    const third = new WebSocketTransport({ url: 'ws://relay', version: V, role: { join: host.code! }, connect: relay.connect, timers: sched, random: seeded() });
    const nobody = new WebSocketTransport({ url: 'ws://relay', version: V, role: { join: 'QQQQQQ' }, connect: relay.connect, timers: sched, random: seeded() });
    const before = relay.net.sockets.length;
    sched.advance(10_000);
    expect([old.status, third.status, nobody.status]).toEqual(['closed', 'closed', 'closed']);
    expect(old.error).toMatchObject({ code: 'version', msg: expect.stringMatching(/different version/) });
    expect(third.error?.code).toBe('full');
    expect(nobody.error?.code).toBe('no-room');
    expect(relay.net.sockets.length).toBe(before); // nobody redialled
  });

  test('an unreachable relay gives up after the first-connect window', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched);
    relay.net.down = true;
    const tr = new WebSocketTransport({ url: 'ws://relay', version: V, role: { host: true }, connect: relay.connect, timers: sched, random: seeded() });
    const seen: string[] = [];
    tr.onEvent((e) => e.type === 'status' && seen.push(e.status));
    sched.advance(7000);
    expect(tr.status).toBe('connecting');
    sched.advance(3000);
    expect(tr.status).toBe('closed');
    expect(tr.error?.msg).toMatch(/Could not reach/);
    expect(seen).toEqual(['closed']);
    // Backoff: 250 ms doubling to 4 s with jitter, so a handful of attempts, not hundreds.
    expect(relay.net.sockets.length).toBeGreaterThan(3);
    expect(relay.net.sockets.length).toBeLessThan(10);
  });

  test('close() leaves the room: the peer hears "left" at once and nothing reconnects', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched);
    const { host, guest, events } = linkPair(sched, relay);
    guest.close();
    sched.advance(200);
    expect(events[0]).toContainEqual({ type: 'peer', s: 'left', why: 'left' });
    expect(guest.status).toBe('closed');
    expect(guest.error).toBeNull();
    host.close();
    sched.advance(200);
    expect(relay.core.stats()).toMatchObject({ rooms: 0, sockets: 0 });
  });

  test('reconnectNow skips the backoff, or replaces a socket that still looks open, and keeps the seat', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched, 20);
    const { host, guest, events } = linkPair(sched, relay);
    const before = relay.net.sockets.length;
    guest.reconnectNow(); // socket open: replaced at once
    sched.advance(200);
    expect(guest.status).toBe('open');
    expect(guest.resumes).toBe(1);
    expect(relay.net.sockets.length).toBe(before + 1);
    relay.net.down = true;
    guest.drop();
    sched.advance(1500); // a few failed dials, now waiting on a backoff timer
    relay.net.down = false;
    const dials = relay.net.sockets.length;
    guest.reconnectNow();
    sched.advance(100); // well inside any backoff step
    expect(relay.net.sockets.length).toBe(dials + 1);
    expect(guest.status).toBe('open');
    expect(guest.resumes).toBe(2);
    expect(host.peer).toBe('here');
    expect(events[0].filter((e) => e.type === 'peer' && e.s === 'left')).toEqual([]);
  });

  test('heartbeats keep an idle lobby open past the relay heartbeat timeout', () => {
    const sched = new Sched();
    const relay = fakeRelay(sched, 20, { heartbeatMs: 12_000 });
    const tr = new WebSocketTransport({ url: 'ws://relay', version: V, role: { host: true }, connect: relay.connect, timers: sched, random: seeded() });
    for (let i = 0; i < 60; i++) {
      sched.advance(1000);
      relay.core.sweep();
    }
    expect(tr.status).toBe('open');
    expect(relay.net.sockets.length).toBe(1);
  });
});

describe('Bun relay over real sockets', () => {
  // These tests run lockstep as fast as the machine allows, about ten times real time, so the
  // per-socket rate limit (150 messages/s, sized for 60 ticks/s of play) is raised here. With the
  // production limits the relay correctly closes such a socket after its 300-message burst, which
  // used to make this test pass or stall depending on how fast the machine was.
  const relay = startRelay({ port: 0, host: '127.0.0.1', quiet: true, limits: { ratePerSec: 100_000, burst: 100_000, bytesPerSec: 1e9, byteBurst: 1e9 } });
  afterAll(() => relay.stop());
  const url = `ws://127.0.0.1:${relay.port}/ws`;
  const until = async (ok: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out');
      await Bun.sleep(5);
    }
  };

  test('GET /health answers with stats', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocol: 1, rooms: expect.any(Number) });
  });

  test('two clients pair, play 300 lockstep ticks, survive a drop, and agree', async () => {
    const host = new WebSocketTransport<LockstepMsg>({ url, version: V, role: { host: true } });
    await until(() => host.status === 'open');
    const guest = new WebSocketTransport<LockstepMsg>({ url, version: V, role: { join: host.code! } });
    await until(() => guest.status === 'open' && host.peer === 'here');
    const teams = setup();
    const mk = () => createMatch({ seed: 21, ...structuredClone(teams), halfSeconds: 20, humans: [true, true] });
    const peers = [
      new Lockstep({ state: mk(), side: 0, transport: host, delay: 4, now: () => performance.now() }),
      new Lockstep({ state: mk(), side: 1, transport: guest, delay: 4, now: () => performance.now() }),
    ];
    const samplers = [botInput(5), botInput(6)];
    const run = async (to: number) => {
      const end = Date.now() + 10_000;
      while ((peers[0].s.tick < to || peers[1].s.tick < to) && Date.now() < end) {
        for (const i of [0, 1]) for (let k = 0; k < 4 && peers[i].s.tick < to; k++) if (!peers[i].tick(samplers[i])) break;
        await Bun.sleep(1);
      }
    };
    await run(150);
    guest.drop();
    await run(300);
    await Bun.sleep(100);
    expect(host.error).toBeNull();
    expect(guest.error).toBeNull();
    expect(guest.resumes).toBe(1);
    expect(peers[0].s.tick).toBe(300);
    expect(peers[1].s.tick).toBe(300);
    expect(peers[0].desync).toBeNull();
    expect(syncHash(peers[0].s)).toBe(syncHash(peers[1].s));
    host.close();
    guest.close();
    await until(() => relay.core.stats().sockets === 0);
    // Under a second on a laptop; the bound leaves room for a busy CI runner (the run loops give up at 10 s each).
  }, 25_000);

  test('origin allow-list refuses other origins', async () => {
    const strict = startRelay({ port: 0, host: '127.0.0.1', quiet: true, allowedOrigins: ['https://derby.natwong.dev'] });
    try {
      const bad = await fetch(`http://127.0.0.1:${strict.port}/ws`, { headers: { upgrade: 'websocket', connection: 'upgrade', origin: 'https://evil.example', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
      expect(bad.status).toBe(403);
      const good = new WebSocketTransport({ url: `ws://127.0.0.1:${strict.port}/ws`, version: V, role: { host: true }, connect: (u) => new WebSocket(u, { headers: { origin: 'https://derby.natwong.dev' } } as never) as never });
      await until(() => good.status === 'open');
      good.close();
    } finally {
      strict.stop();
    }
  });
});

describe('client address behind proxies', () => {
  const h = (xff: string, fly?: string) => new Headers({ 'x-forwarded-for': xff, ...(fly ? { 'fly-client-ip': fly } : {}) });
  test('no trusted proxy: the socket address, whatever the headers say', () => {
    expect(clientIp(h('1.1.1.1'), '9.9.9.9', {})).toBe('9.9.9.9');
  });
  test('one trusted proxy: the rightmost entry, so a forged left part changes nothing', () => {
    expect(clientIp(h('6.6.6.6, 2.2.2.2'), '10.0.0.1', { trustProxy: true })).toBe('2.2.2.2');
    expect(clientIp(h('2.2.2.2'), '10.0.0.1', { trustProxy: true })).toBe('2.2.2.2');
    expect(clientIp(h('a, b, c, 2.2.2.2'), '10.0.0.1', { trustProxy: true, proxyHops: 1 })).toBe('2.2.2.2');
  });
  test('two hops count two from the right; a short chain falls back to the socket', () => {
    expect(clientIp(h('6.6.6.6, 2.2.2.2, 10.0.0.5'), '10.0.0.1', { trustProxy: true, proxyHops: 2 })).toBe('2.2.2.2');
    expect(clientIp(h('2.2.2.2'), '10.0.0.1', { trustProxy: true, proxyHops: 2 })).toBe('10.0.0.1');
  });
  test('Fly: Fly-Client-IP', () => {
    expect(clientIp(h('6.6.6.6', '3.3.3.3'), '10.0.0.1', { trustProxy: true, fly: true })).toBe('3.3.3.3');
  });
});
