// Watches the sim state from frame to frame and turns changes into animation
// events: a kick when kickCd jumps, a slide when tackleCd does, a dive when a
// shot is heading past the keeper, celebrations from s.goals, the referee's
// card from s.cards. Reads state only.

import { GOAL_BAR_H, PITCH_H, PITCH_W } from '../../sim/constants.ts';
import { inOwnBox } from '../../sim/field.ts';
import type { MatchEvent, MatchPlayer, MatchState, RestartKind } from '../../sim/types.ts';
import type { AnimEvent } from './player3d.ts';
import { hash01 } from './space.ts';

export interface CardShown {
  player: number;
  color: 'yellow' | 'red';
}

interface Snap {
  kickCd: number;
  tackleCd: number;
  stun: number;
  lastJump: number;
  lastDive: number;
}

export interface DirectorOutput {
  events: AnimEvent[][];
  referee: AnimEvent[];
  /** A goal just went in: which end, for the net ripple. */
  goal: { side: 0 | 1; speed: number } | null;
  cards: CardShown[];
}

export class AnimDirector {
  private snaps: Snap[] = [];
  private tick = -1;
  private state: MatchState | null = null;
  private nEvents = 0;
  private ownerPrev = -1;
  private ballSpeedPrev = 0;
  private restartPrev: { kind: RestartKind; taker: number } | null = null;

  /** Forget history (a seek in a replay, or a new state object). */
  reset(s: MatchState): void {
    this.state = s;
    this.tick = s.tick;
    this.snaps = s.players.map((p) => ({ kickCd: p.kickCd, tackleCd: p.tackleCd, stun: p.stun, lastJump: -99, lastDive: -99 }));
    this.nEvents = s.events.length;
    this.ownerPrev = s.ball.owner;
    this.ballSpeedPrev = Math.hypot(s.ball.vel.x, s.ball.vel.y);
    this.restartPrev = s.restart ? { kind: s.restart.kind, taker: s.restart.taker } : null;
  }

  /** `time` is the animation clock, seconds. */
  update(s: MatchState, time: number): DirectorOutput {
    const out: DirectorOutput = { events: s.players.map(() => []), referee: [], goal: null, cards: [] };
    const jump = s.tick - this.tick;
    if (this.state !== s || jump < 0 || jump > 45 || this.snaps.length !== s.players.length) {
      this.reset(s);
      return out;
    }
    if (jump === 0) return out;
    this.tick = s.tick;
    const b = s.ball;
    const speed = Math.hypot(b.vel.x, b.vel.y);

    for (const p of s.players) {
      const sn = this.snaps[p.i];
      const ev = out.events[p.i];
      if (p.sentOff) {
        sn.kickCd = p.kickCd;
        sn.tackleCd = p.tackleCd;
        sn.stun = p.stun;
        continue;
      }
      if (p.kickCd > sn.kickCd) {
        const ago = (18 - p.kickCd) / 60;
        const thrown = this.restartPrev?.kind === 'throwin' && this.restartPrev.taker === p.i;
        const style = thrown ? 'throw' : b.z > 0.3 || b.vz > 0.5 ? 'chip' : speed > 16 ? 'shot' : 'pass';
        ev.push({ kind: 'kick', style, t0: time - ago - (thrown ? 0.2 : 0.12), dir: speed > 0.1 ? { x: b.vel.x / speed, y: b.vel.y / speed } : p.facing, power: Math.min(1, speed / 25) });
      }
      if (p.tackleCd > sn.tackleCd) {
        // A slide sets a long cooldown (70+), a standing tackle a short one (36, 50 when it fails).
        const slide = p.tackleCd >= 60;
        const full = slide ? (p.tackleCd >= 85 ? 90 : 70) : p.tackleCd > 40 ? 50 : 36;
        ev.push({ kind: 'tackle', t0: time - Math.max(0, full - p.tackleCd) / 60, failed: p.stun > (slide ? 30 : 15), slide });
      } else if (p.stun > sn.stun + 3) {
        // Tackled, or fouled (the victim of a foul is stunned while the whistle goes).
        ev.push({ kind: 'knockdown', t0: time - 1 / 60 });
      }
      // Headers: a high ball arriving at an outfield player's head.
      if (p.role !== 'GK' && b.owner < 0 && b.z > 1.05 && b.z < 2.7 && time - sn.lastJump > 1.1 && s.phase === 'play') {
        const dx = b.pos.x - p.pos.x;
        const dy = b.pos.y - p.pos.y;
        const closing = dx * b.vel.x + dy * b.vel.y < 0;
        if (Math.hypot(dx, dy) < 1.4 && closing && speed > 4) {
          sn.lastJump = time;
          ev.push({ kind: 'header', t0: time - 0.15 });
        }
      }
      if (p.role === 'GK') this.keeper(s, p, sn, ev, time, speed);
      sn.kickCd = p.kickCd;
      sn.tackleCd = p.tackleCd;
      sn.stun = p.stun;
    }

    for (let i = this.nEvents; i < s.events.length; i++) this.event(s, s.events[i], out, time, speed);
    this.nEvents = s.events.length;
    this.ownerPrev = b.owner;
    this.ballSpeedPrev = speed;
    this.restartPrev = s.restart ? { kind: s.restart.kind, taker: s.restart.taker } : null;
    return out;
  }

