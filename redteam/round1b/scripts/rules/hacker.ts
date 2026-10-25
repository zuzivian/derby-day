// A human who slides in on every opponent carrier from up to 6 m: how many fouls, cards, reds?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 10);
let tot = { fouls: 0, yellows: 0, reds: 0, minOnPitch: 11, below7: 0, matches: 0 };
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 5000 + m, ...teams(m + 41), humanTeam: 0 });
  let min = 11;
  while (s.phase !== 'fulltime') {
    const me = s.players[s.controlled[0]];
    const b = s.ball; const owner = b.owner >= 0 ? s.players[b.owner] : null;
    let input: any = { cursor: { ...b.pos }, moved: true };
    if (owner && owner.team === 1 && me && dist(me.pos, owner.pos) < 6) input.tackle = true;
    if (owner && owner.team === 0) input = { cursor: { x: 105, y: 34 }, moved: true, ...(s.tick % 40 === 0 ? { shoot: 0.6 } : {}) };
    step(s, input);
    const on = s.players.filter((p) => p.team === 0 && !p.sentOff).length; min = Math.min(min, on);
  }
  tot.fouls += s.stats[0].fouls; tot.yellows += s.stats[0].yellows; tot.reds += s.stats[0].reds; tot.minOnPitch = Math.min(tot.minOnPitch, min); if (min < 7) tot.below7++; tot.matches++;
  console.log(`match ${m}: fouls ${s.stats[0].fouls}, yellows ${s.stats[0].yellows}, reds ${s.stats[0].reds}, fewest home players on the pitch ${min}, score ${s.score.join('-')}, phase ${s.phase}`);
}
console.log(tot);
