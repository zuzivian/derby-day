import { newGame, applyResult, pickOpponent, averageOverall } from '/tmp/rt/progression/repo/src/meta/game.ts';
import { totalXpForLevel } from '/tmp/rt/progression/repo/src/meta/levels.ts';
import { maybeRollover } from '/tmp/rt/progression/repo/src/meta/progression.ts';
import { overall } from '/tmp/rt/progression/repo/src/meta/player.ts';
// A player who never buys or signs offers: only the automatic academy intake.
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const s = newGame(seed); s.xp = totalXpForLevel(10); s.unlocksSeen = [];
  let maxAge = 0, oldGK = 0, firstOld = -1;
  for (let y = 0; y < 40; y++) {
    for (let w = 0; w < 10; w++) { const o = pickOpponent(s); applyResult(s, o, o, 1, 1, true, []); s.trainingPoints = 0; }
    const r = maybeRollover(s); if (r) r.seen = true;
    const m = Math.max(...s.squad.map((p) => p.age)); maxAge = Math.max(maxAge, m);
    const gk = s.squad.filter((p) => p.role === 'GK');
    if (firstOld < 0 && m >= 39) firstOld = y + 1;
    oldGK = Math.max(oldGK, ...gk.map((p) => p.age));
  }
  const gk = s.squad.filter((p) => p.role === 'GK').map((p) => `${p.age}:${overall(p)}`);
  const xi = s.lineup.map((id) => s.squad.find((p) => p.id === id)!);
  console.log(`seed ${seed}: after 40 seasons squad=${s.squad.length} maxAge=${maxAge} (first 39+ in season ${firstOld}) oldest GK ever ${oldGK}; GKs now ${gk.join(',')}; XI avg ${averageOverall(s).toFixed(1)} XI ages ${xi.map((p) => p.age).join(',')} offers=${s.offers?.length}`);
}
