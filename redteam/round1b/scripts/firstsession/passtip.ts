import { newGame, clubTeam } from '/tmp/rt/firstsession/repo/src/meta/game.ts';
import { warmupTeam } from '/tmp/rt/firstsession/repo/src/meta/warmup.ts';
import { createMatch, step } from '/tmp/rt/firstsession/repo/src/sim/match.ts';
import { CoachTracker, minTipMs, SEEN_AFTER_MS, tipText, type TipId } from '/tmp/rt/firstsession/repo/src/client/coach.ts';
import { PITCH_W } from '/tmp/rt/firstsession/repo/src/sim/constants.ts';
const autoHideMs = (t: string) => Math.max(10_000, minTipMs(t) + 4000);
for (const policy of ['passive', 'dribble']) {
  const firstPass: number[] = []; let koHasBall = 0, koPassShown = 0, firstTipRunWithBall = 0;
  const N = 40;
  for (let seed = 1; seed <= N; seed++) {
    const save = newGame(seed * 104729);
    const s = createMatch({ seed: seed * 13, home: clubTeam(save, 0.6), away: warmupTeam(save, true).away, humanTeam: 0 });
    const tr = new CoachTracker([]);
    let shown: TipId | null = null, text = '', age = 0, counted = false, koPoss = true, passShownInKo = false, fp = -1;
    for (let t = 0; t < 60 * 120 && s.phase !== 'fulltime'; t++) {
      const p = s.players[s.controlled[0]];
      step(s, policy === 'passive' ? { cursor: { ...p.pos } } : { cursor: { x: Math.min(PITCH_W - 2, p.pos.x + 9), y: p.pos.y }, moved: true });
      if (koPoss && (s.ball.owner < 0 || s.players[s.ball.owner].team !== 0) && s.phase === 'play' && s.tick > 75) koPoss = false;
      tr.observe(s, 0);
      if (shown) { age += 1000 / 60; if (!counted && age >= SEEN_AFTER_MS) counted = true; if (age >= autoHideMs(text) || (tr.queue.length && age >= minTipMs(text))) { if (!counted) tr.forget(shown); shown = null; } }
      if (!shown && tr.queue.length) { const id = tr.take(s, 0); if (id) { shown = id; age = 0; counted = false; text = tipText(id, 'mouse', false); if (id === 'pass') { if (fp < 0) fp = s.tick; if (koPoss) passShownInKo = true; } if (id === 'run' && s.ball.owner === s.controlled[0]) firstTipRunWithBall++; } }
    }
    koHasBall++; if (passShownInKo) koPassShown++; firstPass.push(fp < 0 ? 99999 : fp);
  }
  firstPass.sort((a, b) => a - b);
  console.log(policy, `first tip is 'run' while the human holds the ball: ${firstTipRunWithBall}/${N}; pass tip shown during the kick-off possession (team keeps it): ${koPassShown}/${N}; first pass tip at median ${(firstPass[N / 2] / 60).toFixed(1)} s, p90 ${(firstPass[Math.floor(N * 0.9)] / 60).toFixed(1)} s (min ${(firstPass[0] / 60).toFixed(1)} s)`);
}
