import { PITCH_W, PITCH_H, BOX_DEPTH } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { inOwnBox } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { live, clearPitch, player } from './lib.ts';
const MID = PITCH_H / 2;
// G1 back-pass: home CB passes to his own keeper (CPU side so no human control changes)
{
  const s = live(4, true); clearPitch(s);
  const gk = player(s, 0, 'GK'); const cb = player(s, 0, 'CB');
  gk.pos = { x: 4, y: MID }; gk.stun = 0; gk.vel = { x: 0, y: 0 };
  const b = s.ball; b.owner = -1; b.pos = { x: 20, y: MID }; b.vel = { x: -9, y: 0 }; b.z = 0; b.vz = 0; b.lastTouch = cb.i; b.kickedBy = cb.i; b.receiver = gk.i; b.setPiece = null;
  for (let t = 0; t < 200 && s.ball.owner < 0 && s.phase === 'play'; t++) step(s);
  console.log(`G1 back-pass kicked by a teammate: keeper ${s.ball.owner === gk.i ? 'has it' : 'does not have it'}, in his hands=${s.ball.inHands} (Law 12: must not handle)`);
}
// G2 same ball, last kicked by an opponent: he may handle
{
  const s = live(4, true); clearPitch(s);
  const gk = player(s, 0, 'GK'); const st = player(s, 1, 'ST');
  gk.pos = { x: 4, y: MID }; gk.stun = 0; gk.vel = { x: 0, y: 0 };
  const b = s.ball; b.owner = -1; b.pos = { x: 20, y: MID }; b.vel = { x: -9, y: 0 }; b.z = 0; b.vz = 0; b.lastTouch = st.i; b.kickedBy = st.i; b.receiver = -1; b.setPiece = null;
  for (let t = 0; t < 200 && s.ball.owner < 0 && s.phase === 'play'; t++) step(s);
  console.log(`G2 same ball from an opponent: keeper has it=${s.ball.owner === gk.i}, in his hands=${s.ball.inHands}`);
}
// G3 keeper standing just inside his area (16.3 m), ball crossing in front of him 0.7 m outside the area
for (const [label, gx, bx] of [['G3 keeper 16.3 m out, ball passing across at 17.0 m', 16.3, 17.0], ['G3b keeper 16.4 m out, ball passing across at 17.2 m', 16.4, 17.2], ['G3c keeper 15.0 m out, ball passing across at 15.6 m (inside)', 15.0, 15.6]] as const) {
  const s = live(4, true); clearPitch(s);
  const gk = player(s, 0, 'GK'); const st = player(s, 1, 'ST');
  gk.pos = { x: gx, y: MID }; gk.stun = 0; gk.vel = { x: 0, y: 0 };
  const b = s.ball; b.owner = -1; b.pos = { x: bx, y: MID - 1.6 }; b.vel = { x: 0, y: 9 }; b.z = 0; b.vz = 0; b.lastTouch = st.i; b.kickedBy = st.i; b.receiver = -1; b.setPiece = null;
  let caughtAt: any = null;
  for (let t = 0; t < 200 && s.phase === "play"; t++) { const p0 = { ...b.pos }; gk.pos = { x: gx, y: MID }; gk.vel = { x: 0, y: 0 }; step(s); if (b.owner === gk.i && b.inHands && !caughtAt) { caughtAt = p0; break; } }
  console.log(`${label}: keeper inside his area=${inOwnBox(0, gk.pos)}; ${caughtAt ? `CAUGHT IN HIS HANDS with the ball at x=${caughtAt.x.toFixed(2)} (area ends at ${BOX_DEPTH}), ball inside the area=${inOwnBox(0, caughtAt)}` : 'did not handle it'}; events: ${s.events.slice(-2).map((e) => e.kind).join(',')}`);
}
