// Law 14: after a penalty hits the post, the kicker may not play the ball again before another player touches it.
import { live, MID, evs, step, PITCH_W, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { GOAL_TOP } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { add, norm, scale } from '/tmp/rt/rules/repo/src/sim/vec.ts';
let posts = 0, retouch = 0, goals = 0; let shown = 0;
for (let seed = 1; seed <= 200; seed++) {
  const s = live(seed);
  awardRestart(s, 'penalty', 0, { x: PITCH_W - 9, y: MID }, 'foul');
  toReady(s);
  const r = s.restart!; const taker = s.players[r.taker];
  for (const p of s.players) if (p.i !== taker.i) p.stun = 100000; // everyone else stands still (keeper too)
  const gk = s.players.find((p) => p.team === 1 && p.role === 'GK')!; gk.pos = { x: PITCH_W - 0.15, y: MID + 2.5 };
  const ev0 = s.events.length;
  step(s, { cursor: { x: PITCH_W, y: GOAL_TOP - 0.02 + (seed % 7) * 0.01 }, shoot: 0.2, moved: true });
  let hitPost = false, prevV = { ...s.ball.vel };
  for (let t = 0; t < 300 && s.phase === 'play'; t++) {
    const c = add(s.ball.pos, scale(norm(s.ball.vel), 0.3));
    s.controlled[0] = taker.i;
    step(s, { cursor: c, moved: true, shoot: hitPost && s.ball.owner === taker.i ? 0.5 : undefined });
    if (!hitPost && s.ball.vel.x * prevV.x < 0 && s.ball.lastTouch === taker.i) hitPost = true;
    prevV = { ...s.ball.vel };
    if (s.ball.lastTouch !== taker.i) break;
  }
  if (!hitPost) continue;
  posts++;
  const tookAgain = s.events.slice(ev0).some((e) => e.kind === 'goal' && e.player === taker.i) || s.ball.owner === taker.i;
  if (s.phase === 'goal' || s.goals.length) goals++;
  if (tookAgain) retouch++;
  if (shown++ < 2) console.log('seed', seed, evs(s, ev0).filter((e) => !e.includes('Taken')).join(' | '));
}
console.log(`penalties off the post: ${posts}; kicker played the rebound himself: ${retouch} (no IFK); goals from it: ${goals}`);
