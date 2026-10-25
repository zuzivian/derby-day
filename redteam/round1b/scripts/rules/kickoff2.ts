import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams, MID, PITCH_W, evs } from './lib.ts';
for (const seed of [3, 4, 5, 6, 7, 8]) {
  const s = createMatch({ seed, ...teams(7), humanTeam: 0 });
  while (s.phase === 'kickoff') step(s);
  const taker = s.ball.owner;
  const t0 = s.tick;
  let lost = -1; let maxX = 0;
  for (let t = 0; t < 900 && s.phase === 'play'; t++) {
    const me = s.players[s.controlled[0]];
    step(s, { cursor: { x: me.pos.x + 12, y: MID + (me.pos.y < MID ? 2 : -2) }, moved: true });
    if (s.ball.owner === taker) maxX = Math.max(maxX, s.players[taker].pos.x);
    if (lost < 0 && s.ball.owner !== taker) lost = s.tick;
  }
  console.log(`seed ${seed}: taker kept it ${((lost - t0) / 60).toFixed(2)} s, carried to x=${maxX.toFixed(1)} (${(maxX - PITCH_W / 2).toFixed(1)} m past halfway); events: ${evs(s).filter((e) => !e.includes('kickoff')).slice(0, 6).join(' | ')}`);
}
