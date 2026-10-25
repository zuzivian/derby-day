import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams, MID, PITCH_W } from './lib.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import { attackDir } from '/tmp/rt/rules/repo/src/sim/field.ts';
// CPU kick-offs: how long the taker keeps the ball, how far he carries it, which way the first kick goes
const carry: number[] = []; const hold: number[] = []; let back = 0, fwd = 0, n = 0;
for (let m = 0; m < 20; m++) {
  const s = createMatch({ seed: 9000 + m, ...teams(m + 2), humans: [false, false] });
  let ko: { taker: number; tick: number; team: 0 | 1 } | null = null;
  let evIdx = 0;
  while (s.phase !== 'fulltime') {
    step(s);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind === 'restartTaken' && e.restart === 'kickoff') ko = { taker: e.player, tick: e.tick, team: e.team };
    }
    if (ko && s.phase === 'play' && s.ball.owner !== ko.taker) {
      const tk = s.players[ko.taker];
      carry.push(dist(s.ball.pos, { x: PITCH_W / 2, y: MID }));
      hold.push((s.tick - ko.tick) / 60);
      n++;
      if (s.ball.vel.x * attackDir(ko.team) < 0) back++; else fwd++;
      ko = null;
    }
  }
}
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
console.log(`CPU kick-offs: ${n}; taker keeps it ${avg(hold)} s on average (max ${Math.max(...hold).toFixed(2)}), ball ${avg(carry)} m from the spot when it leaves him (max ${Math.max(...carry).toFixed(1)}); first kick backward ${back}, forward ${fwd}`);

// Human kick-off: dribble straight at goal
import { live } from './lib.ts';
const s = createMatch({ seed: 3, ...teams(7), humanTeam: 0 });
while (s.phase === 'kickoff') step(s);
const taker = s.ball.owner;
console.log('human controls taker:', s.controlled[0] === taker, 'phase', s.phase);
let t = 0;
for (; t < 600 && s.ball.owner === taker && s.phase === 'play'; t++) step(s, { cursor: { x: s.players[taker].pos.x + 12, y: MID }, moved: true });
console.log(`human dribbled the kick-off ${(s.players[taker].pos.x - PITCH_W / 2).toFixed(1)} m upfield in ${(t / 60).toFixed(2)} s without ever kicking it; owner still taker: ${s.ball.owner === taker}; events: ${s.events.filter((e) => e.kind !== 'restart' && e.kind !== 'restartTaken').map((e) => e.kind).join(',') || 'none'}`);
