import { live, clearPitch, MID, evs, step, PITCH_W, player } from './lib.ts';
const res: Record<string, Record<string, number>> = {};
for (const kicked of [true, false]) {
  const key = kicked ? 'headed back (kickedBy = defender)' : 'same ball, kickedBy = -1';
  res[key] = {};
  for (let i = 0; i < 40; i++) {
    const s = live(3 + i, true);
    clearPitch(s);
    const gk = player(s, 1, 'GK'); gk.pos = { x: PITCH_W - 3, y: MID + (i % 5) - 2 }; gk.stun = 0;
    const cb = player(s, 1, 'CB'); cb.pos = { x: PITCH_W - 14, y: MID };
    const b = s.ball;
    b.owner = -1; b.receiver = -1; b.pos = { x: PITCH_W - 13.5, y: MID + ((i * 7) % 5) - 2 }; b.vel = { x: 8 + (i % 4), y: ((i % 3) - 1) * 0.6 }; b.z = 1.8; b.vz = 1.5;
    b.lastTouch = cb.i; b.kickedBy = kicked ? cb.i : -1; b.setPiece = null; b.redirectedAt = s.tick;
    let out = 'other';
    for (let t = 0; t < 200 && s.phase === 'play'; t++) { step(s); if (b.owner === gk.i) { out = b.inHands ? 'keeper catches' : 'keeper at feet'; break; } }
    if (out === 'other') out = s.phase === 'goal' ? 'OWN GOAL' : s.phase === 'restart' ? 'restart:' + s.restart!.kind : `loose (lastTouch ${b.lastTouch === gk.i ? 'gk' : b.lastTouch})`;
    res[key][out] = (res[key][out] ?? 0) + 1;
  }
}
console.log(res);
