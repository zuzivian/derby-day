import { live, MID, evs, step, PITCH_W, PITCH_H, toReady } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { GOAL_TOP } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { add, norm, scale, sub, dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import type { RestartKind } from '/tmp/rt/rules/repo/src/sim/types.ts';

function run(kind: RestartKind, at: { x: number; y: number }, act: (spot: any) => any, label: string, freezeOthers = true) {
  const s = live(6);
  awardRestart(s, kind, 0, at, kind === 'freekick' || kind === 'penalty' ? 'foul' : 'out', true);
  toReady(s);
  const r = s.restart!;
  const taker = s.players[r.taker];
  if (freezeOthers) for (const p of s.players) if (p.i !== taker.i) { p.stun = 100000; }
  const ev0 = s.events.length;
  step(s, act(r.spot));
  const t0 = s.tick;
  let got = -1;
  for (let t = 0; t < 400 && s.phase === 'play'; t++) {
    const c = add(s.ball.pos, scale(norm(s.ball.vel), 0.4));
    s.controlled[0] = taker.i; // keep steering the taker
    step(s, { cursor: c, moved: true });
    if (s.ball.lastTouch !== taker.i && s.ball.lastTouch >= 0) break;
    if (s.ball.owner === taker.i) { got = s.tick; break; }
  }
  console.log(`${label}: ${got > 0 ? `taker has it again ${((got - t0) / 60).toFixed(2)} s later, nobody else touched it` : `no retouch (lastTouch ${s.ball.lastTouch})`}; phase ${s.phase}; events: ${evs(s, ev0).filter((e) => !e.includes('Taken')).join(', ') || 'none'}`);
}
run('freekick', { x: 60, y: 20 }, (sp) => ({ cursor: add(sp, { x: 4, y: 0 }), pass: true, moved: true }), 'Free kick tapped 4 m into space');
run('throwin', { x: 60, y: -1 }, (sp) => ({ cursor: add(sp, { x: 3, y: 2 }), pass: true, moved: true }), 'Throw-in 3.6 m');
run('corner', { x: PITCH_W + 1, y: -1 }, (sp) => ({ cursor: add(sp, { x: -4, y: 2 }), pass: true, moved: true }), 'Corner 4.5 m');
run('penalty', { x: PITCH_W - 9, y: MID }, (sp) => ({ cursor: { x: PITCH_W, y: GOAL_TOP - 0.05 }, shoot: 0.35, moved: true }), 'Penalty at the post');
