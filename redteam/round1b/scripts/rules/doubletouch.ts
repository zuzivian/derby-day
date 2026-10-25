// Law 13/15/16/17/14: the taker must not touch the ball again before another player does.
import { live, MID, evs, step, PITCH_W, PITCH_H, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { add, norm, scale, sub, dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import type { RestartKind } from '/tmp/rt/rules/repo/src/sim/types.ts';

function selfPass(kind: RestartKind, at: { x: number; y: number }, aimOff: { x: number; y: number }, label: string) {
  const s = live(6);
  awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
  toReady(s);
  const r = s.restart!;
  const taker = s.players[r.taker];
  const ev0 = s.events.length;
  const aim = add(r.spot, aimOff);
  // a click to empty grass a few metres ahead (ground pass; a throw for a throw-in)
  step(s, { cursor: aim, aim, pass: true, moved: true });
  const t0 = s.tick;
  let touchedByOther = false;
  let retouchTick = -1;
  for (let t = 0; t < 240 && s.phase === 'play'; t++) {
    // chase the ball with the taker
    const c = add(s.ball.pos, scale(norm(s.ball.vel), 0.5));
    step(s, { cursor: c, moved: true });
    const lt = s.ball.lastTouch;
    if (lt !== taker.i && lt >= 0) { touchedByOther = true; break; }
    if (s.ball.owner === taker.i) { retouchTick = s.tick; break; }
  }
  console.log(`${label}: taker ${taker.i} ${s.ball.owner === taker.i ? `HAS THE BALL AGAIN ${((retouchTick - t0) / 60).toFixed(2)} s after taking it, no other touch` : touchedByOther ? 'someone else touched it first' : 'never got it'}; phase ${s.phase}; events after: ${evs(s, ev0).filter((e) => !e.includes('restartTaken')).join(', ') || 'none (no IFK for the second touch)'}`);
}
selfPass('freekick', { x: 60, y: 20 }, { x: 5, y: 0 }, 'Free kick, 5 m tap forward');
selfPass('throwin', { x: 60, y: -1 }, { x: 4, y: 3 }, 'Throw-in, 5 m throw down the line');
selfPass('corner', { x: PITCH_W + 1, y: -1 }, { x: -6, y: 1 }, 'Corner, 6 m along the byline');
selfPass('goalkick', { x: 0 - 1, y: MID - 8 }, { x: 8, y: 0 }, 'Goal kick (keeper), 8 m tap');
