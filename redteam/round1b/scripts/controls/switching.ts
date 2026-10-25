// Auto-switching while defending: a scripted human who keeps the pointer on the ball (as people do).
// How often is he steering the man nearest the ball, how often does control change, does it ping-pong?
import { createMatch, step, teams, dist, fmt, type HumanInput, type MatchState } from './lib.ts';

let defTicks = 0;
let nearest = 0;
let within3 = 0;
let switches = 0;
let pingpong = 0;
let gapSum = 0;
let behindBall = 0;
for (let m = 0; m < 8; m++) {
  const s = createMatch({ seed: 300 + m, ...teams(40 + m), halfSeconds: 90, humans: [true, false] });
  let lastCtl = s.controlled[0];
  const hist: { tick: number; from: number; to: number }[] = [];
  while (s.phase !== 'fulltime') {
    const b = s.ball;
    const input: HumanInput = {};
    const oppHas = b.owner >= 0 && s.players[b.owner].team === 1;
    // Pointer on the ball (a defender chasing it), slightly beyond so he runs.
    const me = s.players[s.controlled[0]];
    // Goal-side of the ball: 1.5 m toward our goal (x = 0), the way a defender is taught to stand.
    const g = { x: 0 - b.pos.x, y: 34 - b.pos.y };
    const gl = Math.hypot(g.x, g.y) || 1;
    input.cursor = { x: b.pos.x + (g.x / gl) * 1.5, y: b.pos.y + (g.y / gl) * 1.5 };
    void me;
    input.moved = true;
    step(s, input);
    if (s.phase === 'play' && oppHas) {
      defTicks++;
      const ctl = s.players[s.controlled[0]];
      const outf = s.players.filter((p) => p.team === 0 && p.role !== 'GK' && !p.sentOff);
      const best = outf.reduce((a, p) => (dist(p.pos, b.pos) < dist(a.pos, b.pos) ? p : a));
      if (best.i === ctl.i) nearest++;
      const gap = dist(ctl.pos, b.pos) - dist(best.pos, b.pos);
      gapSum += gap;
      if (gap < 3) within3++;
      // Our goal is at x=0: is the controlled man goal-side of the ball?
      if (ctl.pos.x > b.pos.x + 1) behindBall++;
    }
    if (s.controlled[0] !== lastCtl) {
      if (s.phase === 'play' && oppHas) {
        switches++;
        const prev = hist[hist.length - 1];
        if (prev && prev.from === s.controlled[0] && s.tick - prev.tick < 60) pingpong++;
      }
      hist.push({ tick: s.tick, from: lastCtl, to: s.controlled[0] });
      lastCtl = s.controlled[0];
    }
  }
}
const mins = defTicks / 3600;
console.log(`defending ${fmt(mins, 1)} min: steering the nearest man ${fmt((100 * nearest) / defTicks, 0)}% of ticks, within 3 m of nearest ${fmt((100 * within3) / defTicks, 0)}%, mean extra distance ${fmt(gapSum / defTicks)} m, on the wrong side of the ball ${fmt((100 * behindBall) / defTicks, 0)}%`);
console.log(`auto switches while defending: ${switches} (${fmt(switches / mins, 1)}/min), switched back within 1 s: ${pingpong}`);
