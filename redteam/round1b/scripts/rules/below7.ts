import { live, step } from './lib.ts';
import { issueCard, awardRestart } from '/tmp/rt/rules/repo/src/sim/rules.ts';
for (const k of [5, 10, 11]) {
  const s = live(3, false);
  const home = s.players.filter((p) => p.team === 0);
  // send off outfielders first, keeper last
  const order = [...home.filter((p) => p.role !== 'GK'), ...home.filter((p) => p.role === 'GK')];
  let err = '';
  try {
    for (let i = 0; i < k; i++) issueCard(s, order[i], 'red', 'excessive');
    for (let t = 0; t < 3000 && s.phase !== 'fulltime'; t++) step(s, { cursor: { x: 60, y: 30 } });
    awardRestart(s, 'throwin', 0, { x: 50, y: -1 }, 'out');
    for (let t = 0; t < 600 && s.phase !== 'fulltime'; t++) step(s, { cursor: { x: 60, y: 30 } });
  } catch (e) { err = String(e).split('\n')[0]; }
  console.log(`${k} home players sent off -> ${11 - k} left: phase ${s.phase}, tick ${s.tick}, abandoned: no such state${err ? ', THREW: ' + err : ''}`);
}
