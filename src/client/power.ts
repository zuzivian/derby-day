// How hard a kick will go, as one gauge shared by the 3D aim wedge and the
// HUD power bar, so the two always agree. Pure: no DOM, no three.js.
//
//   fill  0..1, how much of the wedge (and the bar) is lit
//   band  'green' (the sweet spot), 'amber' (firm, or a loft falling short), 'red' (over-hit)
//   tick  0..1, where the sweet spot ends on the bar
//
// Shots: power is SHOT_MIN for a click up to 1 for a full hold; the sim's
// aiming error grows with power squared (match.ts: 0.02 + 0.12 * power²), so
// past about 0.85 it starts to spray. Passes: the pace a click would hit it at,
// against the research brief's bands (§4: 10–15 m/s short, 18–25 m/s long; a
// ground pass over about 24 m/s is hard to take). Lofts: how much of the
// distance to the pointer the hold reaches.

import { passSpeed } from '../sim/ai.ts';
import { humanPass, loftRange, pointerPass } from '../sim/kicks.ts';
import type { MatchState } from '../sim/types.ts';
import type { RenderExtras } from './render.ts';

export type PowerBand = 'green' | 'amber' | 'red';

export interface Gauge {
  fill: number;
  band: PowerBand;
  /** Where the sweet spot ends, 0..1 along the bar. */
  tick: number;
}

/** Shot power at which the strike starts to fly off target. */
export const SHOT_SWEET = 0.85;
/** Above this a shot is over-hit (red). */
export const SHOT_WILD = 0.93;
/** Ground passes: the hardest kick the sim plays (kicks.ts PASS_MAX_SPEED), the end of the bar. */
export const PASS_FULL = 28;
/** Pace bands for a ground pass, m/s. */
export const PASS_FIRM = 18;
export const PASS_HARD = 24;

export const GAUGE_COLORS: Record<PowerBand, string> = { green: '#46d36a', amber: '#ffb020', red: '#ff4a32' };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function shotGauge(power: number): Gauge {
  const band: PowerBand = power > SHOT_WILD ? 'red' : power > SHOT_SWEET ? 'amber' : 'green';
  return { fill: clamp01(power), band, tick: SHOT_SWEET };
}

/** A ground pass kicked at `speed` m/s. */
export function passGauge(speed: number): Gauge {
  const band: PowerBand = speed > PASS_HARD ? 'red' : speed > PASS_FIRM ? 'amber' : 'green';
  return { fill: clamp01(speed / PASS_FULL), band, tick: PASS_FIRM / PASS_FULL };
}

/**
 * A lofted ball: `hold` 0..1, `reach` metres it would carry, `want` metres to the pointer. Green
 * once it reaches the pointer, amber while it would fall short.
 */
export function loftGauge(hold: number, reach: number, want: number): Gauge {
  const short = reach < want - 0.5;
  return { fill: clamp01(Math.max(0.04, hold)), band: short ? 'amber' : 'green', tick: 1 };
}

/**
 * The gauge for what the human would kick right now, or null when they don't have the ball (or no
 * human is playing): a charging shot or loft from `x.armed`, else the pace of a plain click pass
 * (pointer) or Space pass (keys, toward where the player faces).
 */
export function kickGauge(s: MatchState, x: RenderExtras): Gauge | null {
  const me: 0 | 1 = x.team ?? (s.humans[0] || !s.humans[1] ? 0 : 1);
  const ci = s.humans[me] ? s.controlled[me] : -1;
  if (ci < 0) return null;
  const p = s.players[ci];
  const ready = s.phase === 'play' || (s.phase === 'restart' && s.restart?.stage === 'ready');
  if (s.ball.owner !== p.i || !ready) return null;
  const pointer = x.showCursor && x.cursor ? x.cursor : null;
  const aim = pointer ?? { x: p.pos.x + p.facing.x * 14, y: p.pos.y + p.facing.y * 14 };
  const a = x.armed;
  if (a?.kind === 'shot') return shotGauge(a.power);
  if (a?.kind === 'loft') {
    const want = Math.hypot(aim.x - s.ball.pos.x, aim.y - s.ball.pos.y);
    return loftGauge(a.power, loftRange(a.power), want);
  }
  // The pace the sim will really kick it at: pointerPass's own speed (firm to a teammate, weighted
  // to the spot into space); a Space pass goes at the CPU's pace for the distance (match.ts applyAction).
  if (pointer) return passGauge(pointerPass(s, p, pointer).speed);
  const target = humanPass(s, p, aim).target;
  return passGauge(passSpeed(Math.hypot(target.x - s.ball.pos.x, target.y - s.ball.pos.y), p.attrs.passing));
}
