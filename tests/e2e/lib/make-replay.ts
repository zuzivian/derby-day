// Prints a replay code for a match against an active human that has goals, so the replay e2e
// can load a replay with highlights without depending on how a live short match goes.
//   bun run tests/e2e/lib/make-replay.ts [minGoals]
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../../../src/meta/club.ts';
import { encodeReplay, ReplayRecorder } from '../../../src/meta/replay.ts';
import { createMatch, step } from '../../../src/sim/match.ts';

const minGoals = Number(process.argv[2] ?? 2);
for (let seed = 1; seed < 200; seed++) {
  const [a, b] = generateLadder(7, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const opts = { seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 40, humanTeam: 0 as const };
  const s = createMatch(opts);
  const rec = new ReplayRecorder(opts, 'Ranked');
  let t = 0;
  while (s.phase !== 'fulltime') {
    const cursor = { x: 20 + 14 * Math.sin(t / 80), y: 20 + 9 * Math.cos(t / 55) };
    step(s, rec.push({ cursor, pass: t % 150 === 0, sprint: t % 400 < 90 }));
    t++;
  }
  if (s.events.length >= minGoals) {
    console.log(encodeReplay(rec.finish(s, 1_700_000_000)));
    process.exit(0);
  }
}
console.error('no seed produced enough goals');
process.exit(1);
