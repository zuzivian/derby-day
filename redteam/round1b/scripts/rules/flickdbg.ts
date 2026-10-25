import { live, clearPitch, MID, step, PITCH_W, player, evs } from './lib.ts';
const s = live(5, true); clearPitch(s);
const opp = s.players.filter((p) => p.team === 1);
opp.forEach((p, k) => (p.pos = p.role === 'GK' ? { x: PITCH_W - 0.5, y: MID - 12 } : { x: k < 3 ? 90 : 60, y: 10 + k * 4 }));
const crosser = player(s, 0, 'WM');
const A = player(s, 0, 'ST', 0); A.stun = 0; A.pos = { x: 88.5, y: MID };
const b = s.ball; b.owner = -1; b.receiver = -1; b.pos = { x: 88.0, y: MID - 0.3 }; b.vel = { x: 1.5, y: 0.5 }; b.z = 2.0; b.vz = -1;
b.lastTouch = crosser.i; b.kickedBy = crosser.i; b.setPiece = null;
for (let t = 0; t < 20; t++) { step(s); console.log(t, s.phase, 'ball', b.pos.x.toFixed(2), b.pos.y.toFixed(2), 'z', b.z.toFixed(2), 'owner', b.owner, 'lt', b.lastTouch, 'kb', b.kickedBy, 'A', A.pos.x.toFixed(2), A.pos.y.toFixed(2), 'whiff', b.whiff); }
