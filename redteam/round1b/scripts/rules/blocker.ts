// A human defender who slides in to block whenever a CPU attacker has the ball within 25 m of goal, 4 m from him.
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { dist, add, scale } from '/tmp/rt/rules/repo/src/sim/vec.ts';
const N = Number(process.argv[2] ?? 20);
let fouls = 0, late = 0, lateStop = 0, lateDogsoRed = 0, slides = 0, shotsAgainst = 0;
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 600 + m, ...teams(m + 2), humanTeam: 0 });
  let evIdx = s.events.length;
  let lastOwner = -1;
  while (s.phase !== 'fulltime') {
    const me = s.players[s.controlled[0]];
    const b = s.ball;
    const owner = b.owner >= 0 ? s.players[b.owner] : null;
    const tgt = owner && owner.team === 1 ? owner : b.owner < 0 && b.lastTouch >= 0 && s.players[b.lastTouch].team === 1 ? s.players[b.lastTouch] : null;
    let input: any = { cursor: { ...b.pos }, moved: true };
    if (tgt && me && tgt.pos.x < 25 && dist(me.pos, tgt.pos) < 4 && me.tackleCd === 0) { input = { cursor: { ...tgt.pos }, tackle: true, moved: true }; slides++; }
    else if (owner && owner.team === 0) input = { cursor: { x: owner.pos.x + 6, y: owner.pos.y }, pass: Math.random() < 0.02, moved: true };
    const loose = b.owner < 0, lt = b.lastTouch, kc = lt >= 0 ? s.players[lt].kickCd : 0;
    step(s, input);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind === 'foul' && e.team === 0) {
        fouls++;
        if (loose && e.victim === lt && kc > 8) {
          late++;
          if (s.phase === 'restart') lateStop++;
          if (s.cards.some((c) => c.tick === e.tick && c.color === 'red' && c.reason === 'dogso')) lateDogsoRed++;
        }
      }
    }
  }
  shotsAgainst += s.stats[1].shots;
}
console.log({ matches: N, slideAttemptsInOwnThird: slides, cpuShots: shotsAgainst, humanFouls: fouls, lateFoulsOnPlayerWhoHadJustKicked: late, ofThoseWhistledStoppingPlay: lateStop, dogsoRedForThem: lateDogsoRed });
