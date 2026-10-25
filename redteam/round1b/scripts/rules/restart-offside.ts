import { PITCH_W, PITCH_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { live, clearPitch } from './lib.ts';
const MID = PITCH_H / 2;
for (const kind of ['goalkick', 'throwin', 'corner', 'freekick'] as const) {
  const s = live(8); clearPitch(s); for (const p of s.players) p.stun = 0;
  const at = kind === 'goalkick' ? { x: -1, y: MID + 8 } : kind === 'throwin' ? { x: 80, y: -1 } : kind === 'corner' ? { x: PITCH_W + 1, y: -1 } : { x: 66, y: 20 };
  awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
  const r = s.restart!; const runner = s.players.find((p) => p.team === 0 && p.i !== r.taker && p.role === 'FWD')!;
  const recv = kind === 'goalkick' ? { x: 62, y: 36 } : kind === 'throwin' ? { x: 92, y: 10 } : kind === 'corner' ? { x: 100, y: 30 } : { x: 86, y: 24 };
  for (const p of s.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: kind === 'goalkick' ? 55 : kind === 'corner' ? 96 : 75, y: 40 + p.slot * 2 }; else if (p.team === 1) p.pos = { x: PITCH_W - 1, y: MID + 3 };
  runner.pos = { ...recv }; runner.vel = { x: 0, y: 0 };
  for (const p of s.players) if (p.i !== runner.i && p.i !== r.taker) p.stun = 100000;
  const ev0 = s.events.length;
  const offPos = inOffsidePosition(s, runner, s.ball.pos.x);
  step(s, kind === 'goalkick' ? { cursor: recv, aim: recv, loft: 0.75 } : { cursor: recv, aim: recv, pass: true });
  for (let t = 0; t < 400 && s.ball.owner !== runner.i && s.phase === 'play'; t++) { runner.pos = { ...recv }; runner.vel = { x: 0, y: 0 }; step(s, {}); }
  const off = s.events.slice(ev0).find((e) => e.kind === 'offside');
  console.log(`${kind}: receiver beyond the second-last defender (offside position at the kick: ${offPos}); received=${s.ball.owner === runner.i} -> ${off ? 'OFFSIDE given' : 'no offside'}`);
}
