// The big moments, as a pure read of the goals so far (and the derby flag and shot length the client already has).
// Most goals are ordinary and return null; the rest name themselves and say how big to go (1 a notch, 2 the biggest).

import type { GoalEvent } from '../sim/types.ts';

export interface Moment {
  word: string;
  level: 1 | 2;
}

/** A shot struck from at least this far, m, that goes in is a screamer. */
export const SCREAMER_M = 24;
/** From this match minute a goal is "late". */
export const LATE_MIN = 85;

/** What goal number `i` of `goals` is, if anything. `dist`: metres from the strike to the goal, when the shot was seen. */
export function goalMoment(goals: readonly GoalEvent[], i: number, x: { derby?: boolean; dist?: number } = {}): Moment | null {
  const g = goals[i];
  const t = g.team;
  const sc: [number, number] = [0, 0];
  let worst = 0;
  let mine = 0;
  for (let j = 0; j < i; j++) {
    sc[goals[j].team]++;
    worst = Math.max(worst, sc[1 - t] - sc[t]);
    if (!goals[j].ownGoal && goals[j].team === t && goals[j].scorer === g.scorer) mine++;
  }
  const behind = sc[1 - t] - sc[t]; // before this goal; positive: trailing
  const late = g.minute >= LATE_MIN;
  if (!g.ownGoal && mine === 2) return { word: 'Hat-trick!', level: 2 };
  if (behind === 0 && late) return { word: 'Late winner!', level: 2 };
  if (behind >= 0 && worst >= 2 && behind <= 1) return { word: 'Comeback!', level: 2 };
  if (!g.ownGoal && (x.dist ?? 0) >= SCREAMER_M) return { word: 'Screamer!', level: 1 };
  if (behind === 1 && g.minute >= 60) return late ? { word: 'Late equaliser!', level: 2 } : { word: 'Equaliser!', level: 1 };
  if (x.derby && (behind === 0 || behind === 1)) return { word: 'Derby goal!', level: 1 };
  return null;
}

/** The full-time word: a cup final or a derby won by the side `home`; and whether it kept a clean sheet. */
export function fullTimeMoment(score: readonly [number, number], home: 0 | 1, x: { final?: boolean; derby?: boolean }): { word: string; clean: boolean } {
  const won = score[home] > score[1 - home];
  return { word: won && x.final ? 'Cup final won!' : won && x.derby ? 'Derby won!' : 'Full time', clean: won && score[1 - home] === 0 };
}
