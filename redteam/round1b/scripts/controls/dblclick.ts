// A quick double click on a team-mate, through the sim with the exact HumanInput sequence InputController sends.
import { fmt, giveBall, isolate, livePlay, step, dist, len } from './lib.ts';

for (const [d, gapTicks] of [[8, 5], [12, 6], [15, 8], [20, 10], [12, 12], [12, 20]] as const) {
  const s = livePlay(3);
  const me = s.players[s.controlled[0]];
  const mate = s.players.find((p) => p.team === 0 && p.role === 'MID' && p.i !== me.i)!;
  isolate(s, me, mate);
  giveBall(s, me, { x: 20, y: 34 });
  mate.pos = { x: 20 + d, y: 34 };
  mate.vel = { x: 0, y: 0 };
  const aim = { ...mate.pos };
  // Click 1: released -> pass on the next tick.
  step(s, { cursor: aim, aim, pass: true, moved: true });
  // Click 2 goes down `gapTicks` ticks later: InputController sees no ball, so it is a select with aim.
  for (let k = 1; k < gapTicks; k++) step(s, { cursor: aim });
  const ctl = s.controlled[0];
  step(s, { cursor: aim, aim, select: true });
  const q = s.queued?.[0];
  let t = 0;
  while (s.ball.owner !== mate.i && t++ < 200) step(s, { cursor: aim });
  const got = s.ball.owner === mate.i;
  step(s, { cursor: aim });
  const after = { owner: s.ball.owner, v: len(s.ball.vel), recv: s.ball.receiver };
  let t2 = 0;
  while (s.ball.owner < 0 && t2++ < 120) step(s, { cursor: aim });
  console.log(
    `pass ${d} m, 2nd press ${fmt((gapTicks * 1000) / 60, 0)} ms after release: controlled=${ctl === mate.i ? 'receiver' : ctl}, queued=${q ? q.kind + ' recv ' + q.receiver : 'none'}, received=${got}, tick after: owner ${after.owner} ball ${fmt(after.v, 1)} m/s (receiver ${after.recv}); ` +
      `ball ends ${fmt(dist(s.ball.pos, mate.pos), 1)} m from him, owner ${s.ball.owner === mate.i ? 'him' : s.ball.owner} after ${t2} ticks`,
  );
}
