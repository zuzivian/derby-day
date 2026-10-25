// A scripted human plays whole matches with click passes to a team-mate in a chosen distance band,
// open or not, and we bucket completion by distance and by how marked the receiver/lane was.
import { createMatch, step, teams, dist, len, fmt, type HumanInput, type MatchState, type Vec } from './lib.ts';
import { distToSegment } from '/tmp/rt/controls/repo/src/sim/vec.ts';

type Rec = { d: number; marked: boolean; lane: boolean; ok: boolean; air: boolean; t: number; bounced: boolean; intercepted: boolean };
const recs: Rec[] = [];
const bands = [[5, 11], [11, 19], [19, 30], [30, 42]] as const;

for (let m = 0; m < 12; m++) {
  const s = createMatch({ seed: 100 + m, ...teams(20 + m), halfSeconds: 90, humans: [true, false] });
  let wait = 0;
  let pending: (Rec & { tick: number; to: number }) | null = null;
  let cursor: Vec = { x: 50, y: 34 };
  let band = 0;
  while (s.phase !== 'fulltime') {
    const me = s.players[s.controlled[0]];
    const b = s.ball;
    const input: HumanInput = { cursor };
    if (s.phase === 'play' && b.owner === me.i && !b.inHands) {
      if (wait === 0) wait = 10;
      if (--wait === 0) {
        const [lo, hi] = bands[band % bands.length];
        const cands = s.players.filter((t) => t.team === 0 && t.i !== me.i && t.role !== 'GK' && !t.sentOff && dist(t.pos, me.pos) >= lo && dist(t.pos, me.pos) < hi);
        // Prefer forward-ish, like a human would.
        cands.sort((x, y) => y.pos.x - x.pos.x);
        const t = cands[0];
        if (t) {
          band++;
          cursor = { ...t.pos };
          const marked = s.players.some((o) => o.team === 1 && !o.sentOff && dist(o.pos, t.pos) < 3);
          const lane = s.players.some((o) => o.team === 1 && !o.sentOff && distToSegment(o.pos, me.pos, t.pos) < 2.5 && dist(o.pos, t.pos) > 1);
          Object.assign(input, { cursor, aim: cursor, pass: true, moved: true });
          pending = { tick: s.tick, to: t.i, d: dist(t.pos, me.pos), marked, lane, ok: false, air: false, t: 0, bounced: false, intercepted: false };
        } else wait = 4;
      }
    } else if (s.phase === 'play' && b.owner >= 0 && s.players[b.owner].team === 1) {
      cursor = { ...b.pos };
      Object.assign(input, { cursor, moved: true });
    } else if (s.phase === 'play' && b.owner >= 0 && b.inHands && s.players[b.owner].team === 0) {
      // Our keeper: roll it to the nearest outfielder after a second.
      if ((b.handTicks ?? 0) === 60) {
        const t = s.players.filter((q) => q.team === 0 && q.role !== 'GK').sort((x, y) => dist(x.pos, b.pos) - dist(y.pos, b.pos))[0];
        cursor = { ...t.pos };
        Object.assign(input, { cursor, aim: cursor, pass: true, moved: true });
      }
    } else if (s.phase === 'restart' && s.restart && s.restart.team === 0 && s.restart.stage === 'ready' && s.restart.ticks === 30) {
      const tk = s.players[s.restart.taker];
      const t = s.players.filter((q) => q.team === 0 && q.i !== tk.i && q.role !== 'GK').sort((x, y) => dist(x.pos, tk.pos) - dist(y.pos, tk.pos))[0];
      cursor = { ...t.pos };
      Object.assign(input, { cursor, aim: cursor, pass: true, moved: true });
    }
    const prevRecv = s.ball.receiver;
    step(s, input);
    if (pending && s.tick > pending.tick + 1) {
      if (s.ball.z > 0.05) pending.air = true;
      if (prevRecv === pending.to && s.ball.receiver === -1 && s.ball.owner < 0 && s.ball.lastTouch === pending.to) pending.bounced = true;
      if (s.phase !== 'play' || s.ball.owner >= 0) {
        pending.ok = s.phase === 'play' && s.players[s.ball.owner].team === 0;
        pending.intercepted = s.phase === 'play' && s.players[s.ball.owner].team === 1;
        pending.t = (s.tick - pending.tick) / 60;
        recs.push(pending);
        pending = null;
      }
    }
  }
}

console.log(`${recs.length} click passes`);
for (const [lo, hi] of bands) {
  for (const cond of ['open', 'receiver marked (<3m)', 'opponent near lane (<2.5m)'] as const) {
    const r = recs.filter((x) => x.d >= lo && x.d < hi && (cond === 'open' ? !x.marked && !x.lane : cond.startsWith('receiver') ? x.marked : x.lane));
    if (!r.length) continue;
    const ok = r.filter((x) => x.ok);
    console.log(`${lo}-${hi} m, ${cond}: n=${r.length}, completed ${fmt((100 * ok.length) / r.length, 0)}%, intercepted ${r.filter((x) => x.intercepted).length}, bounced off receiver ${r.filter((x) => x.bounced).length}, in air ${r.filter((x) => x.air).length}, t ${fmt(ok.reduce((a, x) => a + x.t, 0) / ok.length)} s`);
  }
}
const all = recs.filter((x) => x.ok).length;
console.log(`overall completion ${fmt((100 * all) / recs.length, 0)}%`);
