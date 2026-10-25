// Law 12.2: a keeper may not handle the ball again after releasing it, before another player touches it.
// Human keeper with the ball: roll it 4 m into space, look upfield, see whether the keeper picks it up again (repeatedly).
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams, MID } from './lib.ts';
import { add } from '/tmp/rt/rules/repo/src/sim/vec.ts';
let trials = 0, recaught = 0, maxChain = 0, totalHeldS = 0;
for (let seed = 1; seed <= 40; seed++) {
  const s = createMatch({ seed, ...teams(seed + 3), humanTeam: 0 });
  while (s.phase !== 'play') step(s);
  for (let t = 0; t < 600; t++) step(s, { cursor: { ...s.ball.pos } });
  if (s.phase !== 'play') continue;
  const gk = s.players.find((p) => p.team === 0 && p.role === 'GK')!;
  // give the keeper the ball in his hands (as after a catch)
  const b = s.ball; gk.pos = { x: 6, y: MID }; gk.stun = 0; gk.dive = null;
  b.owner = gk.i; b.inHands = true; b.handTicks = 0; b.pos = { x: 6.9, y: MID }; b.lastTouch = gk.i; b.kickedBy = -1; b.receiver = -1; b.z = 1.1;
  s.controlled[0] = gk.i; s.ctlHold = [false, false];
  let chain = 0; trials++;
  const t0 = s.tick; let held = 0;
  for (let k = 0; k < 8; k++) {
    // wait 4 s holding, then roll it 4 m straight ahead into space
    for (let t = 0; t < 240 && b.owner === gk.i && s.phase === 'play'; t++) { step(s, { cursor: { ...gk.pos } }); held++; }
    if (b.owner !== gk.i || s.phase !== 'play') break;
    const aim = add(gk.pos, { x: 4, y: 0 });
    step(s, { cursor: aim, aim, pass: true, moved: true });
    let again = false;
    for (let t = 0; t < 240 && s.phase === 'play'; t++) {
      step(s, { cursor: { x: 50, y: 20 }, moved: t < 10 });
      if (b.lastTouch !== gk.i && b.lastTouch >= 0) break;
      if (b.owner === gk.i && b.inHands) { again = true; break; }
    }
    if (!again) break;
    chain++;
  }
  if (chain > 0) recaught++;
  maxChain = Math.max(maxChain, chain);
  totalHeldS += held / 60;
}
console.log(`${trials} trials: the keeper rolled it out and picked it up again himself (no IFK) in ${recaught}; longest chain ${maxChain} re-catches in a row`);
