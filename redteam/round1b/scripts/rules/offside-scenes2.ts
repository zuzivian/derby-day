import { PITCH_W, PITCH_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
import type { MatchState } from '/tmp/rt/rules/repo/src/sim/types.ts';
import { live, clearPitch, player } from './lib.ts';
const MID = PITCH_H / 2;
// Pass at the moment the attacker is at attX; teleport him to recvX (same y) right after the kick,
// so the ball arrives at him there. The sim must judge at the pass, not at reception.
function scene(name: string, attX: number, recvX: number, defs: number[], gkX = PITCH_W - 1) {
  const s = live(3, false); clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  let d = 0;
  for (const p of opp) { if (p.role === 'GK') p.pos = { x: gkX, y: MID }; else if (d < defs.length) { p.pos = { x: defs[d], y: MID - 16 + d * 5 }; d++; } else p.pos = { x: 20, y: 5 + p.slot * 3 }; }
  const att = player(s, 0, 'ST'); att.pos = { x: attX, y: MID + 6 };
  const passer = player(s, 0, 'CM'); passer.pos = { x: Math.min(attX, recvX) - 14, y: MID + 6 };
  s.controlled[0] = passer.i; s.ball.owner = passer.i; s.ball.pos = { x: passer.pos.x + 0.9, y: MID + 6 }; s.ball.lastTouch = passer.i; passer.facing = { x: 1, y: 0 };
  for (const p of s.players) p.stun = p.i === att.i || p.i === passer.i ? 0 : 100000;
  s.ctlHold = [false, false];
  const offAtPass = inOffsidePosition(s, att);
  const target = { x: recvX, y: MID + 6 };
  const ev0 = s.events.length;
  step(s, { cursor: target, pass: true, aim: target });
  att.pos = { ...target }; att.vel = { x: 0, y: 0 };
  const offAtRecv = inOffsidePosition(s, att);
  for (let t = 0; t < 300 && s.phase === 'play' && s.ball.owner !== att.i; t++) { att.pos = { ...target }; step(s, {}); }
  const off = s.events.slice(ev0).find((e) => e.kind === 'offside');
  console.log(`${name}: offside position at the pass=${offAtPass}, at reception=${offAtRecv} -> ${off ? 'OFFSIDE given' : s.ball.owner === att.i ? 'received, play on' : 'not received (' + s.phase + ')'}`);
}
scene('O1 onside at the pass (2 m behind the line at 80), beyond it on reception', 78, 86, [80, 80, 80]);
scene('O2 offside at the pass (3 m beyond the line), back onside on reception', 83, 76, [80, 80, 80]);
scene('O3 level with the second-last defender at the pass', 80, 80, [80, 80, 80]);
scene('O4 in his own half at the pass (51 m, line at 56), beyond the line on reception', 51, 62, [56, 56, 56]);
scene('O5 keeper second-last (keeper up at 88, one defender on the line at 104), attacker at 92', 92, 92, [104], 88);
scene('O6 keeper second-last (keeper up at 88, one defender at 104), attacker at 86', 86, 86, [104], 88);
