// Offside judged at the pass, not at reception; level onside.
import { live, clearPitch, player, MID, evs, step, PITCH_W } from './lib.ts';
import { add, norm, scale } from '/tmp/rt/rules/repo/src/sim/vec.ts';
function scene(attX0: number, attX1: number, label: string, lineX = 80) {
  const s = live(2, false);
  clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 1, y: MID } : { x: k < 3 ? lineX : 20, y: 10 + k * 4 }));
  const att = player(s, 0, 'ST');
  att.pos = { x: attX0, y: MID }; att.stun = 100000;
  const passer = player(s, 0, 'CM');
  passer.pos = { x: 59, y: MID - 10 }; passer.stun = 0; passer.facing = { x: 1, y: 0 };
  s.ball.owner = passer.i; s.ball.pos = { x: 60, y: MID - 10 };
  s.controlled[0] = passer.i; s.ctlHold = [false, false];
  const ev0 = s.events.length;
  step(s, { cursor: { x: 90, y: MID + 3 }, pass: true }); // into space
  const flagged = s.offside?.players.includes(att.i) ?? false;
  for (let t = 0; t < 300 && s.phase === 'play' && s.ball.pos.x < attX1 - 2; t++) step(s, {});
  // now he arrives at x = attX1 on the ball's path
  att.pos = add(s.ball.pos, scale(norm(s.ball.vel), 1.0)); att.stun = 0; att.vel = { x: 0, y: 0 };
  const recvX = att.pos.x;
  for (let t = 0; t < 60 && s.phase === 'play' && s.ball.owner !== att.i; t++) step(s, {});
  console.log(label, `| at pass x=${attX0}, reception x=${recvX.toFixed(1)} | flagged: ${flagged} | got it: ${s.ball.owner === att.i} | phase ${s.phase} | ${evs(s, ev0).filter((e) => !e.includes('Taken')).join(', ') || 'no events'}`);
}
scene(79, 88, 'A onside at pass, beyond the line at reception');
scene(86, 78, 'B offside at pass, back onside at reception');
scene(80, 85, 'C level at pass');
scene(80.04, 85, 'D 4 cm beyond at pass');
scene(80.3, 85, 'E 30 cm beyond at pass');
