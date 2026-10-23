// Shared kick planning for human input, the renderer's previews and the CPU.
// Pure functions of state: no mutation, no rng.

import { passSpeed, resolvePassTarget } from './ai.ts';
import { AIR_DRAG, CHIP_Z0, GRAVITY } from './constants.ts';
import { attackDir, clampToPitch } from './field.ts';
import type { MatchPlayer, MatchState } from './types.ts';
import { add, clamp, dist, len, norm, scale, sub, type Vec } from './vec.ts';

/**
 * Where a through ball should go: well ahead of the receiver along their run.
 * A runner is led by how far they'll get while the ball travels, plus extra
 * so it arrives in front of them. A standing player is sent toward goal.
 */
export function throughTarget(from: Vec, m: MatchPlayer, passing: number): Vec {
  const d = dist(from, m.pos);
  const speed = passSpeed(d, passing) * 1.05;
  const t = d / (speed * 0.75);
  const vr = len(m.vel);
  const run = vr > 1.2 ? norm(m.vel) : { x: attackDir(m.team), y: (20 - m.pos.y) * 0.02 };
  const lead = Math.max(vr, 4.5) * Math.min(t + 0.55, 1.9) + 2.2;
  return clampToPitch(add(m.pos, scale(norm(run), lead)), 1);
}

export interface ChipPlan {
  /** Where the ball first touches down. */
  landing: Vec;
  /** Initial horizontal speed. */
  speed: number;
  /** Initial vertical speed, from a start height of CHIP_Z0. */
  vz: number;
  /** Seconds in the air. */
  flight: number;
}

/** Power 0..1 sets how far a chip can travel; it lands on the target if that is within range. */
export function chipRange(power: number): number {
  return 6 + 30 * clamp(power, 0, 1);
}

export function chipPlan(from: Vec, target: Vec, power: number): ChipPlan {
  const to = sub(target, from);
  const d = clamp(Math.min(len(to), chipRange(power)), 3, 40);
  const flight = clamp(0.7 + 0.04 * d, 0.8, 1.8);
  const speed = (d * AIR_DRAG) / (1 - Math.exp(-AIR_DRAG * flight));
  const dir = norm(len(to) < 1e-6 ? { x: 1, y: 0 } : to);
  return { landing: add(from, scale(dir, d)), speed, vz: (GRAVITY * flight) / 2 - CHIP_Z0 / flight, flight };
}

/**
 * What a human pass toward `aim` does right now. Same teammate pick as a
 * normal pass; a through ball leads the receiver instead of finding their feet.
 */
export function humanPass(s: MatchState, p: MatchPlayer, aim: Vec, through: boolean): { target: Vec; receiver: number } {
  const r = resolvePassTarget(s, p, aim);
  if (!through || r.receiver < 0) return r;
  return { target: throughTarget(s.ball.pos, s.players[r.receiver], p.attrs.passing), receiver: r.receiver };
}
