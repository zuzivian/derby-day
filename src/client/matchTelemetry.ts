// CPU-match measurements use simulator time, so pauses, replay playback and slow
// rendering cannot inflate the time to a goal or the duration of a match.
import { TICK_HZ } from '../sim/constants.ts';
import type { MatchState } from '../sim/types.ts';
import type { MatchOutcome, Telemetry } from './telemetry.ts';

type Progress = Pick<MatchState, 'tick' | 'goals' | 'score' | 'phase' | 'abandoned'>;
const seconds = (tick: number): number => Math.round((tick / TICK_HZ) * 1000) / 1000;

/** One lifecycle per match. All events pass through the existing privacy gates. */
export function createMatchTelemetry(t: Pick<Telemetry, 'track' | 'flush'>, kind: string, controls: 'mouse' | 'keys', humanTeam: 0 | 1) {
  let ended = false;
  let scored = false;
  t.track({ name: 'match_start', kind, controls });

  const observe = (s: Progress): void => {
    if (ended || scored) return;
    const first = s.goals.find((g) => g.team === humanTeam);
    if (!first) return;
    scored = true;
    t.track({ name: 'first_player_goal', kind, activeSeconds: seconds(first.tick) });
  };

  const end = (s: Progress, outcome: MatchOutcome): void => {
    if (ended) return;
    observe(s);
    ended = true;
    t.track({
      name: 'match_end', kind,
      score: [s.score[humanTeam], s.score[humanTeam === 0 ? 1 : 0]],
      forfeit: outcome === 'forfeit', outcome, activeSeconds: seconds(s.tick),
    });
  };

  return {
    observe,
    finish: (s: Progress, forfeited: boolean): void => end(s, forfeited ? 'forfeit' : s.abandoned ? 'abandoned' : 'completed'),
    // Full-time can precede the result callback by the final banner's delay.
    // Leaving during that delay still counts as a finished match.
    abandon: (s: Progress): void => {
      end(s, s.phase === 'fulltime' && !s.abandoned ? 'completed' : 'abandoned');
      // The global pagehide flush may have run before the match's listener.
      t.flush();
    },
  };
}
