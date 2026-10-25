import { live, clearPitch, MID, step, PITCH_W, player, evs } from './lib.ts';
import { add, norm, scale } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
let headed = 0, called = 0, notCalled = 0, offPos = 0;
for (let seed = 1; seed <= 200; seed++) {
  const s = live(seed, true); clearPitch(s);
  const opp = s.players.filter((p) => p.team === 1);
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 0.5, y: MID - 12 } : { x: k < 3 ? 94 : 60, y: 10 + k * 4 }));
  const crosser = player(s, 0, 'WM');
  const A = player(s, 0, 'ST', 0); A.stun = 0; A.pos = { x: 93, y: MID };
  const B = player(s, 0, 'ST', 1); B.pos = { x: 99, y: MID + 6 };
  const b = s.ball; b.owner = -1; b.receiver = -1; b.pos = { x: 92.5, y: MID - 0.3 }; b.vel = { x: 1.5, y: 0.5 }; b.z = 2.2; b.vz = -1;
  b.lastTouch = crosser.i; b.kickedBy = crosser.i; b.setPiece = null; s.offside = null;
  const ev0 = s.events.length;
  let didHead = false;
  for (let t = 0; t < 20 && s.phase === 'play'; t++) { step(s); if (b.lastTouch === A.i && b.owner < 0 && b.kickedBy === A.i) { didHead = true; break; } if (b.owner >= 0) break; }
  if (!didHead) continue;
  headed++;
  const wasOff = inOffsidePosition(s, B);
  if (wasOff) offPos++;
  B.pos = add(b.pos, scale(norm(b.vel), 1.2)); B.stun = 0; B.vel = { x: 0, y: 0 };
  for (let t = 0; t < 40 && s.phase === 'play' && b.lastTouch === A.i; t++) step(s);
  const off = s.events.slice(ev0).some((e) => e.kind === 'offside');
  if (wasOff && (b.lastTouch === B.i || off)) { if (off) called++; else notCalled++; }
}
console.log(`headers at goal by A: ${headed} (B in an offside position at the header in ${offPos}); B then touched the ball: offside given ${called}, not given ${notCalled}`);
