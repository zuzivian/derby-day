import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
const N = Number(process.argv[2] ?? 300);
let missed = 0, given = 0, goalsAfter = 0, goals = 0; const kinds: Record<string, number> = {};
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 31000 + m, ...teams(m + 8), humans: [false, false] });
  let pending: { team: number; players: number[]; how: string } | null = null;
  let goalWatch: { team: number; until: number } | null = null;
  let ev = 0;
  while (s.phase !== 'fulltime') {
    const lt0 = s.ball.lastTouch, z0 = s.ball.z, tk0 = s.stats[0].tackles + s.stats[1].tackles, own0 = s.ball.owner;
    step(s);
    for (; ev < s.events.length; ev++) {
      const e: any = s.events[ev];
      if (e.kind === 'offside') given++;
      if (e.kind === 'goal') { goals++; if (goalWatch && goalWatch.team === e.team && s.tick <= goalWatch.until) goalsAfter++; goalWatch = null; }
    }
    const b = s.ball;
    if (s.phase !== 'play') { pending = null; continue; }
    if (b.lastTouch !== lt0 && b.lastTouch >= 0) {
      const p = s.players[b.lastTouch];
      if (pending && pending.team === p.team && pending.players.includes(p.i)) { missed++; kinds[pending.how] = (kinds[pending.how] ?? 0) + 1; goalWatch = { team: p.team, until: s.tick + 600 }; }
      pending = null;
      const kicked = s.offside && s.offside.tick === s.tick;
      if (!kicked && b.owner < 0) {
        const flagged = s.players.filter((m) => m.team === p.team && m.i !== p.i && !m.sentOff && inOffsidePosition(s, m)).map((m) => m.i);
        const how = s.stats[0].tackles + s.stats[1].tackles > tk0 ? 'tackle' : z0 > 1.5 ? 'header' : 'deflection';
        if (flagged.length) pending = { team: p.team, players: flagged, how };
      }
    }
  }
}
console.log(`${N} CPU matches: ${goals} goals, offsides given ${given}; missed (offside when a teammate touched it, then played it) ${missed}`, kinds, `; goals by that side within 10 s of a missed one: ${goalsAfter}`);
