import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const N = Number(process.argv[2] ?? 80);
let late = 0, lateStopped = 0, wouldScore = 0, wasShot = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 21000 + m, ...teams(m + 6), humans: [false, false] });
  let evIdx = 0;
  while (s.phase !== 'fulltime') {
    const b = s.ball;
    let prev: any = null;
    if (s.phase === 'play' && b.owner < 0 && b.lastTouch >= 0) {
      const v = s.players[b.lastTouch];
      if (v.kickCd > 8 && s.players.some((o) => o.team !== v.team && !o.sentOff && dist(o.pos, v.pos) < 1.6)) prev = structuredClone(s);
    }
    const lastBefore = b.lastTouch;
    const shots = [s.stats[0].shots, s.stats[1].shots];
    step(s);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind !== 'foul' || !prev || e.victim !== lastBefore) continue;
      late++;
      if (s.phase !== 'restart') continue;
      lateStopped++;
      const vt = 1 - e.team;
      if (prev.stats[vt].shots < s.stats[vt].shots || (prev.ball.vel && Math.hypot(prev.ball.vel.x, prev.ball.vel.y) > 15)) wasShot++;
      const c = structuredClone(prev);
      c.players[e.player].tackleCd = 600;
      const g0 = c.goals.length;
      for (let t = 0; t < 150 && c.phase === 'play'; t++) step(c);
      if (c.goals.length > g0 && c.goals.at(-1)!.team === vt) { wouldScore++; if (ex.length < 6) ex.push(`m${m} t${e.tick} ${e.severity}`); }
    }
  }
}
console.log({ matches: N, lateFoulsOnPlayerWhoJustPlayedIt: late, playStopped: lateStopped, ballWasAFastKick: wasShot, goalWouldHaveFollowed: wouldScore }); console.log(ex);
