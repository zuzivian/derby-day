import { live, MID, evs, step, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { add } from '/tmp/rt/rules/repo/src/sim/vec.ts';
for (const [kind, at] of [['goalkick', { x: -1, y: MID - 8 }], ['freekick', { x: 9, y: MID + 4 }]] as const) {
  for (const len of [4, 7, 10]) {
    const s = live(6);
    awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
    toReady(s);
    const r = s.restart!;
    const gk = s.players[r.taker];
    const ev0 = s.events.length;
    const aim = add(r.spot, { x: len, y: 0 });
    step(s, { cursor: aim, aim, pass: true, moved: true });
    let res = 'someone else played it first';
    for (let t = 0; t < 300 && s.phase === 'play'; t++) {
      step(s, { cursor: { x: 40, y: 20 }, moved: true }); // the human looks upfield; his keeper is CPU again
      if (s.ball.lastTouch !== gk.i && s.ball.lastTouch >= 0) break;
      if (s.ball.owner === gk.i) { res = `KEEPER ${gk.role} PLAYS IT AGAIN ${s.ball.inHands ? 'WITH HIS HANDS' : 'with his feet'} ${(t / 60).toFixed(2)} s later`; break; }
    }
    console.log(`${kind} by the human's keeper, ${len} m ground pass into space: ${res}; restart events after: ${evs(s, ev0).filter((e) => !e.includes('Taken') && !e.includes('kickoff')).join(', ') || 'none'}`);
  }
}
