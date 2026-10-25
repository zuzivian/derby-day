import { expect, test } from 'bun:test';
import { decodedReplays, recentReplays, setReplaySlots, storeReplay } from '../src/client/replayStore.ts';
import { autoLineup, generateLadder, ladderSquad, toTeamSetup } from '../src/meta/club.ts';
import { ReplayRecorder } from '../src/meta/replay.ts';
import { createMatch, step } from '../src/sim/match.ts';

function shortReplay(seed: number, at: number) {
  const [a, b] = generateLadder(seed, 2);
  const sa = ladderSquad(a);
  const sb = ladderSquad(b);
  const opts = { seed, home: toTeamSetup(a, sa, autoLineup(sa)), away: toTeamSetup(b, sb, autoLineup(sb)), halfSeconds: 1, humanTeam: 0 as const };
  const s = createMatch(opts);
  const rec = new ReplayRecorder(opts, 'Test');
  let n = 0;
  while (s.phase !== 'fulltime') step(s, rec.push({ cursor: { x: 20 + (n++ % 30), y: 30 } }));
  return rec.finish(s, at);
}

test('replayStore holds decoded replays only for the entries it still keeps', () => {
  setReplaySlots(3);
  for (let i = 0; i < 8; i++) storeReplay(shortReplay(i + 1, 1_700_000_000 + i));
  expect(recentReplays().length).toBe(3);
  // Eight matches played, three kept: the other five are not held in memory.
  expect(decodedReplays()).toBe(3);
});
