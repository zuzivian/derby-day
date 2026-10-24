// Peer input is untrusted: hostile team setups, start messages and lockstep messages.
import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { newGame, clubTeam } from '../src/meta/game.ts';
import { Lockstep, type LockstepMsg } from '../src/net/lockstep.ts';
import { botInput, drivePair, MemoryNetwork } from '../src/net/memory.ts';
import { cleanInput, cleanLockstepMsg, cleanStart, cleanTeam } from '../src/net/validate.ts';
import { Listeners, type Transport } from '../src/net/transport.ts';
import { makeRng, next } from '../src/sim/rng.ts';
import { createMatch, fingerprint } from '../src/sim/match.ts';

function teams(seed = 11) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

describe('team and start validation', () => {
  test('real teams pass unchanged: ladder clubs and a new save club', () => {
    for (let seed = 1; seed < 30; seed++) {
      const { home, away } = teams(seed);
      expect(cleanTeam(home)).toEqual({ ...home, formation: home.formation ?? '4-4-2' });
      expect(cleanTeam(away)).toEqual({ ...away, formation: away.formation ?? '4-4-2' });
      const mine = clubTeam(newGame(seed), 0.6);
      expect(cleanTeam(mine)).toEqual({ ...mine, formation: mine.formation ?? '4-4-2' });
    }
  });

  test('markup in colours, names or codes never survives', () => {
    const { home } = teams();
    const evil = '#f00"/><img src=x onerror=alert(document.cookie)>';
    expect(cleanTeam({ ...home, primary: evil })).toBeNull();
    expect(cleanTeam({ ...home, secondary: 'red' })).toBeNull();
    expect(cleanTeam({ ...home, short: '<b>' })).toBeNull();
    const named = cleanTeam({ ...home, name: '<script>alert(1)</script>FC', players: home.players.map((p, i) => (i ? p : { ...p, name: '"><svg onload=alert(1)>' })) })!;
    expect(named.name).not.toMatch(/[<>"']/);
    expect(named.players[0].name).not.toMatch(/[<>"']/);
  });

  test('wrong shapes are refused: player count, attributes, roles, duplicates, junk', () => {
    const { home } = teams();
    const bad = [
      null, 42, 'team', [], { ...home, players: null }, { ...home, players: home.players.slice(1) },
      { ...home, players: [...home.players, home.players[0]] },
      { ...home, players: home.players.map((p, i) => (i ? p : { ...p, attrs: { ...p.attrs, pace: 'fast' } })) },
      { ...home, players: home.players.map((p, i) => (i ? p : { ...p, attrs: { ...p.attrs, pace: NaN } })) },
      { ...home, players: home.players.map((p, i) => (i ? p : { ...p, role: 'STRIKER' })) },
      { ...home, players: home.players.map((p, i) => (i ? p : { ...p, id: home.players[1].id })) },
      { ...home, aiSkill: Infinity },
    ];
    for (const t of bad) expect(cleanTeam(t)).toBeNull();
    // Out-of-range attributes are clamped, not trusted: a doctored 50.0 pace plays as 1.0.
    const fast = cleanTeam({ ...home, players: home.players.map((p) => ({ ...p, attrs: { ...p.attrs, pace: 50 } })) })!;
    expect(fast.players.every((p) => p.attrs.pace === 1)).toBe(true);
    expect(cleanTeam({ ...home, formation: '1-1-8' })!.formation).toBe('4-4-2');
  });

  test('start messages: bounds on seed, half length and delay; crests from the list', () => {
    const { home, away } = teams();
    const ok = { seed: 5, home, away, crests: ['stripes', 'hoops'], halfSeconds: 180, delay: 4 };
    expect(cleanStart(ok)).toMatchObject({ seed: 5, crests: ['stripes', 'hoops'], halfSeconds: 180, delay: 4 });
    expect(cleanStart({ ...ok, crests: ['<x>', null] })!.crests).toEqual(['plain', 'plain']);
    for (const bad of [{ ...ok, halfSeconds: 1e9 }, { ...ok, delay: 0 }, { ...ok, delay: 1.5 }, { ...ok, seed: 'x' }, { ...ok, away: null }, null]) expect(cleanStart(bad)).toBeNull();
    // A cleaned start builds a match (createMatch would throw on players: null).
    expect(() => createMatch({ ...cleanStart(ok)!, humans: [true, true] })).not.toThrow();
  });
});

describe('lockstep message validation', () => {
  test('inputs are made finite and in range; junk fields go', () => {
    expect(cleanInput({ cursor: { x: 50, z: 30 }, loft: 'abc', shoot: Infinity, pass: 'yes', dir: { x: 9, y: -9 }, evil: 1 })).toEqual({ dir: { x: 1, y: -1 } });
    expect(cleanInput({ cursor: { x: 1e300, y: -5 }, loft: 7, sprint: true })).toEqual({ cursor: { x: 200, y: -5 }, loft: 1, sprint: true });
    expect(cleanInput(null)).toEqual({});
    expect(cleanLockstepMsg({ t: 'in', from: 1, ack: 0, inputs: null })).toBeNull();
    expect(cleanLockstepMsg({ t: 'in', from: 1, ack: 0, inputs: new Array(500).fill({}) })).toBeNull();
    expect(cleanLockstepMsg({ t: 'in', from: 1, ack: 0, inputs: [null, { pass: true }] })).toEqual({ t: 'in', from: 1, ack: 0, inputs: [{}, { pass: true }] });
    expect(cleanLockstepMsg({ t: 'nope' })).toBeNull();
    expect(cleanLockstepMsg({ t: 'fp', tick: 60, fp: 4294967295 })).toEqual({ t: 'fp', tick: 60, fp: 4294967295 });
  });

  test('fuzz: a hostile peer cannot crash, stall, poison or bloat the other side', () => {
    const { home, away } = teams();
    const s = createMatch({ seed: 3, home, away, halfSeconds: 30, humans: [true, true] });
    const ls = new Listeners<unknown>();
    const tr: Transport<LockstepMsg> = { send: () => {}, onMessage: (fn) => ls.add(fn as (m: unknown) => void), close: () => {} };
    const peer = new Lockstep({ state: s, side: 0, transport: tr, delay: 4 });
    const r = makeRng(99);
    const junk = (): unknown => {
      const k = Math.floor(next(r) * 12);
      const vals: unknown[] = [null, undefined, 0, -1, 1e6, 1e15, NaN, Infinity, 'x', [], {}, { x: 1 }];
      const v = () => vals[Math.floor(next(r) * vals.length)];
      switch (k) {
        case 0: return null;
        case 1: return { t: 'in', from: v(), ack: v(), inputs: v() };
        case 2: return { t: 'in', from: Math.floor(next(r) * 1e9), ack: 0, inputs: new Array(100).fill({ pass: true }) };
        case 3: return { t: 'in', from: s.tick + 1, ack: v(), inputs: [{ cursor: { x: v(), y: v() }, loft: v(), shoot: v(), dir: v() }, null, 'x'] };
        case 4: return { t: 'fp', tick: Math.floor(next(r) * 1e9), fp: v() };
        case 5: return { t: 'ping', n: v(), at: v() };
        case 6: return { t: v() };
        default: return { t: 'in', from: s.tick + 1, ack: s.tick, inputs: Array.from({ length: 6 }, () => ({ cursor: { x: next(r) * 105, y: next(r) * 68 }, loft: next(r) < 0.1 ? 'abc' : next(r), shoot: next(r) < 0.05 ? Infinity : undefined, pass: next(r) < 0.1 })) };
      }
    };
    for (let i = 0; i < 6000; i++) {
      expect(() => ls.emit(junk())).not.toThrow();
      peer.tick(() => ({}));
    }
    expect(s.tick).toBeGreaterThan(1000); // it kept going on the well-formed inputs
    expect(Number.isFinite(s.ball.pos.x) && Number.isFinite(s.ball.pos.y) && Number.isFinite(s.ball.z)).toBe(true);
    for (const p of s.players) expect(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)).toBe(true);
    // Nothing far in the future was stored.
    const remote = (peer as unknown as { remote: Map<number, unknown> }).remote;
    const theirFp = (peer as unknown as { theirFp: Map<number, unknown> }).theirFp;
    expect(remote.size).toBeLessThan(300);
    expect(theirFp.size).toBeLessThan(300);
  });

  test('a peer sending non-finite inputs still ends bit-identical with no NaN', () => {
    const net = new MemoryNetwork<LockstepMsg>({ seed: 4, minMs: 5, maxMs: 30 });
    const t = teams();
    const mk = () => createMatch({ seed: 8, ...structuredClone(t), halfSeconds: 15, humans: [true, true] });
    const peers: [Lockstep, Lockstep] = [new Lockstep({ state: mk(), side: 0, transport: net.ends[0], delay: 4, now: () => net.now }), new Lockstep({ state: mk(), side: 1, transport: net.ends[1], delay: 4, now: () => net.now })];
    const bot = botInput(3);
    const hostile = () => ({ ...bot(), loft: Infinity, shoot: NaN, cursor: { x: Infinity, y: 30 } }) as never;
    drivePair(net, peers, [botInput(2), hostile], 1200);
    net.advance(500);
    expect(peers[0].s.tick).toBe(1200);
    expect(peers[0].desync).toBeNull();
    expect(fingerprint(peers[0].s)).toBe(fingerprint(peers[1].s));
    expect(Number.isFinite(peers[0].s.ball.pos.x)).toBe(true);
  });
});
