// Headers in open play: a ball dropping at head height to a man near where it comes down, the same scene for the
// CPU's man and for the human's. Playtest: "far too easy for the CPU to head balls, far too difficult for humans".
//
// Diagnosis (HEADERS_REPORT=1 bun test tests/headers.test.ts prints the table). The CPU runs to the point the ball
// comes down through head height (ai.ts interceptOn) and then heads it 62-87% of the time whatever he is (match.ts
// header); 95 of 120 balls were his. The human's man only headed it when the pointer happened to put him within
// 0.7 m of the ball at the very tick it passed 2.5 m: 12 of 120 with the pointer exactly where the ball lands (the
// ball is a metre or two short of that when it is at head height), 3 with it on the ball, 2 with it still.

import { describe, expect, test } from 'bun:test';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { headSpot } from '../src/sim/ai.ts';
import { meetHeader } from '../src/sim/human.ts';
import { createMatch, step } from '../src/sim/match.ts';
import type { HumanInput, MatchPlayer, MatchState } from '../src/sim/types.ts';
import { len, norm, type Vec } from '../src/sim/vec.ts';
import { openPlay } from './helpers.ts';

function teams(seed: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  return { home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)) };
}

/** Where the human's pointer is in a scene: on the spot the ball comes down, on the ball, dead still, behind him, or a fixed point. */
type Pointer = 'drop' | 'ball' | 'still' | 'away' | Vec;

interface Scene {
  /** Metres from the drop point to the man's start, and the angle (radians) he stands at. */
  r: number;
  a: number;
  /** Flight: metres the ball travels, and its hang time (s). */
  range: number;
  hang: number;
  /** Bearing of the ball's flight. */
  bearing: number;
  seed: number;
  /** His defending and shooting, when the scene sets them. */
  skill?: number;
}

/** Fire a lofted ball from `from` toward `bearing`. It is the opponents' ball (a clearance or a cross they sent). */
function loft(s: MatchState, from: Vec, bearing: number, range: number, hang: number, by: MatchPlayer): void {
  const b = s.ball;
  const sp = (range / hang) * 1.1;
  b.owner = -1;
  b.receiver = -1;
  b.passFrom = -1;
  b.inHands = false;
  b.pos = { ...from };
  b.vel = { x: Math.cos(bearing) * sp, y: Math.sin(bearing) * sp };
  b.z = 0.4;
  b.vz = (9.8 * hang) / 2 - 0.4 / hang;
  b.kickedBy = by.i;
  b.lastTouch = by.i;
  b.touch = 0;
  b.noPickup.fill(0);
}

/** The scene set up, the ball not yet kicked: team 0's man `p`, the opponent `by` who will loft it, where it comes down. */
function setup(sc: Scene, human: boolean) {
  const s = createMatch({ seed: sc.seed, ...teams(7), halfSeconds: 60, humans: human ? [true, false] : [false, false] });
  openPlay(s);
  const p = s.players.find((m) => m.team === 0 && m.role === 'MID')!;
  const by = s.players.find((m) => m.team === 1 && m.role === 'MID')!;
  for (const m of s.players) {
    if (m === p || m === by) continue;
    m.stun = 100000;
    m.pos = { x: 52 + (m.i % 5), y: -2 - (m.i % 3) };
    m.vel = { x: 0, y: 0 };
  }
  by.pos = { x: 20, y: -5 };
  by.stun = 100000;
  if (sc.skill !== undefined) p.attrs.defending = p.attrs.shooting = sc.skill;
  const from = { x: 40, y: 34 };
  // Where does it first land? Run the flight with nobody about.
  const probe = structuredClone(s);
  loft(probe, from, sc.bearing, sc.range, sc.hang, probe.players[by.i]);
  probe.players[p.i].pos = { x: 5, y: -5 };
  for (let t = 0; t < 400 && probe.ball.z > 0; t++) step(probe);
  const drop = { ...probe.ball.pos };
  p.pos = { x: drop.x + Math.cos(sc.a) * sc.r, y: drop.y + Math.sin(sc.a) * sc.r };
  p.vel = { x: 0, y: 0 };
  p.facing = { x: 1, y: 0 };
  s.switchTimer[0] = 1e9;
  s.controlled[0] = p.i;
  if (s.ctlHold) s.ctlHold = [false, false];
  return { s, p, by, from, drop };
}

interface Outcome {
  /** Did the man play it (a header, or a bounce off his body) before it first touched the floor? */
  touched: boolean;
  /** ...as a header: up and away hard? */
  headed: boolean;
  /** The ball's velocity as he played it. */
  sent: Vec | null;
}

/**
 * One scene: team 0's man stands `r` m from where a lofted ball of team 1's comes down. `human`: he is steered by a
 * pointer (a human on team 0), else the CPU plays him. Everyone else is out of the way.
 */
function aerialScene(sc: Scene, human: boolean, pointer: Pointer = 'drop'): Outcome {
  const { s, p, by, from, drop } = setup(sc, human);
  loft(s, from, sc.bearing, sc.range, sc.hang, by);
  for (let t = 0; t < 400 && s.ball.z > 0.05 && s.phase === 'play'; t++) {
    const input: HumanInput = {};
    if (human) {
      const to = typeof pointer !== 'string' ? pointer : pointer === 'drop' ? drop : pointer === 'ball' ? s.ball.pos : pointer === 'away' ? { x: p.pos.x - 20, y: p.pos.y } : p.pos;
      input.cursor = { ...to };
    }
    const z = s.ball.z;
    step(s, input);
    if (s.ball.lastTouch === p.i) return { touched: true, headed: z > 1.5 && len(s.ball.vel) > 9, sent: { ...s.ball.vel } };
  }
  return { touched: false, headed: false, sent: null };
}

