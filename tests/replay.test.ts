import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import {
  addRecent,
  clipsFor,
  decodeReplay,
  encodeReplay,
  expandInputs,
  finalHash,
  formatSize,
  inputsEqual,
  KEEP_CHARS,
  KEYFRAME_EVERY,
  quantiseInput,
  REPLAY_VERSION,
  replayId,
  replayTo,
  ReplayRecorder,
  ReplaySeeker,
  type Replay,
  type StoredReplay,
} from '../src/meta/replay.ts';
import { createMatch, fingerprint, step } from '../src/sim/match.ts';
import { HALF_SECONDS } from '../src/sim/constants.ts';
import { pack, unpack } from '../src/meta/pack.ts';
import type { HumanInput, MatchState } from '../src/sim/types.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

/** A scripted "player": wanders the cursor, passes, shoots, sprints, now and then uses the keys. */
function scripted(seed: number, t: number): HumanInput {
  const k = (t * 7 + seed * 13) % 600;
  const input: HumanInput = {};
  if (k < 400) input.cursor = { x: 20 + 25 * Math.sin((t + seed) / 90) + Math.PI / 1000, y: 20 + 12 * Math.cos((t + seed) / 70) };
  else input.dir = { x: k % 2 ? 1 : -1, y: (t % 3) - 1 };
  if (t % 75 === 0) input.pass = true;
  if (t % 210 === 0) input.shoot = 0.4 + (t % 5) / 10 + 0.00123;
  if (t % 320 === 0) input.loft = 0.37 + 0.00456;
  if (t % 140 < 50) input.sprint = true;
  if (t % 500 === 0) input.switchPlayer = true;
  if (t % 110 === 13) input.tackle = true;
  if (t % 95 === 41) input.select = true;
  if (t % 900 === 0) input.shoot = 0.55;
  return input;
}

/** Play a match live the way matchView does: record each input, step with the recorded (quantised) one. */
function playLive(seed: number, halfSeconds: number, input: (t: number) => HumanInput = (t) => scripted(seed, t)): { s: MatchState; replay: Replay } {
  const t = teams(seed);
  const opts = { seed, ...t, halfSeconds, humanTeam: 0 as const };
  const s = createMatch(opts);
  const rec = new ReplayRecorder(opts, 'Test');
  let n = 0;
  while (s.phase !== 'fulltime') step(s, rec.push(input(n++)));
  return { s, replay: rec.finish(s, 1_700_000_000) };
}

describe('replay recording', () => {
  test('quantiseInput keeps loft and shot power to 1% and keeps tackle and select', () => {
    const q = quantiseInput({ cursor: { x: 1, y: 2 }, loft: 0.3849, shoot: 0.5551, tackle: true, select: true, pass: false });
    expect(q).toEqual({ cursor: { x: 1, y: 2 }, loft: 0.38, shoot: 0.56, tackle: true, select: true });
    expect(quantiseInput({ loft: 7 }).loft).toBe(1);
    expect(quantiseInput({ loft: -1 }).loft).toBe(0);
  });

  test('inputsEqual tells every new field apart', () => {
    const base = { cursor: { x: 1, y: 2 } };
    for (const extra of [{ loft: 0.3 }, { tackle: true }, { select: true }, { shoot: 0.6 }, { pass: true }] as const) {
      expect(inputsEqual(base, { ...base, ...extra })).toBe(false);
      expect(inputsEqual({ ...base, ...extra }, { ...base, ...extra })).toBe(true);
    }
    expect(inputsEqual({ ...base, loft: 0.3 }, { ...base, loft: 0.31 })).toBe(false);
  });

  test('quantiseInput keeps cursors to 1 cm and drops false fields', () => {
    const q = quantiseInput({ cursor: { x: 12.3456, y: -0.004 }, pass: false, sprint: true, shoot: 1.7, dir: { x: -0.0001, y: 1 } });
    expect(q).toEqual({ cursor: { x: 12.35, y: 0 }, sprint: true, shoot: 1, dir: { x: 0, y: 1 } });
    expect(Object.is(q.cursor!.y, -0)).toBe(false);
    expect(Object.is(q.dir!.x, -0)).toBe(false);
  });

  test('push returns the quantised input and merges identical neighbours', () => {
    const t = teams(1);
    const rec = new ReplayRecorder({ seed: 1, ...t });
    const a = rec.push({ cursor: { x: 10.001, y: 5 } });
    expect(a.cursor).toEqual({ x: 10, y: 5 });
    rec.push({ cursor: { x: 10.004, y: 5 } });
    rec.push({ cursor: { x: 10.2, y: 5 } });
    rec.push({});
    const s = createMatch({ seed: 1, ...t });
    const r = rec.finish(s, 5);
    expect(r.runs.map((x) => x.n)).toEqual([2, 1, 1]);
    expect(r.ticks).toBe(4);
  });
});

