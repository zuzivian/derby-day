import { live, MID, step, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { add } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const res: Record<string, number> = {};
for (let seed = 1; seed <= 60; seed++) {
  const s = live(seed);
  awardRestart(s, 'goalkick', 0, { x: -1, y: seed % 2 ? MID - 8 : MID + 8 }, 'out', true);
  toReady(s);
  const r = s.restart!; const gk = s.players[r.taker];
  const len = 4 + (seed % 5);
  // into space straight ahead, away from teammates
  const aim = add(r.spot, { x: len, y: 0 });
  step(s, { cursor: aim, aim, pass: true, moved: true });
  if (s.ball.receiver >= 0) { res['went to a teammate (assist)'] = (res['went to a teammate (assist)'] ?? 0) + 1; continue; }
  let k = 'other';
  for (let t = 0; t < 300 && s.phase === 'play'; t++) {
    step(s, { cursor: { x: 40, y: 30 }, moved: t < 10 });
    if (s.ball.lastTouch !== gk.i && s.ball.lastTouch >= 0) { k = s.players[s.ball.lastTouch].team === 0 ? 'a teammate got it' : 'an opponent got it'; break; }
    if (s.ball.owner === gk.i) { k = s.ball.inHands ? 'KEEPER PICKED IT UP AGAIN (hands)' : 'keeper took it again (feet)'; break; }
  }
  res[k] = (res[k] ?? 0) + 1;
}
console.log('human goal kick tapped 4-8 m into space, live CPU players:', res);
