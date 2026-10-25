import { newGame } from '/tmp/rt/progression/repo/src/meta/game.ts';
import { cpuTeam, ladderSquad } from '/tmp/rt/progression/repo/src/meta/club.ts';
import { simulate } from '/tmp/rt/progression/repo/src/sim/match.ts';
const N = Number(process.argv[2] ?? 60);
for (const half of [60, 180]) {
  let goals = 0, draws = 0, nil = 0, pts = 0, decisive = 0;
  for (let i = 0; i < N; i++) {
    const s = newGame(1000 + i);
    const [a, b] = [s.ladder[i % 15], s.ladder[(i * 7 + 3) % 15 === i % 15 ? (i + 1) % 15 : (i * 7 + 3) % 15]];
    const m = simulate({ seed: 77 + i, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)), halfSeconds: half });
    goals += m.score[0] + m.score[1];
    if (m.score[0] === m.score[1]) { draws++; pts += 2; if (!m.score[0]) nil++; } else { decisive++; pts += 3; }
  }
  console.log(`half ${half}s: ${N} CPU matches, goals/match ${(goals / N).toFixed(2)}, draws ${(100 * draws / N).toFixed(0)}% (0-0 ${(100 * nil / N).toFixed(0)}%), points per club per match ${(pts / N / 2).toFixed(2)}`);
}