describe('replay codes', () => {
  test('codes made under the earlier names (OVR1., TB1.) still decode', () => {
    const { replay } = playLive(11, 6);
    for (const old of ['OVR1.', 'TB1.']) {
      const legacy = old + encodeReplay(replay).slice('DD1.'.length);
      expect(encodeReplay(decodeReplay(legacy))).toBe(encodeReplay(replay));
    }
  });

  test('every input field survives the run encoder, alone and together', () => {
    const inputs: HumanInput[] = [
      { cursor: { x: 10.5, y: 3.25 }, loft: 0.01 },
      { cursor: { x: 10.5, y: 3.25 }, loft: 1 },
      { cursor: { x: 11, y: 4 }, shoot: 0.55, tackle: true },
      { cursor: { x: 11, y: 4 }, select: true },
      { dir: { x: -1, y: 1 }, pass: true, sprint: true, switchPlayer: true },
      { dir: { x: 0, y: 0 }, loft: 0, shoot: 1, tackle: true, select: true, pass: true },
      {},
    ];
    const opts = { seed: 9, ...teams(3), halfSeconds: 5, humanTeam: 0 as const };
    const s = createMatch(opts);
    const rec = new ReplayRecorder(opts, 'Fields');
    let n = 0;
    while (s.phase !== 'fulltime') {
      step(s, rec.push(inputs[Math.floor(n / 3) % inputs.length]));
      n++;
    }
    const replay = rec.finish(s, 1_700_000_000);
    const back = decodeReplay(encodeReplay(replay));
    expect(back.runs).toEqual(replay.runs);
    for (const want of inputs) expect(back.runs.some((r) => inputsEqual(r.input, quantiseInput(want)))).toBe(true);
    expect(finalHash(replayTo(back, back.ticks))).toBe(back.fp);
  });

  test('a code from the old controls (format 1) is refused politely, a newer one too', () => {
    const { replay } = playLive(11, 3);
    const code = encodeReplay(replay);
    // Rewrite the version byte (the first byte of the body) and fix the checksum the way the encoder does.
    const withVersion = (v: number) => {
      const std = code.slice('DD1.'.length).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const body = bytes.slice(0, bytes.length - 4);
      body[0] = v;
      let h = 0x811c9dc5;
      for (const b of body) {
        h ^= b;
        h = Math.imul(h, 0x01000193);
      }
      const out = new Uint8Array(body.length + 4);
      out.set(body);
      new DataView(out.buffer).setUint32(body.length, h >>> 0, true);
      let s = '';
      for (const b of out) s += String.fromCharCode(b);
      return 'DD1.' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    expect(() => decodeReplay(withVersion(1))).toThrow(/older version/);
    expect(() => decodeReplay(withVersion(REPLAY_VERSION + 1))).toThrow(/newer version/);
    expect(decodeReplay(withVersion(REPLAY_VERSION))).toEqual(replay);
  });

  test('encode then decode round-trips everything, byte for byte', () => {
    const { replay } = playLive(11, 6);
    const code = encodeReplay(replay);
    expect(code.startsWith('DD1.')).toBe(true);
    expect(/^[A-Za-z0-9._-]+$/.test(code)).toBe(true);
    const back = decodeReplay(code);
    expect(back).toEqual(replay);
    expect(encodeReplay(back)).toBe(code);
  });

  test('tolerates pasted whitespace and line breaks', () => {
    const { replay } = playLive(4, 3);
    const code = encodeReplay(replay);
    const messy = `  ${code.slice(0, 40)}\n${code.slice(40, 90)}\r\n ${code.slice(90)}  `;
    expect(decodeReplay(messy)).toEqual(replay);
  });

  test('rejects garbage, truncation and tampering with a readable error', () => {
    const { replay } = playLive(5, 3);
    const code = encodeReplay(replay);
    expect(() => decodeReplay('hello')).toThrow(/not a Derby Day replay/);
    expect(() => decodeReplay('')).toThrow(/not a Derby Day replay/);
    expect(() => decodeReplay(code.slice(0, code.length - 9))).toThrow(/damaged or cut short/);
    const mid = Math.floor(code.length / 2);
    const flipped = code.slice(0, mid) + (code[mid] === 'A' ? 'B' : 'A') + code.slice(mid + 1);
    expect(() => decodeReplay(flipped)).toThrow(/damaged or cut short/);
    expect(() => decodeReplay('DD1.!!!!')).toThrow(/damaged or cut short/);
    expect(() => decodeReplay('DD1.AAAAAAAAAAAAAAAA')).toThrow(/damaged or cut short|newer/);
  });

  test('odd team data survives: unicode names, non-hex colours, awkward floats', () => {
    const t = teams(3);
    t.home.name = 'Ünïcode FC 日本';
    t.home.primary = 'rebeccapurple';
    t.away.aiSkill = 0.123456789;
    t.away.players[2].attrs.pace = 1 / 3;
    const opts = { seed: -987654321, ...t, halfSeconds: 2.5, humanTeam: 1 as const };
    const s = createMatch(opts);
    const rec = new ReplayRecorder(opts, 'Odd ✓');
    for (let i = 0; i < 300; i++) step(s, rec.push(scripted(2, i)));
    const r = rec.finish(s, 123);
    const back = decodeReplay(encodeReplay(r));
    expect(back).toEqual(r);
    expect(fingerprint(replayTo(back, 300))).toBe(fingerprint(s));
  });
});

describe('deterministic re-simulation', () => {
  for (const seed of [1, 2, 3, 42, 777, 123456]) {
    test(`seed ${seed}: a decoded replay reproduces the live fingerprint and score`, () => {
      const { s, replay } = playLive(seed, 8);
      expect(replay.ticks).toBe(s.tick);
      const decoded = decodeReplay(encodeReplay(replay));
      const re = replayTo(decoded, decoded.ticks);
      expect(fingerprint(re)).toBe(fingerprint(s));
      expect(re.score).toEqual(s.score);
      expect(re.events).toEqual(s.events);
      expect(decoded.score).toEqual(s.score);
      expect(decoded.goals.map((g) => g.tick)).toEqual(s.goals.map((e) => e.tick));
    });
  }

  test('replayTo any mid-match tick equals stepping a live match to that tick', () => {
    const { replay } = playLive(9, 8);
    const t = teams(9);
    const live = createMatch({ seed: 9, ...t, halfSeconds: 8, humanTeam: 0 });
    const inputs = expandInputs(replay);
    for (const stop of [0, 1, 250, 599, 600, 601, 900, replay.ticks]) {
      while (live.tick < stop) step(live, inputs[live.tick]);
      expect(fingerprint(replayTo(decodeReplay(encodeReplay(replay)), stop))).toBe(fingerprint(live));
    }
  });

  test('keyboard-only and idle matches replay too', () => {
    for (const mk of [(t: number): HumanInput => ({ dir: { x: t % 100 < 50 ? 1 : -1, y: 0 }, pass: t % 60 === 0 }), (): HumanInput => ({})]) {
      const { s, replay } = playLive(21, 6, mk);
      expect(fingerprint(replayTo(decodeReplay(encodeReplay(replay)), replay.ticks))).toBe(fingerprint(s));
    }
  });

  test('a replay whose sim has changed fails verification', () => {
    const { replay } = playLive(6, 4);
    const bad: Replay = { ...replay, fp: (replay.fp ^ 0x5555) >>> 0 || 7 };
    const seeker = new ReplaySeeker(bad);
    while (!seeker.warm(5000));
    expect(seeker.verified).toBe(false);
    const good = new ReplaySeeker(replay);
    while (!good.warm(5000));
    expect(good.verified).toBe(true);
  });
});

describe('seeking', () => {
  test('seek (forwards, backwards, jumping) always matches replayTo', () => {
    const { replay } = playLive(13, 12);
    expect(replay.ticks).toBeGreaterThan(KEYFRAME_EVERY * 2);
    const seeker = new ReplaySeeker(replay);
    const targets = [5, 1300, 700, 1299, 0, replay.ticks, 599, 600, 2000, 601, replay.ticks + 99999, -5];
    for (const target of targets) {
      const s = seeker.seek(target);
      const want = Math.max(0, Math.min(target, replay.ticks));
      expect(s.tick).toBe(want);
      expect(fingerprint(s)).toBe(fingerprint(replayTo(replay, want)));
    }
  });

  test('stepForward and seek agree, and keyframes are cached every 600 ticks', () => {
    const { replay } = playLive(14, 12);
    const seeker = new ReplaySeeker(replay);
    for (let i = 0; i < 1300; i++) seeker.stepForward();
    expect(seeker.keyframes).toBe(3); // 0, 600, 1200
    expect(fingerprint(seeker.state)).toBe(fingerprint(replayTo(replay, 1300)));
    const before = seeker.steps;
    seeker.seek(1250); // back to the 1200 keyframe, then 50 steps
    expect(seeker.steps - before).toBe(50);
    seeker.seek(10);
    expect(fingerprint(seeker.state)).toBe(fingerprint(replayTo(replay, 10)));
  });

  test('no seek costs more than a keyframe interval of steps once warmed', () => {
    const { replay } = playLive(15, 12);
    const seeker = new ReplaySeeker(replay);
    while (!seeker.warm(4000));
    expect(seeker.keyframes).toBe(Math.floor(replay.ticks / KEYFRAME_EVERY) + 1);
    let worst = 0;
    for (const target of [replay.ticks, 7, 1799, 3000, 1, 1201, 2400]) {
      const before = seeker.steps;
      seeker.seek(target);
      worst = Math.max(worst, seeker.steps - before);
    }
    expect(worst).toBeLessThan(KEYFRAME_EVERY);
  });

  test('clipsFor gives a window per goal plus the whole match', () => {
    // Find a seed with goals under an idle human.
    let found: Replay | null = null;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const r = playLive(seed, 30, () => ({})).replay;
      if (r.goals.length >= 1) found = r;
    }
    expect(found).not.toBeNull();
    const clips = clipsFor(found!);
    expect(clips.length).toBe(found!.goals.length + 1);
    const g = clips[0];
    expect(g.kind).toBe('goal');
    expect(g.goal!.tick - g.start).toBeLessThanOrEqual(360);
    expect(g.end).toBeGreaterThan(g.goal!.tick);
    expect(clips[clips.length - 1]).toMatchObject({ kind: 'match', start: 0, end: found!.ticks });
  });
});

