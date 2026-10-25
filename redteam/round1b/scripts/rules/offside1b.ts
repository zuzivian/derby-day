import { live, clearPitch, player, MID, evs, step, PITCH_W } from './lib.ts';
function scene(attX0: number, attX1: number, label: string, lineX = 80) {
  const s = live(2, false);
  clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 1, y: MID } : { x: k < 3 ? lineX : 20, y: 10 + k * 4 }));
  const att = player(s, 0, 'ST');
  att.pos = { x: attX0, y: MID }; att.stun = 0;
  const passer = player(s, 0, 'CM');
  passer.pos = { x: 59, y: MID - 10 }; passer.stun = 0; passer.facing = { x: 1, y: 0 };
  s.ball.owner = passer.i; s.ball.pos = { x: 60, y: MID - 10 };
  s.controlled[0] = passer.i; s.ctlHold = [false, false];
  const ev0 = s.events.length;
  step(s, { cursor: { x: attX1, y: MID }, pass: true });
  console.log(label, 'receiver', s.ball.receiver, 'att', att.i, 'flag', s.offside?.players);
  for (let t = 0; t < 300 && s.phase === 'play' && s.ball.owner !== att.i; t++) {
    const k = Math.min(1, t / 40);
    att.pos = { x: attX0 + (attX1 - attX0) * k, y: MID }; att.vel = { x: 0, y: 0 };
    step(s, { cursor: att.pos });
    if (t % 20 === 0) console.log(t, 'ball', s.ball.pos.x.toFixed(2), s.ball.pos.y.toFixed(2), 'v', Math.hypot(s.ball.vel.x, s.ball.vel.y).toFixed(2), 'att', att.pos.x.toFixed(1), 'stun', att.stun, 'owner', s.ball.owner, 'ctl', s.controlled[0], 'whiff', s.ball.whiff, 'np', s.ball.noPickup[att.i]);
  }
  console.log(label, 'owner', s.ball.owner, s.phase, evs(s, ev0).join(', '));
}
scene(86, 78, 'B');
scene(80.3, 84, 'E');
