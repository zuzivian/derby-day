// A human who slides in on every carrier: how many of his side are sent off, does the match stop below 7?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { dist, sub, norm, add, scale } from '/tmp/rt/rules/repo/src/sim/vec.ts';
for (let m = 0; m < 6; m++) {
  const s = createMatch({ seed: 300 + m, ...teams(m + 2), humanTeam: 0 });
  let minAlive = 11, crashed = '';
  try {
    while (s.phase !== 'fulltime') {
      const me = s.players[s.controlled[0]];
      const b = s.ball;
      const owner = b.owner >= 0 ? s.players[b.owner] : null;
      let input: any = { cursor: { ...b.pos }, moved: true };
      if (owner && owner.team === 1 && me && dist(me.pos, owner.pos) < 4) input = { cursor: add(owner.pos, scale(owner.facing, 0.5)), tackle: true, moved: true };
      else if (owner && owner.team === 0) input = { cursor: { x: owner.pos.x + 6, y: owner.pos.y }, moved: true };
      step(s, input);
      minAlive = Math.min(minAlive, s.players.filter((p) => p.team === 0 && !p.sentOff).length);
    }
  } catch (e) { crashed = String(e); }
  const reds = s.cards.filter((c) => c.team === 0 && c.color === 'red').length;
  const yel = s.cards.filter((c) => c.team === 0 && c.color === 'yellow').length;
  console.log(`match ${m}: home fouls ${s.stats[0].fouls}, yellows ${yel}, reds ${reds}, fewest home players on the pitch ${minAlive}, score ${s.score.join('-')}, phase ${s.phase}${crashed ? ' CRASH ' + crashed : ''}`);
}
