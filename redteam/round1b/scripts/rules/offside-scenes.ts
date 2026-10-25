import { PITCH_W, PITCH_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
import type { MatchState } from '/tmp/rt/rules/repo/src/sim/types.ts';
import { live, clearPitch, player } from './lib.ts';
const MID = PITCH_H / 2;
function freeze(s: MatchState, except: number[]) { for (const p of s.players) if (!except.includes(p.i)) { p.stun = 100000; p.vel = { x: 0, y: 0 }; } else p.stun = 0; }
function scene(name: string, attX: number, attVx: number, lineX: number, gkX = PITCH_W - 1) {
  const s = live(3, false); clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: gkX, y: MID } : { x: k <= 2 ? lineX : 20, y: k <= 2 ? MID - 14 + k * 9 : 5 + k * 3 }));
  const att = player(s, 0, 'ST'); att.pos = { x: attX, y: MID + 4 };
  const passer = player(s, 0, 'CM'); passer.pos = { x: 60, y: MID };
  s.controlled[0] = passer.i; s.ball.owner = passer.i; s.ball.pos = { x: 60.9, y: MID }; s.ball.lastTouch = passer.i;
  freeze(s, [att.i, passer.i]);
  s.ctlHold = [false, false];
  const offAtPass = inOffsidePosition(s, att);
  // Pass toward where the runner will be ~1.2 s later.
  const target = { x: attX + attVx * 1.2, y: MID + 4 };
  const ev0 = s.events.length;
  step(s, { cursor: target, pass: true, aim: target });
  let offAtReception: boolean | null = null; let got = false;
  for (let t = 0; t < 240 && s.phase === 'play'; t++) {
    // the runner runs at a fixed velocity (scripted run): CPU intent overwritten by setting position
    att.pos = { x: att.pos.x + attVx / 60, y: att.pos.y };
    if (s.ball.owner === att.i) { got = true; break; }
    offAtReception = inOffsidePosition(s, att);
    step(s, { cursor: target });
  }
  const off = s.events.slice(ev0).find((e) => e.kind === 'offside');
  console.log(`${name}: offside position at the pass=${offAtPass}, at reception=${offAtReception} -> ${off ? 'OFFSIDE given' : got ? 'received, play on' : 'not received (' + s.phase + ')'}`);
}
scene('O1 onside at the pass (2 m behind the line), runs beyond it to receive', 78, 6, 80);
scene('O2 offside at the pass (3 m beyond the line), drops back onside to receive', 83, -5, 80);
scene('O3 level with the second-last defender at the pass', 80, 0, 80);
scene('O4 in his own half at the pass (51 m), runs on beyond a high line at 56 m', 51, 7, 56);
scene('O5 keeper is second-last: keeper up at 88, one defender on the line at 104; attacker at 92', 92, 0, 104, 88);
// Restarts that cannot give offside: goal kick and throw-in, receiver beyond the whole defence.
for (const kind of ['goalkick', 'throwin', 'freekick'] as const) {
  const s = live(8); clearPitch(s); for (const p of s.players) p.stun = 0;
  const at = kind === 'goalkick' ? { x: -1, y: MID + 8 } : kind === 'throwin' ? { x: 80, y: -1 } : { x: 60, y: 20 };
  awardRestart(s, kind, 0, at, kind === 'freekick' ? 'foul' : 'out', true);
  for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
  const r = s.restart!; const runner = s.players.find((p) => p.team === 0 && p.i !== r.taker && p.role === 'FWD')!;
  for (const p of s.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: kind === 'goalkick' ? 55 : 70, y: 26 + p.slot }; else if (p.team === 1) p.pos = { x: PITCH_W - 1, y: MID };
  runner.pos = kind === 'goalkick' ? { x: 64, y: 30 } : kind === 'throwin' ? { x: 90, y: 8 } : { x: 85, y: 22 };
  for (const p of s.players) if (p.i !== runner.i && p.i !== r.taker) p.stun = 100000;
  const ev0 = s.events.length;
  const aimAt = { ...runner.pos };
  step(s, kind === 'goalkick' ? { cursor: aimAt, aim: aimAt, loft: 1 } : { cursor: aimAt, aim: aimAt, pass: true });
  const offPos = inOffsidePosition(s, runner, s.ball.pos.x);
  for (let t = 0; t < 400 && s.ball.owner !== runner.i && s.phase === 'play'; t++) step(s, {});
  const off = s.events.slice(ev0).find((e) => e.kind === 'offside');
  console.log(`R ${kind}: receiver beyond the defence (offside position at the kick=${offPos}); received=${s.ball.owner === runner.i} -> ${off ? 'OFFSIDE given' : 'no offside'} phase=${s.phase}`);
}
