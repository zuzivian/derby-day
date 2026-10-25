// Peer input is untrusted: hostile team setups, start messages and lockstep messages.
import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { newGame, clubTeam } from '../src/meta/game.ts';
import { Lockstep, type LockstepMsg } from '../src/net/lockstep.ts';
import { botInput, drivePair, MemoryNetwork } from '../src/net/memory.ts';
import { INPUT_FIELDS, cleanInput, cleanLockstepMsg, cleanStart, cleanTeam, cleanText, isOwnTeam } from '../src/net/validate.ts';
import { Listeners, type Transport } from '../src/net/transport.ts';
import { makeRng, next } from '../src/sim/rng.ts';
import { createMatch, fingerprint } from '../src/sim/match.ts';
import type { HumanInput } from '../src/sim/types.ts';

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
  test('every HumanInput field survives cleaning, so no control is lost online', () => {
    const full: Required<HumanInput> = { cursor: { x: 50, y: 30 }, dir: { x: 0.5, y: -1 }, pass: true, loft: 0.4, shoot: 0.9, tackle: true, select: true, sprint: true, switchPlayer: true, aim: { x: 104, y: 34 }, moved: true, tactic: 5 };
    // INPUT_FIELDS (src/net/validate.ts) is type-checked to list every HumanInput field.
    expect(Object.keys(full).sort()).toEqual(Object.keys(INPUT_FIELDS).sort());
    expect(cleanInput(full)).toEqual(full);
  });

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

describe('names and the guest checking its own team', () => {
  test("names keep & and ', collapse spaces, and are cut by code point", () => {
    expect(cleanText("Brighton & Hove's  Albion", 40)).toBe("Brighton & Hove's Albion");
    expect(cleanText("D'Arcy", 40)).toBe("D'Arcy");
    expect(cleanText('a\u0000<b>"c"`d\\e', 40)).toBe('abcde');
    const cut = cleanText('⚽'.repeat(50), 5)!;
    expect(Array.from(cut).length).toBe(5);
    expect(cut).toBe('⚽⚽⚽⚽⚽'); // no lone surrogate
    expect(cleanText('   ', 10)).toBeNull();
  });

  test('the away team in a start must be the guest\'s own squad; only the kit and " II" may change', () => {
    const { home, away } = teams();
    const mine = cleanTeam(away)!;
    expect(isOwnTeam(mine, mine)).toBe(true);
    expect(isOwnTeam({ ...mine, primary: mine.secondary, secondary: mine.primary }, mine)).toBe(true);
    expect(isOwnTeam({ ...mine, primary: '#f5f5f5', secondary: '#1c1c1c' }, mine)).toBe(true);
    expect(isOwnTeam({ ...mine, name: `${mine.name} II` }, mine)).toBe(true);
    // What a malicious host might try:
    const zeroed = { ...mine, players: mine.players.map((p) => ({ ...p, attrs: { ...p.attrs, pace: 0, shooting: 0 } })) };
    expect(isOwnTeam(zeroed, mine)).toBe(false);
    expect(isOwnTeam({ ...mine, primary: home.primary, secondary: home.primary }, mine)).toBe(false); // an unreadable clashing kit
    expect(isOwnTeam(cleanTeam(home)!, mine)).toBe(false); // someone else's squad
    expect(isOwnTeam({ ...mine, aiSkill: 0 }, mine)).toBe(false);
    expect(isOwnTeam({ ...mine, formation: mine.formation === '4-4-2' ? '4-3-3' : '4-4-2' }, mine)).toBe(false);
    expect(isOwnTeam({ ...mine, players: [...mine.players].reverse() }, mine)).toBe(false);
    expect(isOwnTeam({ ...mine, name: 'Somebody Else' }, mine)).toBe(false);
  });

  test('a forged pong cannot skew the round-trip stats', () => {
    const { home, away } = teams();
    const ls = new Listeners<unknown>();
    const sent: LockstepMsg[] = [];
    const tr: Transport<LockstepMsg> = { send: (m) => sent.push(m), onMessage: (fn) => ls.add(fn as (m: unknown) => void), close: () => {} };
    let now = 1000;
    const peer = new Lockstep({ state: createMatch({ seed: 1, home, away, humans: [true, true] }), side: 0, transport: tr, delay: 4, now: () => now });
    ls.emit({ t: 'pong', n: 1, at: -1e300 }); // never sent
    expect(peer.rttMs).toBe(0);
    ls.emit({ t: 'in', from: 5, ack: 0, inputs: new Array(60).fill({}) }); // the other side's inputs, so it can run
    for (let i = 0; i < 40; i++) peer.tick(() => ({})); // pings when it schedules tick 30
    const ping = sent.find((m) => m.t === 'ping') as { n: number; at: number } | undefined;
    expect(ping).toBeDefined();
    ls.emit({ t: 'pong', n: ping!.n, at: -1e300 }); // real n, absurd time
    expect(peer.rttMs).toBe(0);
    now += 40;
    ls.emit({ t: 'pong', n: ping!.n, at: ping!.at });
    expect(peer.rttMs).toBe(40);
  });
});

describe('tactics online', () => {
  test("a side's mentality survives cleaning, and a host can't change the guest's", () => {
    const { home } = teams(4);
    for (const m of ['park', 'defensive', 'attacking', 'press'] as const) expect(cleanTeam({ ...home, mentality: m })!.mentality).toBe(m);
    // Balanced (or junk) is left off, as toTeamSetup does.
    expect('mentality' in cleanTeam({ ...home, mentality: 'balanced' })!).toBe(false);
    expect('mentality' in cleanTeam({ ...home, mentality: 'gegenpress' })!).toBe(false);
    const mine = { ...home, mentality: 'press' as const };
    expect(isOwnTeam(cleanTeam(mine)!, mine)).toBe(true);
    expect(isOwnTeam(cleanTeam({ ...mine, mentality: 'park' })!, mine)).toBe(false);
  });

  test('a quick-tactics input is a whole mentality step or nothing', () => {
    for (const t of [1, 3, 5]) expect(cleanInput({ tactic: t })).toEqual({ tactic: t });
    for (const t of [0, 6, 2.5, -1, '3', Infinity]) expect(cleanInput({ tactic: t })).toEqual({});
  });
});