  private event(s: MatchState, e: MatchEvent, out: DirectorOutput, time: number, speed: number) {
    if (e.kind === 'goal') {
      const scorer = !e.ownGoal && e.player >= 0 ? e.player : -1;
      const style = Math.floor(hash01(`${e.scorer}|${e.tick}`) * 3);
      for (const p of s.players) {
        if (p.sentOff) continue;
        const list = out.events[p.i];
        if (p.i === scorer) list.push({ kind: 'celebrate', t0: time + 0.15, style });
        else if (p.team === e.team && p.role !== 'GK') list.push({ kind: 'cheer', t0: time + 0.35 + hash01(p.id) * 0.4 });
        else if (p.team !== e.team && (p.role === 'GK' || p.i === e.player || hash01(p.id, 3) < 0.5)) list.push({ kind: 'dejected', t0: time + 0.3 + hash01(p.id) * 0.5 });
      }
      out.goal = { side: s.ball.pos.x < PITCH_W / 2 ? 0 : 1, speed: Math.max(speed, this.ballSpeedPrev) };
    } else if (e.kind === 'card' && e.player >= 0) {
      // A second yellow comes with its red: the referee shows both, the red last.
      out.cards.push({ player: e.player, color: e.color });
      out.referee.push({ kind: 'card', t0: time, color: e.color });
    }
  }

  private keeper(s: MatchState, p: MatchPlayer, sn: Snap, ev: AnimEvent[], time: number, speed: number) {
    const b = s.ball;
    // Caught it: the keeper now owns a ball that was travelling.
    if (b.owner === p.i && this.ownerPrev !== p.i && this.ballSpeedPrev > 7 && time - sn.lastDive > 0.6) {
      ev.push({ kind: 'catch', t0: time - 0.12, height: b.z });
    }
    if (b.owner >= 0 || s.phase !== 'play' || speed < 9 || time - sn.lastDive < 1.4) return;
    if (!inOwnBox(p.team, p.pos)) return;
    const towardOwn = p.team === 0 ? b.vel.x < 0 : b.vel.x > 0;
    if (!towardOwn) return;
    const t = (p.pos.x - b.pos.x) / b.vel.x;
    if (t < 0.05 || t > 0.6) return;
    const yAt = b.pos.y + b.vel.y * t;
    const zAt = Math.max(0, b.z + b.vz * t - 4.9 * t * t);
    if (zAt > GOAL_BAR_H + 0.6) return;
    const off = yAt - p.pos.y;
    if (Math.abs(off) < 0.75 || Math.abs(off) > 5) return;
    // Side in the keeper's own frame: facing +x, a ball at +y is to his right.
    const fx = p.facing.x || (p.team === 0 ? 1 : -1);
    const right = fx > 0 ? off > 0 : off < 0;
    sn.lastDive = time;
    ev.push({ kind: 'dive', t0: time - 0.05, side: right ? 1 : -1, height: zAt, reach: Math.abs(off) - 0.3 });
  }
}

/** Keeper readiness: crouched when the ball is near and the other side has it or it's coming. */
export function keeperSet(s: MatchState, p: MatchPlayer): number {
  if (p.role !== 'GK' || s.phase !== 'play') return 0;
  const b = s.ball;
  if (b.owner === p.i) return 0;
  const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
  if (d > 24) return 0;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const threat = owner ? owner.team !== p.team : true;
  return threat ? Math.min(1, (24 - d) / 10) : 0;
}

/**
 * Defenders in a wall: within 11 m of a free kick against them, roughly on the line from the ball
 * to their goal. They stand shoulder to shoulder with their hands in front.
 */
export function inWall(s: MatchState, p: MatchPlayer): boolean {
  const r = s.restart;
  if (!r || r.kind !== 'freekick' || p.team === r.team || p.role === 'GK' || p.sentOff) return false;
  const gx = p.team === 0 ? 0 : PITCH_W;
  const gy = PITCH_H / 2;
  const dx = gx - r.spot.x;
  const dy = gy - r.spot.y;
  const l = Math.hypot(dx, dy) || 1;
  const px = p.pos.x - r.spot.x;
  const py = p.pos.y - r.spot.y;
  const along = (px * dx + py * dy) / l;
  const across = Math.abs(px * dy - py * dx) / l;
  return along > 7 && along < 11.5 && across < 3.2;
}
