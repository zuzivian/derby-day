// Lofted pass to a team-mate's feet, the real control flow (auto-switch on), pointer left on the landing spot.
import { loftPower, CLICK_MS, LOFT_RAMP_MS } from '/tmp/rt/controls/repo/src/client/input.ts';
import { fmt, giveBall, isolate, livePlay, step, dist, len } from './lib.ts';
const holdFor = (d: number) => CLICK_MS + Math.max(0, Math.min(1, (d - 12) / 28)) * LOFT_RAMP_MS;
for (const jiggle of [false, true]) {
  for (const d of [15, 20, 25, 30, 35]) {
    const ts: number[] = []; const overHead: number[] = []; const ctlMate: number[] = [];
    for (const ang of [-40, -20, 0, 20, 40]) for (const seed of [1, 2]) {
      const s = livePlay(seed);
      const me = s.players[s.controlled[0]];
      const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
      isolate(s, me, mate);
      giveBall(s, me, { x: 8, y: 34 });
      const a = ang * Math.PI / 180;
      mate.pos = { x: 8 + Math.cos(a) * d, y: 34 + Math.sin(a) * d }; mate.vel = { x: 0, y: 0 };
      const aim = { ...mate.pos };
      step(s, { cursor: aim, aim, loft: loftPower(holdFor(d) + 100) });
      let t = 0; let landGap = -1; let wasCtl = false;
      for (; t < 600; t++) {
        const pz = s.ball.z;
        // A human who keeps the pointer on the landing spot, nudging it (moved) or not.
        step(s, { cursor: aim, moved: jiggle && t % 2 === 0 });
        if (s.controlled[0] === mate.i) wasCtl = true;
        if (landGap < 0 && pz > 0 && s.ball.z === 0) landGap = dist(s.ball.pos, mate.pos);
        if (s.ball.owner >= 0 || s.phase !== 'play') break;
      }
      ts.push(t / 60); overHead.push(landGap); ctlMate.push(wasCtl ? 1 : 0);
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`${jiggle ? 'pointer nudged on the spot' : 'pointer still on the spot'} d=${d}: control after ${fmt(avg(ts))} s (max ${fmt(Math.max(...ts))}), first bounce ${fmt(avg(overHead), 1)} m from him, human got the receiver in ${ctlMate.filter(Boolean).length}/10`);
  }
}
