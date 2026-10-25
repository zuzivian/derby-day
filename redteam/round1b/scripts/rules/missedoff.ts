// CPU matches: a touch by a teammate that is not a kick (header, chest, deflection) does not re-judge offside.
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
import { inOffsidePosition } from '/tmp/rt/rules/repo/src/sim/field.ts';
const N = Number(process.argv[2] ?? 150);
let missed = 0, given = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 31000 + m, ...teams(m + 8), humans: [false, false] });
  let pending: { team: number; players: number[]; by: number } | null = null;
  let ev = 0;
  while (s.phase !== 'fulltime') {
    const lt0 = s.ball.lastTouch, watchTick = s.offside?.tick;
    step(s);
    for (; ev < s.events.length; ev++) if (s.events[ev].kind === 'offside') given++;
    const b = s.ball;
    if (s.phase !== 'play') { pending = null; continue; }
    if (b.lastTouch !== lt0 && b.lastTouch >= 0) {
      const p = s.players[b.lastTouch];
      if (pending && pending.team === p.team && pending.players.includes(p.i)) { missed++; if (ex.length < 6) ex.push(`m${m} t${s.tick}: p${p.i} played it after p${pending.by}'s ${'touch'}, offside position at that touch`); }
      pending = null;
      // a touch that wasn't a kick (no new offside watch this tick): what offside judgement would a kick have made?
      const kicked = s.offside && s.offside.tick === s.tick;
      if (!kicked && b.owner < 0) {
        const flagged = s.players.filter((m) => m.team === p.team && m.i !== p.i && !m.sentOff && inOffsidePosition(s, m)).map((m) => m.i);
        if (flagged.length) pending = { team: p.team, players: flagged, by: p.i };
      }
    }
  }
}
console.log(`${N} CPU matches: offsides given ${given}; a player who was offside when a teammate headed/deflected it then played the ball, not given: ${missed}`); console.log(ex);
