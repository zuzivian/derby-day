// The human's defender fouls a CPU striker late, just after the striker shot: is the goal given (advantage) or the shot cancelled?
import { live, clearPitch, MID, evs, step, player } from './lib.ts';
import { norm, scale, sub } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const tally: Record<string, number> = {}; let shown = 0;
for (let seed = 1; seed <= 200; seed++) {
  const s = live(seed, false);
  clearPitch(s);
  const st = player(s, 1, 'ST'); st.stun = 0; st.pos = { x: 22, y: MID + 2 }; st.facing = { x: -1, y: 0 }; st.kickCd = 17;
  const cb = player(s, 0, 'CB'); cb.stun = 0; cb.pos = { x: 21.2, y: MID + 2.6 }; cb.vel = { x: 0, y: 0 };
  s.controlled[0] = cb.i; s.ctlHold = [false, false];
  s.referee.pos = { x: 30, y: MID + 10 };
  const b = s.ball;
  const goal = { x: 0, y: MID - 1.5 };
  b.owner = -1; b.receiver = -1; b.pos = { x: 21.3, y: MID + 2 }; b.vel = scale(norm(sub(goal, b.pos)), 26); b.z = 0; b.vz = 0;
  b.lastTouch = st.i; b.kickedBy = st.i; b.passFrom = -1; b.setPiece = null; b.redirectedAt = s.tick;
  const ev0 = s.events.length;
  step(s, { cursor: { ...st.pos }, tackle: true, moved: true });
  let k = s.phase === 'restart' ? `whistled: ${s.restart!.kind} to the striker's side, shot cancelled` : 'play on';
  if (s.phase === 'play') { for (let t = 0; t < 120 && s.phase === 'play'; t++) step(s, {}); k += s.phase === 'goal' ? ' -> goal' : ''; }
  tally[k] = (tally[k] ?? 0) + 1;
  if (s.restart) { const c = s.cards.filter((c) => c.team === 0).map((c) => c.color + ":" + c.reason).join(",") || "no card"; tally["  card: " + c] = (tally["  card: " + c] ?? 0) + 1; }
}
console.log('200 seeds, shot from 22 m heading inside the post, keeper frozen, late tackle by the human:', tally);
