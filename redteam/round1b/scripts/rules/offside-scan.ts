// Monitor CPU matches: every time a team plays/touches the ball, snapshot its players in an
// offside position (field.ts inOffsidePosition, the sim's own test). If one of them is next
// to touch the ball with no opponent touch in between and the sim gives no offside, count it,
// split by how the teammate had played the ball (a kick, which the sim judges, or a header /
// tackle / deflection, which it does not).
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { inOffsidePosition, secondLastOpponentX } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 30);
const missed: Record<string, number> = {}; const called: Record<string, number> = {};
let offsideEvents = 0; const ex: string[] = []; let goalsAfterMissed = 0;
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 2000 + m, ...teams(m + 11), humans: [false, false] });
  let snap: null | { team: 0 | 1; by: number; how: string; players: number[]; tick: number } = null;
  let pendingMissGoal: null | { team: 0 | 1; tick: number } = null;
  while (s.phase !== 'fulltime') {
    const prevOwner = s.ball.owner, prevLast = s.ball.lastTouch, prevPhase = s.phase, prevSetPiece = s.restart?.kind;
    const nEv = s.events.length;
    step(s);
    const evs = s.events.slice(nEv);
    for (const e of evs) if (e.kind === 'offside') offsideEvents++;
    if (evs.some((e) => e.kind === 'goal') && pendingMissGoal && s.tick - pendingMissGoal.tick < 400 && evs.find((e) => e.kind === 'goal')!.team === pendingMissGoal.team) goalsAfterMissed++;
    if (prevPhase !== 'play' || s.phase !== 'play') { if (s.phase !== 'play') snap = null; if (prevPhase === 'restart') snap = null; continue; }
    const b = s.ball;
    // Was the ball touched this tick, and by whom?
    let toucher = -1; let how = '';
    if (prevOwner >= 0 && b.owner < 0) { toucher = prevOwner; how = 'kick'; }
    else if (b.lastTouch !== prevLast && b.lastTouch >= 0 && b.owner < 0) { toucher = b.lastTouch; how = 'header/deflection/tackle'; }
    else if (b.owner >= 0 && b.owner !== prevOwner) { toucher = b.owner; how = 'control'; }
    if (toucher < 0) continue;
    const p = s.players[toucher];
    // Is this touch by someone flagged in the snapshot?
    if (snap && p.team === snap.team && snap.players.includes(p.i) && p.i !== snap.by) {
      const k = snap.how; missed[k] = (missed[k] ?? 0) + 1; pendingMissGoal = { team: p.team, tick: s.tick };
      if (ex.length < 6 && k !== 'kick') ex.push(`seed ${2000 + m} tick ${s.tick}: #${p.i} touched the ball (${how}) after teammate #${snap.by} played it by ${k} at tick ${snap.tick} while #${p.i} was in an offside position; no offside given`);
      snap = null;
    }
    if (snap && p.team !== snap.team) snap = null;
    if (snap && p.team === snap.team && !snap.players.includes(p.i) && p.i !== snap.by) snap = null; // onside teammate got it
    if (how === 'kick' || how === 'header/deflection/tackle') {
      const second = secondLastOpponentX(s, p.team);
      const flagged = s.players.filter((q) => q.team === p.team && q.i !== p.i && !q.sentOff && inOffsidePosition(s, q, b.pos.x, second)).map((q) => q.i);
      snap = flagged.length ? { team: p.team, by: p.i, how: how === 'kick' ? 'kick' : 'header/deflection/tackle', players: flagged, tick: s.tick } : null;
    }
  }
}
console.log({ matches: N, offsideEventsGiven: offsideEvents, missedAfterKick: missed['kick'] ?? 0, missedAfterHeaderDeflectionTackle: missed['header/deflection/tackle'] ?? 0, goalsWithin400TicksOfAMiss: goalsAfterMissed });
console.log(ex.join('\n'));
