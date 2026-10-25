import { PITCH_W, PITCH_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { live, clearPitch } from './lib.ts';
const MID = PITCH_H / 2;
for (const kind of ['goalkick', 'throwin', 'freekick'] as const) {
  const s = live(8); clearPitch(s); for (const p of s.players) p.stun = 0;
  const at = kind === 'goalkick' ? { x: -1, y: MID + 8 } : kind === 'throwin' ? { x: 80, y: -1 } : { x: 66, y: 20 };
  awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
  const r = s.restart!; const runner = s.players.find((p) => p.team === 0 && p.i !== r.taker && p.role === 'FWD')!;
  const recv = kind === 'goalkick' ? { x: 62, y: 36 } : kind === 'throwin' ? { x: 92, y: 10 } : { x: 86, y: 24 };
  for (const p of s.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: kind === 'goalkick' ? 55 : 75, y: 40 + p.slot * 2 }; else if (p.team === 1) p.pos = { x: PITCH_W - 1, y: MID + 3 };
  runner.pos = { ...recv }; runner.vel = { x: 0, y: 0 };
  for (const p of s.players) if (p.i !== runner.i && p.i !== r.taker) p.stun = 100000;
  const ev0 = s.events.length;
  const offPos = inOffsidePosition(s, runner, s.ball.pos.x);
  step(s, kind === 'goalkick' ? { cursor: recv, aim: recv, loft: 0.75 } : { cursor: recv, aim: recv, pass: true });
  const flaggedAfterKick = s.offside?.players.includes(runner.i) ?? false;
  let touchedIt = false;
  for (let t = 0; t < 400 && s.phase === 'play'; t++) {
    if (s.ball.z < 0.45 && t > 5) { runner.pos = { x: s.ball.pos.x + s.ball.vel.x / 60 * 2, y: s.ball.pos.y + s.ball.vel.y / 60 * 2 }; runner.vel = { x: 0, y: 0 }; }
    const lt = s.ball.lastTouch; step(s, {});
    if (s.ball.lastTouch === runner.i && lt !== runner.i) { touchedIt = true; break; }
  }
  const off = s.events.slice(ev0).find((e) => e.kind === 'offside');
  console.log(`${kind}: receiver in an offside position at the kick=${offPos}, flagged by the sim=${flaggedAfterKick}, touched the ball=${touchedIt || !!off} -> ${off ? 'OFFSIDE given' : 'no offside'}`);
}
