// A late challenge on a player who has just shot: the whistle goes and the shot in flight is cancelled?
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 150);
let late = 0, lateStopped = 0, wouldScore = 0, afterShot = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 21000 + m, ...teams(m + 6), humans: [false, false] });
  let prev = structuredClone(s);
  let evIdx = 0;
  while (s.phase !== 'fulltime') {
    const shotsBefore = [s.stats[0].shots, s.stats[1].shots];
    const looseBefore = s.ball.owner < 0;
    const lastBefore = s.ball.lastTouch;
    step(s);
    for (; evIdx < s.events.length; evIdx++) {
      const e: any = s.events[evIdx];
      if (e.kind !== 'foul' || !looseBefore || e.victim !== lastBefore) continue;
      late++;
      const stopped = s.phase === 'restart';
      if (!stopped) continue;
      lateStopped++;
      // Was the ball a shot? Re-run from the tick before with the offender unable to tackle.
      const c = structuredClone(prev);
      c.players[e.player].tackleCd = 600;
      const g0 = c.goals.length; const sh = c.stats[1 - e.team].shots;
      for (let t = 0; t < 150 && (c.phase === 'play'); t++) step(c);
      if (c.goals.length > g0 && c.goals.at(-1)!.team !== e.team) { wouldScore++; if (ex.length < 6) ex.push(`m${m} t${e.tick} ${e.severity}: victim's side would have scored (${c.goals.at(-1)!.scorer})`); }
    }
    prev = structuredClone(s);
  }
}
console.log({ matches: N, lateChallengeFoulsAfterRelease: late, playStoppedForThem: lateStopped, aGoalWouldHaveFollowed: wouldScore }); console.log(ex);