describe('size', () => {
  test('RLE shrinks idle input runs', () => {
    const idle = playLive(30, 20, () => ({})).replay;
    expect(idle.ticks).toBeGreaterThan(2400);
    expect(idle.runs.length).toBe(1);
    const idleSize = encodeReplay(idle).length;
    // Teams take a few hundred bytes; the whole input log of a 2400+ tick match is one run.
    const noInput = encodeReplay({ ...idle, runs: [], ticks: 0 }).length;
    expect(idleSize - noInput).toBeLessThan(12);
    // Versus one JSON object per tick.
    const naive = JSON.stringify(expandInputs(idle)).length;
    expect(idleSize).toBeLessThan(naive / 4);

    // Holding the pointer still while only the odd key is pressed stays tiny too.
    const still = playLive(30, 20, (t) => ({ cursor: { x: 30, y: 20 }, sprint: t % 600 < 300 })).replay;
    expect(still.runs.length).toBeLessThan(still.ticks / 100);
  });

  test('a moving mouse stays within a few bytes per tick', () => {
    const { replay } = playLive(31, 20);
    const bytes = encodeReplay(replay).length;
    expect(bytes / replay.ticks).toBeLessThan(6);
  });

  test('formatSize', () => {
    expect(formatSize(900)).toBe('900 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(40960)).toBe('40 KB');
  });
});

describe('keeping the last few', () => {
  const entry = (n: number, size = 10): StoredReplay => ({ id: `r${n}`, at: n, code: 'x'.repeat(size) });

  test('keeps at most 5, dropping the oldest', () => {
    let list: StoredReplay[] = [];
    for (let i = 1; i <= 8; i++) list = addRecent(list, entry(i));
    expect(list.map((e) => e.id)).toEqual(['r4', 'r5', 'r6', 'r7', 'r8']);
  });

  test('drops the oldest until the JSON fits the size cap', () => {
    let list: StoredReplay[] = [];
    for (let i = 1; i <= 4; i++) list = addRecent(list, entry(i, 1000), 5, 2500);
    expect(list.map((e) => e.id)).toEqual(['r3', 'r4']);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(2500);
    // A single entry bigger than the cap is not kept at all.
    expect(addRecent(list, entry(9, 5000), 5, 2500)).toEqual([]);
  });

  test('re-adding the same replay does not duplicate it', () => {
    let list = addRecent([], entry(1));
    list = addRecent(list, entry(2));
    list = addRecent(list, entry(1));
    expect(list.map((e) => e.id)).toEqual(['r2', 'r1']);
  });

  test('real replays: five full-length matches with a restless mouse fit under the cap', () => {
    // A pointer that wanders every tick and stops now and then, as a player's does (the smooth
    // scripted cursor compresses far better than real play, so it would flatter the codec).
    const mouse = (seed: number) => {
      let r = seed;
      const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      let cx = 50, cy = 34, vx = 0, vy = 0, still = 0;
      return (t: number): HumanInput => {
        if (still > 0) still--;
        else {
          vx = vx * 0.9 + (rnd() - 0.5) * 0.25;
          vy = vy * 0.9 + (rnd() - 0.5) * 0.25;
          cx = Math.max(0, Math.min(105, cx + vx));
          cy = Math.max(0, Math.min(68, cy + vy));
          if (rnd() < 0.01) still = Math.floor(rnd() * 90);
        }
        const i: HumanInput = { cursor: { x: cx, y: cy } };
        if (still === 0) i.moved = true;
        if (t % 97 === 0) i.pass = true;
        if (t % 400 === 0) i.shoot = 0.7;
        return i;
      };
    };
    // A code's size depends on the inputs and the match's length, not on how play went, so one
    // full-length match is simulated (for its real length and final state) and each mouse is then
    // recorded over that many ticks. Simulating all six took 4.6 to 7.7 s, near bun's 5 s timeout;
    // playback itself is checked by the format 5 test below.
    const { s: end, replay: first } = playLive(50, HALF_SECONDS, mouse(50));
    const t = teams(50);
    const opts = { seed: 50, ...t, halfSeconds: HALF_SECONDS, humanTeam: 0 as const };
    const replays = [first];
    for (let seed = 51; seed < 56; seed++) {
      const rec = new ReplayRecorder(opts, 'Test');
      const input = mouse(seed);
      for (let n = 0; n < first.ticks; n++) rec.push(input(n));
      replays.push(rec.finish(end, 1_700_000_000 + seed));
    }
    let list: StoredReplay[] = [];
    let biggest = 0;
    for (const replay of replays) {
      const code = encodeReplay(replay);
      biggest = Math.max(biggest, code.length);
      list = addRecent(list, { id: replayId(replay), at: replay.at, code });
    }
    expect(list.length).toBe(5);
    expect(JSON.stringify(list).length).toBeLessThan(KEEP_CHARS);
    expect(biggest).toBeLessThan(60_000);
  });

  test('format 5 packs the input runs and plays back exactly; random bytes round-trip through pack', () => {
    const { s, replay } = playLive(61, 40);
    const back = decodeReplay(encodeReplay(replay));
    expect(back.runs).toEqual(replay.runs);
    expect(finalHash(replayTo(back, back.ticks))).toBe(finalHash(s));
    for (const n of [0, 1, 2, 255, 4096, 30000]) {
      const a = new Uint8Array(n).map((_, i) => (i * 2654435761) >>> 24);
      expect([...unpack(pack(a), n)]).toEqual([...a]);
    }
  });
});
