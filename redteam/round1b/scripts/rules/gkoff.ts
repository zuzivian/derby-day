// No offside straight from a goal kick or a corner (Law 11).
import { live, clearPitch, MID, evs, step, PITCH_W, toReady, player } from './lib.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
for (const kind of ['goalkick', 'freekick'] as const) {
  const s = live(8);
  awardRestart(s, kind, 0, kind === 'goalkick' ? { x: -1, y: MID - 8 } : { x: 30, y: MID }, kind === 'goalkick' ? 'out' : 'foul', true);
  toReady(s);
  const r = s.restart!;
  for (const p of s.players) if (p.i !== r.taker) { p.stun = 100000; }
  const opp = s.players.filter((p) => p.team === 1);
  opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 1, y: MID } : { x: 55, y: 10 + k * 5 }));
  const st = player(s, 0, 'ST'); st.pos = { x: 70, y: MID }; st.stun = 0;
  const ev0 = s.events.length;
  step(s, { cursor: { x: 70, y: MID }, aim: { x: 70, y: MID }, shoot: 0.9, moved: true }); // the keeper's long kick / a long free kick at the striker
  const flagged = s.offside?.players.includes(st.i) ?? false;
  for (let t = 0; t < 400 && s.phase === 'play' && s.ball.lastTouch === r.taker; t++) { st.pos = { ...s.ball.pos }; step(s, {}); }
  console.log(`${kind}: striker 15 m beyond the last defender; flagged at the kick: ${flagged}; ${evs(s, ev0).filter((e) => !e.includes('Taken')).join(', ') || 'no offside, play on'}`);
}
