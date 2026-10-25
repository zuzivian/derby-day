// Where shots come from and how often each distance scores, measured from a
// headless match. Pure (no DOM): scripts/balance.ts prints the table and
// tests/tactics.test.ts keeps the long-shot rate near real football.
//
// A shot is counted where the sim counts it (TeamStats.shots), at the
// shooter's distance from the middle of the goal he is shooting at. A goal is
// put down to the side's last shot if it comes within three seconds of it
// (so a rebound scored goes to the shot that made it).

import { TICK_HZ } from '../sim/constants.ts';
import { oppGoal } from '../sim/field.ts';
import { createMatch, step, type MatchOptions } from '../sim/match.ts';
import type { MatchState } from '../sim/types.ts';
import { dist } from '../sim/vec.ts';

/** Distance bands, metres from the goal: 0-11, 11-18, 18-30, 30 and beyond. */
export const SHOT_BANDS = [11, 18, 30, Infinity] as const;
export const SHOT_BAND_LABELS = ['0-11 m', '11-18 m', '18-30 m', '30+ m'];

export interface ShotTally {
  shots: number[];
  goals: number[];
}

export const emptyTally = (): ShotTally => ({ shots: SHOT_BANDS.map(() => 0), goals: SHOT_BANDS.map(() => 0) });

const bandOf = (d: number): number => SHOT_BANDS.findIndex((b) => d < b);

/** Play one CPU-vs-CPU match to the end, adding its shots and goals by distance to `tally`. */
export function playCountingShots(o: Omit<MatchOptions, 'humanTeam' | 'humans'>, tally: ShotTally): MatchState {
  const s = createMatch({ ...o, humans: [false, false] });
  const shots = [s.stats[0].shots, s.stats[1].shots];
  const last: [{ band: number; tick: number } | null, { band: number; tick: number } | null] = [null, null];
  let seen = 0;
  while (s.phase !== 'fulltime') {
    step(s);
    for (const team of [0, 1] as const) {
      if (s.stats[team].shots === shots[team]) continue;
      shots[team] = s.stats[team].shots;
      const k = s.players[s.ball.kickedBy >= 0 ? s.ball.kickedBy : s.ball.lastTouch];
      if (!k || k.team !== team) continue;
      const band = bandOf(dist(k.pos, oppGoal(team)));
      tally.shots[band]++;
      last[team] = { band, tick: s.tick };
    }
    for (; seen < s.events.length; seen++) {
      const e = s.events[seen];
      if (e.kind !== 'goal' || e.ownGoal) continue;
      const l = last[e.team];
      if (l && s.tick - l.tick <= 3 * TICK_HZ) tally.goals[l.band]++;
      last[e.team] = null;
    }
  }
  return s;
}

/** The table balance.ts prints: share of shots and goal rate by distance. */
export function shotTable(t: ShotTally): string {
  const total = t.shots.reduce((a, b) => a + b, 0) || 1;
  return SHOT_BAND_LABELS.map((label, i) => {
    const rate = t.shots[i] ? (100 * t.goals[i]) / t.shots[i] : 0;
    return `  ${label.padEnd(8)} ${String(t.shots[i]).padStart(5)} shots (${((100 * t.shots[i]) / total).toFixed(0).padStart(2)}%)  ${String(t.goals[i]).padStart(4)} goals  ${rate.toFixed(1).padStart(5)}%`;
  }).join('\n');
}
