import { PITCH_W, PITCH_H } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
import { live, clearPitch } from './lib.ts';
const MID = PITCH_H / 2;
const s = live(8); clearPitch(s); for (const p of s.players) p.stun = 0;
awardRestart(s, 'throwin', 0, { x: 80, y: -1 }, 'out', true);
for (let t = 0; t < 600 && s.restart && s.restart.stage !== 'ready'; t++) step(s, {});
const r = s.restart!; console.log(r, 'controlled', s.controlled, 'taker', r.taker);
const runner = s.players.find((p) => p.team === 0 && p.i !== r.taker && p.role === 'FWD')!;
const recv = { x: 92, y: 10 }; runner.pos = { ...recv }; runner.vel = { x: 0, y: 0 };
for (const p of s.players) if (p.i !== runner.i && p.i !== r.taker) p.stun = 100000;
const ev0 = s.events.length;
step(s, { cursor: recv, aim: recv, pass: true });
console.log('after kick', s.phase, s.restart?.stage, s.ball.pos, s.ball.vel, s.ball.z, s.ball.owner);
for (let t = 0; t < 120 && s.phase === 'play'; t++) { runner.pos = { ...recv }; step(s, {}); if (t % 10 === 0) console.log(t, s.ball.pos, s.ball.z.toFixed(2), s.ball.owner, s.ball.noPickup[runner.i]); }
console.log(s.events.slice(ev0).map((e) => e.kind + ':' + (e as any).restart));
