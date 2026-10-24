import { describe, expect, test } from 'bun:test';
import { RelayCore, type RelayLimits, type RelaySocket } from '../server/relay-core.ts';
import { CODE_RE, type ServerMsg } from '../src/net/relay.ts';

class FakeSock implements RelaySocket {
  sent: ServerMsg[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string) {
    if (this.closed) throw new Error('send after close');
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closed ??= { code, reason };
  }
  last(): ServerMsg | undefined {
    return this.sent[this.sent.length - 1];
  }
  take(): ServerMsg[] {
    const s = this.sent;
    this.sent = [];
    return s;
  }
}

function relay(limits: Partial<RelayLimits> = {}) {
  const clock = { now: 0 };
  let seed = 1;
  let tokens = 0;
  const core = new RelayCore({
    now: () => clock.now,
    random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
    token: () => `tok-${++tokens}`,
    limits,
  });
  const connect = (ip = '') => {
    const s = new FakeSock();
    core.open(s, ip);
    return s;
  };
  const say = (s: FakeSock, m: unknown) => core.message(s, JSON.stringify(m));
  /** Advance the clock in 1 s sweeps, like the adapter. */
  const wait = (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      clock.now += Math.min(1000, ms - t);
      core.sweep();
    }
  };
  /** Host + join; both sockets keep pinging through `wait`. */
  const pair = (v = 'v1') => {
    const a = connect();
    say(a, { t: 'host', v });
    const hosted = a.last() as Extract<ServerMsg, { t: 'hosted' }>;
    const b = connect();
    say(b, { t: 'join', code: hosted.code.toLowerCase(), v });
    const joined = b.last() as Extract<ServerMsg, { t: 'joined' }>;
    return { a, b, code: hosted.code, tokens: [hosted.token, joined.token] as const };
  };
  return { core, clock, connect, say, wait, pair };
}

