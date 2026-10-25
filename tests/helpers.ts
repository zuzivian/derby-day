// Shared test fixtures for the sim.

import { step } from '../src/sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../src/sim/types.ts';
import { dist } from '../src/sim/vec.ts';

/**
 * From the kick-off line-up to open play with someone on the ball. The kick-off is a real
 * restart (Law 8): a human taker plays it at once, a short pass to his nearest teammate, and
 * the CPU takes its own on its usual count. Returns once a player has the ball in play, so a
 * test starts much as it did when the kick-off taker was simply handed the ball. The human's
 * hand is on the mouse: no hold after the automatic switch to the receiver (MatchState.ctlHold).
 * The kick-off pass is in the stats.
 */
export function kickOff(s: MatchState, input: HumanInput | TeamInputs = {}): void {
  for (let t = 0; t < 1200; t++) {
    if (s.phase === 'play' && s.ball.owner >= 0) {
      if (s.ctlHold) s.ctlHold = [false, false];
      return;
    }
    const r = s.restart;
    if (s.phase === 'restart' && r?.kind === 'kickoff' && r.stage === 'ready' && s.humans[r.team] && s.controlled[r.team] === r.taker) {
      const taker = s.players[r.taker];
      const mate = s.players
        .filter((p) => p.team === taker.team && p.i !== taker.i && !p.sentOff && p.role !== 'GK')
        .sort((a, b) => dist(a.pos, taker.pos) - dist(b.pos, taker.pos))[0];
      const kick: HumanInput = { cursor: { ...mate.pos }, aim: { ...mate.pos }, pass: true, moved: true };
      if (Array.isArray(input)) {
        const pair: TeamInputs = [{ ...input[0] }, { ...input[1] }];
        pair[r.team] = kick;
        step(s, pair);
      } else step(s, s.humans[0] && s.humans[1] ? (r.team === 0 ? [kick, {}] : [{}, kick]) : kick);
      continue;
    }
    step(s, input);
  }
}
