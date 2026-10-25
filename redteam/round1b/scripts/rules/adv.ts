// What happens after the referee plays advantage?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 100);
const out: Record<string, number> = {}; const inc = (k: string) => (out[k] = (out[k] ?? 0) + 1);
const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 17000 + m, ...teams(m + 4), humans: [false, false] });
  let evIdx = 0;
  let adv: { team: 0 | 1; tick: number; shots: number; passes: number; spot: any } | null = null;
  while (s.phase !== 'fulltime') {
    step(s);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind === 'advantage') { adv = { team: e.team, tick: e.tick, shots: s.stats[e.team].shots, passes: s.stats[e.team].passes, spot: e.spot }; continue; }
      if (!adv) continue;
      if (e.kind === 'restart' && e.reason === 'foul' && e.team === adv.team && Math.abs(e.spot.x - adv.spot.x) < 0.01 && Math.abs(e.spot.y - adv.spot.y) < 0.01) {
        const shot = s.stats[adv.team].shots > adv.shots;
        const owner = s.ball.owner >= 0 ? s.players[s.ball.owner] : null;
        const k = `called back${shot ? ' AFTER A SHOT' : ''}${owner && owner.role === 'GK' ? ' (keeper has it)' : ''}`;
        inc(k);
        if (shot && ex.length < 5) ex.push(`m${m} adv t${adv.tick} back at t${e.tick} (${((e.tick - adv.tick) / 60).toFixed(2)} s), keeper owns: ${owner?.role === 'GK'}`);
        adv = null;
      } else if (e.kind === 'goal') { inc(e.team === adv.team ? 'goal for fouled side' : 'goal against'); adv = null; }
      else if (e.kind === 'restart') { inc('other stoppage: ' + e.restart); adv = null; }
    }
    if (adv && s.tick > adv.tick + 120 && !s.advantage) { inc('advantage stood (2 s passed)'); adv = null; }
  }
}
console.log(out); console.log(ex);
