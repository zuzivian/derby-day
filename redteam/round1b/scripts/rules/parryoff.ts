// Shot, keeper parries, the rebound falls to a teammate who was offside when the shot was struck -> offside (a save does not reset).
import { live, clearPitch, MID, step, PITCH_W, player, evs } from './lib.ts';
let given = 0, tapins = 0, n = 0;
for (let seed = 1; seed <= 120; seed++) {
  const s = live(seed, false); clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  const gk = opp.find((p) => p.role === 'GK')!;
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 1.5, y: MID } : { x: k < 3 ? 86 : 60, y: 10 + k * 4 }));
  gk.stun = 0;
  const sh = player(s, 0, 'ST', 0); sh.stun = 0; sh.pos = { x: 84, y: MID - 4 }; sh.facing = { x: 1, y: 0 };
  const B = player(s, 0, 'ST', 1); B.stun = 0; B.pos = { x: 97, y: MID + 3 };
  s.ball.owner = sh.i; s.ball.pos = { x: 84.9, y: MID - 4 }; s.controlled[0] = sh.i; s.ctlHold = [false, false];
  const ev0 = s.events.length;
  step(s, { cursor: { x: PITCH_W, y: MID - 0.3 }, shoot: 0.6, moved: true });
  const flagged = s.offside?.players.includes(B.i);
  let parried = false;
  for (let t = 0; t < 150 && s.phase === 'play'; t++) {
    step(s, { cursor: { ...s.ball.pos }, moved: true });
    if (s.ball.lastTouch === gk.i && s.ball.owner < 0) parried = true;
    if (s.ball.lastTouch === B.i || s.ball.owner === gk.i) break;
  }
  if (!parried || !flagged) continue;
  n++;
  const off = s.events.slice(ev0).some((e) => e.kind === 'offside' && e.player === B.i);
  if (off) given++; else if (s.ball.lastTouch === B.i) tapins++;
}
console.log(`parried shots with B offside at the shot: ${n}; B then played it: offside given ${given}, missed ${tapins}`);
