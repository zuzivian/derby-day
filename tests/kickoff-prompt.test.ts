// The kick-off is a kick (Law 8): while a human's kick-off waits, the HUD says who takes it and how long before the
// CPU takes it for them; in hot-seat that is either player, and nothing waits for ever.

import { describe, expect, test } from 'bun:test';
import { kickoffWait } from '../src/client/hud.ts';
import { cpuTeam, generateLadder, ladderSquad } from '../src/meta/club.ts';
import { RESTART_HUMAN_WAIT } from '../src/sim/constants.ts';
import { createMatch, step } from '../src/sim/match.ts';

function hotseat() {
  const [a, b] = generateLadder(7, 2);
  return createMatch({ seed: 3, home: cpuTeam(a, ladderSquad(a)), away: cpuTeam(b, ladderSquad(b)), halfSeconds: 6, humans: [true, true] });
}

describe('a human kick-off waiting', () => {
  test("hot-seat: player 1's opening kick-off counts down five seconds, then the CPU takes it; nothing waits for ever", () => {
    const s = hotseat();
    let first: ReturnType<typeof kickoffWait> = null;
    let t = 0;
    for (; t < 2000 && s.phase !== 'play'; t++) {
      const w = kickoffWait(s);
      if (w && !first) first = w;
      step(s, [{}, {}]);
    }
    expect(first).toEqual({ team: 0, secs: RESTART_HUMAN_WAIT / 60 });
    expect(s.phase).toBe('play');
    expect(kickoffWait(s)).toBeNull();
  });

  test("the second half's kick-off is player 2's, and it is taken too when nobody presses", () => {
    const s = hotseat();
    let second: ReturnType<typeof kickoffWait> = null;
    for (let t = 0; t < 20000 && s.phase !== 'fulltime'; t++) {
      const w = kickoffWait(s);
      if (w && s.half === 2 && !second) second = w;
      step(s, [{}, {}]);
    }
    expect(second?.team).toBe(1);
    expect(s.phase).toBe('fulltime');
  });
});
