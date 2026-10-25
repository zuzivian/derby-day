import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { dist } from '/tmp/rt/rules/repo/src/sim/vec.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 10); const R = Number(process.argv[3] ?? 6);
const reasons: Record<string, number> = {}; let fouls = 0, below7 = 0, minAll = 11, reds = 0;
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 5000 + m, ...teams(m + 41), humanTeam: 0 });
  let min = 11;
  while (s.phase !== 'fulltime') {
    const me = s.players[s.controlled[0]]; const b = s.ball; const owner = b.owner >= 0 ? s.players[b.owner] : null;
    let input: any = { cursor: { ...b.pos }, moved: true };
    if (owner && owner.team === 1 && me && dist(me.pos, owner.pos) < R) input.tackle = true;
    if (owner && owner.team === 0) input = { cursor: { x: 105, y: 34 }, moved: true, ...(s.tick % 40 === 0 ? { shoot: 0.6 } : {}) };
    step(s, input);
    min = Math.min(min, s.players.filter((p) => p.team === 0 && !p.sentOff).length);
  }
  for (const c of s.cards) if (c.team === 0) { const k = `${c.color}:${c.reason}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  fouls += s.stats[0].fouls; reds += s.stats[0].reds; if (min < 7) below7++; minAll = Math.min(minAll, min);
}
console.log({ tackleRange: R, matches: N, fouls, reds, matchesBelow7: below7, fewestOnPitch: minAll, cards: reasons });
