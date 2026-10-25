// CPU matches: every keeper catch (ball goes into his hands). Where was the ball? Also: headers by a
// teammate that the keeper could not handle, and keepers re-handling a ball they had released.
import { BOX_DEPTH, PITCH_W } from '/tmp/rt/rules/repo/src/sim/constants.ts';
import { createMatch, step } from '/tmp/rt/rules/repo/src/sim/match.ts';
import { inOwnBox, teamX } from '/tmp/rt/rules/repo/src/sim/field.ts';
import { teams } from './lib.ts';
const N = Number(process.argv[2] ?? 40);
let catches = 0, outside = 0, maxOut = 0, rehandle = 0; const ex: string[] = [];
for (let m = 0; m < N; m++) {
  const s = createMatch({ seed: 6000 + m, ...teams(m + 51), humans: [false, false] });
  let released: null | { gk: number; tick: number } = null;
  while (s.phase !== 'fulltime') {
    const p0 = { ...s.ball.pos }; const wasHands = s.ball.inHands; const own0 = s.ball.owner; const lt0 = s.ball.lastTouch;
    step(s);
    const b = s.ball;
    if (wasHands && own0 >= 0 && b.owner < 0 && s.phase === 'play') released = { gk: own0, tick: s.tick };
    if (released && b.lastTouch !== released.gk && b.lastTouch >= 0 && b.lastTouch !== lt0) released = null;
    if (!wasHands && b.inHands && b.owner >= 0 && s.phase === 'play') {
      const gk = s.players[b.owner]; catches++;
      if (released && released.gk === gk.i) { rehandle++; if (ex.length < 8) ex.push(`seed ${6000 + m} tick ${s.tick}: keeper #${gk.i} picked the ball up again ${s.tick - released.tick} ticks after releasing it, nobody else touched it`); released = null; }
      if (!inOwnBox(gk.team, p0)) { outside++; const d = teamX(gk.team, p0.x) * PITCH_W - BOX_DEPTH; maxOut = Math.max(maxOut, d); if (ex.length < 8) ex.push(`seed ${6000 + m} tick ${s.tick}: keeper #${gk.i} caught it with the ball ${d.toFixed(2)} m outside his area (keeper at ${(teamX(gk.team, gk.pos.x) * PITCH_W).toFixed(2)} m)`); }
    }
  }
}
console.log({ matches: N, catches, ballOutsideArea: outside, maxMetresOutside: +maxOut.toFixed(2), keeperReHandledHisOwnRelease: rehandle });
console.log(ex.join('\n'));