/** A fixed spread of scenes: the man starts 0.5-7 m from the drop point, all round it, off short and long balls. */
function scenes(n: number): Scene[] {
  const out: Scene[] = [];
  for (let k = 0; k < n; k++) {
    const u = (k * 0.6180339887) % 1;
    const v = (k * 0.7548776662) % 1;
    out.push({ r: 0.5 + 6.5 * u, a: v * Math.PI * 2, range: 14 + 14 * ((k * 0.5698402909) % 1), hang: 1.7 + 0.8 * ((k * 0.3247179572) % 1), bearing: -0.5 + ((k * 0.4142135623) % 1), seed: 100 + k });
  }
  return out;
}

/** How many of `list` (those starting between `near[0]` and `near[1]` m from the drop point) he heads. */
function headed(list: Scene[], human: boolean, pointer: Pointer = 'drop', near: [number, number] = [0, 8]): { heads: number; n: number } {
  let heads = 0;
  let n = 0;
  for (const sc of list) {
    if (sc.r < near[0] || sc.r >= near[1]) continue;
    n++;
    if (aerialScene(sc, human, pointer).headed) heads++;
  }
  return { heads, n };
}

describe('headers in open play', () => {
  test('the CPU man does not win every ball in the air, and a better header of the ball wins more', () => {
    const list = scenes(120);
    const cpu = headed(list, false);
    // Before: 95 of 120. Now about three in five.
    expect(cpu.heads / cpu.n).toBeGreaterThan(0.4);
    expect(cpu.heads / cpu.n).toBeLessThan(0.72);
    const rate = (skill: number) => headed(list.map((sc) => ({ ...sc, skill })), false, 'drop', [0, 4]);
    const poor = rate(0.15);
    const good = rate(0.95);
    expect(good.heads).toBeGreaterThan(poor.heads + 10);
  }, 120000);

  test('the human man heads a ball dropping near him whatever the pointer does, about as often as the CPU man', () => {
    const list = scenes(120);
    const cpu = headed(list, false, 'drop', [0, 3]);
    for (const pointer of ['drop', 'ball', 'still', 'away'] as Pointer[]) {
      const h = headed(list, true, pointer, [0, 3]);
      expect(h.n).toBe(cpu.n);
      // Before: 4 of 46 with the pointer on the spot, 0 to 1 otherwise (the CPU man: 36 of 46).
      expect(h.heads / h.n).toBeGreaterThan(0.5);
      expect(Math.abs(h.heads - cpu.heads) / h.n).toBeLessThan(0.25);
    }
  }, 120000);

  test('a ball dropping further off (up to 6 m) is still worth a run: he gets to it when he can', () => {
    const list = scenes(120);
    const far = headed(list, true, 'still', [3, 6]);
    expect(far.heads / far.n).toBeGreaterThan(0.4);
  }, 120000);

  test("the human's header goes where the pointer is, when it is some way off", () => {
    const list = scenes(40).filter((sc) => sc.r < 2.5);
    let n = 0;
    for (const sc of list) {
      const { drop } = setup(sc, true);
      const target = { x: drop.x + 14, y: drop.y + 9 };
      const o = aerialScene(sc, true, target);
      if (!o.headed) continue;
      n++;
      // Off the head toward the pointer from where he met it: within about 25 degrees of the way from there.
      const way = norm(o.sent!);
      const want = norm({ x: target.x - drop.x, y: target.y - drop.y });
      expect(way.x * want.x + way.y * want.y).toBeGreaterThan(Math.cos(0.5));
    }
    expect(n).toBeGreaterThan(6);
  }, 120000);

  test('he is taken off the run only for a ball he can play: not one his side just played outside the box, not with a teammate nearer', () => {
    const sc = scenes(1)[0];
    const { s, p, by, from } = setup({ ...sc, r: 2 }, true);
    loft(s, from, sc.bearing, sc.range, sc.hang, by);
    for (let t = 0; t < 40; t++) step(s, { cursor: { ...p.pos } });
    expect(s.ball.z).toBeGreaterThan(1);
    expect(meetHeader(s, p)).not.toBeNull();
    // His own side lofted it, in the middle of the pitch: he lets it drop to the chest, he is not sent after it.
    s.ball.lastTouch = s.players.find((m) => m.team === 0 && m.i !== p.i)!.i;
    expect(meetHeader(s, p)).toBeNull();
    // Back to the opponent's ball, but a teammate is closer to where it comes down: it is his.
    s.ball.lastTouch = by.i;
    const mate = s.players.find((m) => m.team === 0 && m.i !== p.i && m.role !== 'GK')!;
    mate.stun = 0;
    mate.pos = { ...headSpot(s.ball, 2.0)!.pt };
    expect(meetHeader(s, p)).toBeNull();
  });
});

describe('report', () => {
  test('numbers', () => {
    if (!process.env.HEADERS_REPORT) return;
    const list = scenes(120);
    let out = '';
    for (const band of [[0, 1.5], [1.5, 3], [3, 5], [5, 8], [0, 8]] as [number, number][]) {
      const cpu = headed(list, false, 'drop', band);
      const row = [`r ${band[0]}-${band[1]} m (n=${cpu.n}): cpu ${cpu.heads}`];
      for (const pt of ['drop', 'ball', 'still', 'away'] as Pointer[]) row.push(`human(${pt}) ${headed(list, true, pt, band).heads}`);
      out += row.join('  ') + '\n';
    }
    console.log(out);
    expect(true).toBe(true);
  }, 600000);
});