describe('relay core', () => {
  test('host gets a code and token, join pairs them, envelopes go both ways untouched', () => {
    const r = relay();
    const { a, b, code, tokens } = r.pair();
    expect(code).toMatch(CODE_RE);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(a.sent).toEqual([{ t: 'hosted', code, seat: 0, token: tokens[0] }, { t: 'peer', s: 'joined' }]);
    expect(b.sent).toEqual([{ t: 'joined', code, seat: 1, token: tokens[1] }]);
    a.take();
    b.take();
    // Anything JSON goes through as is: the relay never looks inside.
    const payload = { t: 'in', from: 5, inputs: [{ cursor: { x: 1.25, y: -3 } }, {}], ack: 4, extra: [null, 'x', { deep: true }] };
    r.say(a, { t: 'relay', m: payload });
    r.say(b, { t: 'relay', m: 'just a string' });
    expect(b.sent).toEqual([{ t: 'relay', m: payload }]);
    expect(a.sent).toEqual([{ t: 'relay', m: 'just a string' }]);
    expect(r.core.stats()).toEqual({ rooms: 1, sockets: 2, matches: 1, relayed: 2 });
  });

  test('ping is answered in any state', () => {
    const r = relay();
    const s = r.connect();
    r.say(s, { t: 'ping', n: 7 });
    expect(s.last()).toEqual({ t: 'pong', n: 7 });
    expect(s.closed).toBeNull();
  });

  test('a third player is refused, a wrong version is refused, and the room stays joinable', () => {
    const r = relay();
    const a = r.connect();
    r.say(a, { t: 'host', v: '2.3.1' });
    const code = (a.last() as { code: string }).code;
    const old = r.connect();
    r.say(old, { t: 'join', code, v: '1.3.1' });
    expect(old.last()).toMatchObject({ t: 'error', code: 'version' });
    expect(old.closed?.code).toBe(1000);
    const b = r.connect();
    r.say(b, { t: 'join', code, v: '2.3.1' });
    expect(b.last()).toMatchObject({ t: 'joined', code });
    const c = r.connect();
    r.say(c, { t: 'join', code, v: '2.3.1' });
    expect(c.last()).toMatchObject({ t: 'error', code: 'full' });
    expect(c.closed).not.toBeNull();
  });

  test('unknown codes say so, and a socket guessing codes is cut off', () => {
    const r = relay({ maxBadJoins: 3 });
    const s = r.connect();
    for (const code of ['AAAAAA', 'zzzzzz', '!!', 'BBBBBB']) r.say(s, { t: 'join', code, v: 'v1' });
    const errors = s.sent.filter((m) => m.t === 'error');
    expect(errors.length).toBe(3);
    expect(errors[0]).toMatchObject({ code: 'no-room' });
    expect(s.closed?.code).toBe(1008);
  });

  test('malformed and out-of-order messages close the socket', () => {
    const r = relay();
    for (const raw of ['not json', '42', '{"t":"nope"}', JSON.stringify({ t: 'relay', m: 1 }), JSON.stringify({ t: 'host' })]) {
      const s = r.connect();
      r.core.message(s, raw);
      expect(s.last()).toMatchObject({ t: 'error', code: 'bad-msg' });
      expect(s.closed?.code).toBe(1008);
    }
    const s = r.connect();
    r.say(s, { t: 'host', v: 'v1' });
    r.say(s, { t: 'host', v: 'v1' });
    expect(s.last()).toMatchObject({ code: 'bad-msg' });
  });

  test('frames over the size cap are refused and the seat is held for a resume', () => {
    const r = relay({ maxFrameBytes: 1000 });
    const { a, b } = r.pair();
    a.take();
    r.say(b, { t: 'relay', m: 'x'.repeat(2000) });
    expect(b.last()).toMatchObject({ t: 'error', code: 'too-big' });
    expect(b.closed?.code).toBe(1009);
    expect(a.take()).toEqual([{ t: 'peer', s: 'away' }]);
  });

  test('rate limit: a burst is fine, a flood is cut off', () => {
    const r = relay({ ratePerSec: 100, burst: 50 });
    const { a, b } = r.pair();
    b.take();
    // 60 messages a second for 5 seconds (lockstep's pace) never trips it.
    for (let sec = 0; sec < 5; sec++) {
      for (let i = 0; i < 60; i++) {
        r.clock.now += 1000 / 60;
        r.say(a, { t: 'relay', m: i });
      }
    }
    expect(a.closed).toBeNull();
    expect(b.take().length).toBe(300);
    // 200 at once is not.
    for (let i = 0; i < 200 && !a.closed; i++) r.say(a, { t: 'relay', m: i });
    expect(a.last()).toMatchObject({ t: 'error', code: 'rate' });
    expect(a.closed?.code).toBe(1008);
    expect(b.sent.filter((m) => m.t === 'relay').length).toBeGreaterThanOrEqual(45);
    expect(b.sent.filter((m) => m.t === 'relay').length).toBeLessThan(60);
  });

  test('a socket that never says hello is closed', () => {
    const r = relay({ helloMs: 5000 });
    const s = r.connect();
    r.wait(4000);
    expect(s.closed).toBeNull();
    r.wait(2000);
    expect(s.last()).toMatchObject({ t: 'error', code: 'timeout' });
    expect(r.core.stats().sockets).toBe(0);
  });

  test('a silent socket is dropped, its seat waits out the grace window, then the survivor hears "left"', () => {
    const r = relay({ heartbeatMs: 10_000, graceMs: 20_000 });
    const { a, b } = r.pair();
    a.take();
    for (let i = 0; i < 12; i++) {
      r.say(a, { t: 'ping', n: i }); // a keeps pinging, b has gone quiet (frozen tab)
      r.wait(1000);
    }
    expect(b.closed?.reason).toBe('timeout');
    expect(a.sent.filter((m) => m.t === 'peer')).toEqual([{ t: 'peer', s: 'away' }]);
    for (let i = 0; i < 21; i++) {
      r.say(a, { t: 'ping', n: i });
      r.wait(1000);
    }
    expect(a.sent.filter((m) => m.t === 'peer')).toEqual([
      { t: 'peer', s: 'away' },
      { t: 'peer', s: 'left', why: 'timeout' },
    ]);
  });

  test('a dropped player resumes the same seat with its token and the match carries on', () => {
    const r = relay({ graceMs: 20_000 });
    const { a, b, code, tokens } = r.pair();
    a.take();
    r.core.close(b);
    expect(a.take()).toEqual([{ t: 'peer', s: 'away' }]);
    // While b is away, a's messages are dropped (lockstep re-sends them later).
    r.say(a, { t: 'relay', m: 'lost' });
    r.clock.now += 3000;
    const thief = r.connect();
    r.say(thief, { t: 'resume', code, seat: 1, token: tokens[0] });
    expect(thief.last()).toMatchObject({ t: 'error', code: 'bad-token' });
    const b2 = r.connect();
    r.say(b2, { t: 'resume', code: code.toLowerCase(), seat: 1, token: tokens[1] });
    expect(b2.take()).toEqual([{ t: 'resumed', code, seat: 1, peer: true }]);
    expect(a.take()).toEqual([{ t: 'peer', s: 'back' }]);
    r.say(a, { t: 'relay', m: 'hello again' });
    r.say(b2, { t: 'relay', m: 'hi' });
    expect(b2.take()).toEqual([{ t: 'relay', m: 'hello again' }]);
    expect(a.take()).toEqual([{ t: 'relay', m: 'hi' }]);
  });

  test('the host can drop and resume too, even before anyone joined', () => {
    const r = relay();
    const a = r.connect();
    r.say(a, { t: 'host', v: 'v1' });
    const { code, token } = a.last() as { code: string; token: string };
    r.core.close(a);
    const b = r.connect();
    r.say(b, { t: 'join', code, v: 'v1' });
    expect(b.take()).toEqual([{ t: 'joined', code, seat: 1, token: 'tok-2' }, { t: 'peer', s: 'away' }]);
    const a2 = r.connect();
    r.say(a2, { t: 'resume', code, seat: 0, token });
    expect(a2.last()).toEqual({ t: 'resumed', code, seat: 0, peer: true });
    expect(b.take()).toEqual([{ t: 'peer', s: 'back' }]);
  });

  test('a resume after the grace window fails', () => {
    const r = relay({ graceMs: 10_000 });
    const { a, b, code, tokens } = r.pair();
    r.core.close(b);
    for (let i = 0; i < 12; i++) {
      r.say(a, { t: 'ping', n: i });
      r.wait(1000);
    }
    const b2 = r.connect();
    r.say(b2, { t: 'resume', code, seat: 1, token: tokens[1] });
    expect(b2.last()).toMatchObject({ t: 'error', code: 'bad-token' });
  });

  test('resuming while the old socket still looks open replaces it', () => {
    const r = relay();
    const { a, b, code, tokens } = r.pair();
    a.take();
    const b2 = r.connect();
    r.say(b2, { t: 'resume', code, seat: 1, token: tokens[1] });
    expect(b.closed?.reason).toBe('replaced');
    expect(b2.last()).toEqual({ t: 'resumed', code, seat: 1, peer: true });
    r.core.close(b); // the old socket's close event arrives late: no effect
    expect(a.take()).toEqual([]);
    r.say(a, { t: 'relay', m: 1 });
    expect(b2.last()).toEqual({ t: 'relay', m: 1 });
    expect(b.sent.some((m) => m.t === 'relay')).toBe(false);
  });

  test('leaving tells the other player at once, and the room goes when both have left', () => {
    const r = relay();
    const { a, b, code, tokens } = r.pair();
    a.take();
    r.say(b, { t: 'leave' });
    expect(a.take()).toEqual([{ t: 'peer', s: 'left', why: 'left' }]);
    expect(b.closed?.code).toBe(1000);
    const b2 = r.connect();
    r.say(b2, { t: 'resume', code, seat: 1, token: tokens[1] });
    expect(b2.last()).toMatchObject({ code: 'bad-token' });
    r.say(a, { t: 'leave' });
    expect(r.core.stats()).toMatchObject({ rooms: 0, sockets: 0 });
    // A room whose host left can't be joined.
    const c = r.connect();
    r.say(c, { t: 'host', v: 'v1' });
    const code2 = (c.last() as { code: string }).code;
    r.say(c, { t: 'leave' });
    const d = r.connect();
    r.say(d, { t: 'join', code: code2, v: 'v1' });
    expect(d.last()).toMatchObject({ code: 'no-room' });
  });

  test('rooms expire: unjoined, idle, and past their lifetime', () => {
    const r = relay({ waitingMs: 60_000, idleMs: 30_000, roomTtlMs: 300_000, heartbeatMs: 1e9 });
    const lonely = r.connect();
    r.say(lonely, { t: 'host', v: 'v1' });
    r.wait(61_000);
    expect(lonely.last()).toMatchObject({ t: 'error', code: 'timeout' });
    expect(r.core.stats().rooms).toBe(0);

    const idle = r.pair();
    r.wait(31_000);
    expect(idle.a.last()).toMatchObject({ t: 'error', code: 'timeout', msg: expect.stringMatching(/idle/) });
    expect(idle.b.closed).not.toBeNull();

    const busy = r.pair();
    for (let i = 0; i < 301 && !busy.a.closed; i++) {
      r.say(busy.a, { t: 'relay', m: i });
      r.wait(1000);
    }
    expect(busy.a.last()).toMatchObject({ t: 'error', code: 'timeout', msg: expect.stringMatching(/time limit/) });
    expect(r.core.stats()).toMatchObject({ rooms: 0, sockets: 0 });
  });

  test('room, socket and per-address caps', () => {
    const r = relay({ maxRooms: 2, maxSockets: 5, maxSocketsPerIp: 2 });
    for (let i = 0; i < 2; i++) r.say(r.connect(`10.0.0.${i}`), { t: 'host', v: 'v1' });
    const third = r.connect('10.0.0.9');
    r.say(third, { t: 'host', v: 'v1' });
    expect(third.last()).toMatchObject({ t: 'error', code: 'busy' });
    expect(r.core.stats().rooms).toBe(2);

    r.connect('10.0.0.7');
    r.connect('10.0.0.7');
    const extra = r.connect('10.0.0.7');
    expect(extra.last()).toMatchObject({ t: 'error', code: 'busy' });
    expect(extra.closed?.code).toBe(1008);
    r.connect('10.0.0.8');
    const full = r.connect('10.0.0.6');
    expect(full.last()).toMatchObject({ code: 'busy' });
    expect(r.core.stats().sockets).toBe(5);
  });

  test('per-address counts are released when sockets close', () => {
    const r = relay({ maxSocketsPerIp: 1 });
    const s = r.connect('1.2.3.4');
    r.core.close(s);
    const t = r.connect('1.2.3.4');
    expect(t.closed).toBeNull();
  });

  test('code guessing is limited per address, and reconnecting does not reset it', () => {
    const r = relay({ maxBadJoins: 5, maxBadJoinsPerIp: 12, badJoinWindowMs: 60_000 });
    let refused = 0;
    let tries = 0;
    for (let sock = 0; sock < 10; sock++) {
      const s = r.connect('6.6.6.6');
      for (let i = 0; i < 5 && !s.closed; i++) {
        r.say(s, { t: 'join', code: 'QQQQQ' + 'ABCDEFGHJK'[i], v: 'v1' });
        tries++;
        if (s.sent.some((m) => m.t === 'error' && m.code === 'rate')) refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(tries - refused).toBeLessThanOrEqual(12);
    // Another address is unaffected, and the window expires.
    const other = r.connect('7.7.7.7');
    r.say(other, { t: 'join', code: 'QQQQQQ', v: 'v1' });
    expect(other.last()).toMatchObject({ code: 'no-room' });
    r.wait(61_000);
    const later = r.connect('6.6.6.6');
    r.say(later, { t: 'join', code: 'QQQQQQ', v: 'v1' });
    expect(later.last()).toMatchObject({ code: 'no-room' });
  });

  test('resume answers the same for an unknown room and a wrong token, and counts as a guess', () => {
    const r = relay({ maxBadJoinsPerIp: 3, badJoinWindowMs: 60_000 });
    const { code } = r.pair();
    const answers: unknown[] = [];
    for (const [c, tok] of [[code, 'wrong'], ['ZZZZZZ', 'wrong']] as const) {
      const s = r.connect('5.5.5.5');
      r.say(s, { t: 'resume', code: c, seat: 1, token: tok });
      answers.push(s.last());
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ t: 'error', code: 'bad-token' });
    const s = r.connect('5.5.5.5');
    r.say(s, { t: 'resume', code, seat: 1, token: 'x' });
    const t = r.connect('5.5.5.5');
    r.say(t, { t: 'join', code, v: 'v1' });
    expect(t.last()).toMatchObject({ code: 'rate' });
  });

  test('byte budget: a stream of maximum-size frames is cut off even under the message rate', () => {
    const r = relay({ maxFrameBytes: 32_000, bytesPerSec: 100_000, byteBurst: 200_000, ratePerSec: 1000, burst: 1000 });
    const { a } = r.pair();
    const big = 'x'.repeat(30_000);
    for (let i = 0; i < 20 && !a.closed; i++) {
      r.clock.now += 50;
      r.say(a, { t: 'relay', m: big });
    }
    expect(a.last()).toMatchObject({ code: 'rate' });
  });
});
