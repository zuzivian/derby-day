// Whole ball over the whole line (Law 9/10): ball centre beyond the line by more than its radius.
import { live, clearPitch, MID, step, PITCH_W, player, evs } from './lib.ts';
import { BALL_R, GOAL_TOP } from '/tmp/rt/rules/repo/src/sim/constants.ts';
function park(at: { x: number; y: number }, v = { x: 0, y: 0 }) {
  const s = live(3, true); clearPitch(s);
  const st = player(s, 0, 'ST');
  const b = s.ball; b.owner = -1; b.receiver = -1; b.pos = { ...at }; b.vel = v; b.z = 0; b.vz = 0; b.lastTouch = st.i; b.kickedBy = st.i; b.setPiece = null;
  const ev0 = s.events.length;
  for (let t = 0; t < 5 && s.phase === 'play'; t++) step(s);
  return `${s.phase}${s.restart ? ':' + s.restart.kind : ''}${s.phase === 'goal' ? ' GOAL' : ''}`;
}
console.log(`BALL_R ${BALL_R}`);
console.log('touchline, centre 0.10 m beyond (part of ball on the line):', park({ x: 50, y: -0.10 }));
console.log('touchline, centre 0.12 m beyond (wholly over):          ', park({ x: 50, y: -0.12 }));
console.log('goal line in the mouth, centre 0.10 m behind:            ', park({ x: PITCH_W + 0.10, y: MID }));
console.log('goal line in the mouth, centre 0.12 m behind:            ', park({ x: PITCH_W + 0.12, y: MID }));
console.log('goal line wide of the post, centre 0.12 m behind:        ', park({ x: PITCH_W + 0.12, y: GOAL_TOP - 1 }));
