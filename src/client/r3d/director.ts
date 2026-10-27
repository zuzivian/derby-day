// Watches the sim state from frame to frame and turns changes into animation
// events: a kick when kickCd jumps, a slide when tackleCd does, a dive when a
// shot is heading past the keeper, celebrations from s.goals, the referee's
// card from s.cards. Reads state only.

import { GOAL_BAR_H, PITCH_H, PITCH_W, SLIDE_CD_MIN, SLIDE_MISS_DOWN, SLIDE_START_CD, STAND_MISS_DOWN } from '../../sim/constants.ts';
import { attackDir, inOwnBox, ownGoal } from '../../sim/field.ts';
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
  /** Who had the ball in his hands on the last tick (a keeper), or -1. */
  private handsPrev = -1;
  private ballSpeedPrev = 0;
  private restartPrev: { kind: RestartKind; taker: number } | null = null;

  /** Forget history (a seek in a replay, or a new state object). */
  reset(s: MatchState): void {
    this.state = s;
    this.tick = s.tick;
    this.snaps = s.players.map((p) => ({ kickCd: p.kickCd, tackleCd: p.tackleCd, stun: p.stun, lastJump: -99, lastDive: -99 }));
    this.nEvents = s.events.length;
    this.ownerPrev = s.ball.owner;
    this.handsPrev = s.ball.inHands ? s.ball.owner : -1;
    this.ballSpeedPrev = Math.hypot(s.ball.vel.x, s.ball.vel.y);
    this.restartPrev = s.restart ? { kind: s.restart.kind, taker: s.restart.taker } : null;
  }

  private out: DirectorOutput = { events: [], referee: [], goal: null, cards: [] };

  /** `time` is the animation clock, seconds. */
  update(s: MatchState, time: number): DirectorOutput {
    // One output, cleared and refilled each frame (callers use it within the frame), not 25 new arrays a frame.
    const out = this.out;
    while (out.events.length < s.players.length) out.events.push([]);
    out.events.length = s.players.length;
    for (const list of out.events) list.length = 0;
    out.referee.length = 0;
    out.cards.length = 0;
    out.goal = null;
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
        // A keeper letting go of it along the ground bowls it out by hand; lofted, he kicks it from his hands (the strike is the release).
        const rolled = !thrown && this.handsPrev === p.i && b.z < 0.3 && b.vz < 0.5;
        const style = thrown ? 'throw' : rolled ? 'roll' : b.z > 0.3 || b.vz > 0.5 ? 'chip' : speed > 16 ? 'shot' : 'pass';
        ev.push({ kind: 'kick', style, t0: time - ago - (thrown || rolled ? 0.2 : this.handsPrev === p.i ? 0.17 : 0.12), dir: speed > 0.1 ? { x: b.vel.x / speed, y: b.vel.y / speed } : p.facing, power: Math.min(1, speed / 25) });
      }
      if (p.tackleCd > sn.tackleCd) {
        // The cooldown says which (constants.ts SLIDE_CD_MIN). A slide that misses after it has started
        // raises it again: the same slide, failed now, as far into it as it has gone.
        const slide = p.tackleCd >= SLIDE_CD_MIN;
        const again = slide && sn.tackleCd >= SLIDE_CD_MIN;
        const ago = again ? Math.max(0, SLIDE_START_CD - sn.tackleCd) / 60 : 0;
        ev.push({ kind: 'tackle', t0: time - ago, failed: p.stun >= (slide ? SLIDE_MISS_DOWN : STAND_MISS_DOWN), slide });
      } else if (p.stun > sn.stun + 3 && !p.dive) {
        // Tackled, or fouled (the victim of a foul is stunned while the whistle goes). Not a keeper
        // going down at the end of a dive: the sim stuns him for the time he lies there.
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
    this.handsPrev = b.inHands ? b.owner : -1;
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
    } else if (e.kind === 'advantage') {
      out.referee.push({ kind: 'signal', t0: time, style: 'advantage' });
    } else if (e.kind === 'restart' && e.restart === 'freekick' && !s.cards.some((c) => c.tick === e.tick)) {
      // A free kick (for a foul, an offside, an advantage brought back or a second touch): he
      // points, unless he is showing a card for it.
      out.referee.push({ kind: 'signal', t0: time + 0.2, style: 'point' });
    }
  }

  private keeper(s: MatchState, p: MatchPlayer, sn: Snap, ev: AnimEvent[], time: number, speed: number) {
    const b = s.ball;
    // Caught it: the keeper now owns a ball that was travelling.
    if (b.owner === p.i && this.ownerPrev !== p.i && this.ballSpeedPrev > 7 && time - sn.lastDive > 0.6) {
      ev.push({ kind: 'catch', t0: time - 0.12, height: b.z });
    }
    // The sim's own dive (match.ts keeperDives), when there is one: the way he really went.
    if (p.dive && p.dive.ticks > 0 && time - sn.lastDive > 0.6) {
      // Side in the frame the model is drawn in (he watches the ball, keeperLook), not the sim's facing.
      const look = keeperLook(s, p) ?? p.facing;
      const across = p.dive.dir.x * -look.y + p.dive.dir.y * look.x;
      sn.lastDive = time;
      // The sim carries him along the dive itself (movePlayer): the pose adds no travel of its own.
      ev.push({ kind: 'dive', t0: time - 0.05, side: across >= 0 ? 1 : -1, height: p.dive.z, reach: 0 });
      return;
    }
    if (p.dive !== undefined) return; // this sim reports dives: no guessing
    if (b.owner >= 0 || s.phase !== 'play' || speed < 9 || time - sn.lastDive < 1.4) return;
    if (!inOwnBox(s, p.team, p.pos)) return;
    const towardOwn = b.vel.x * attackDir(s, p.team) < 0;
    if (!towardOwn) return;
    const t = (p.pos.x - b.pos.x) / b.vel.x;
    if (t < 0.05 || t > 0.6) return;
    const yAt = b.pos.y + b.vel.y * t;
    const zAt = Math.max(0, b.z + b.vz * t - 4.9 * t * t);
    if (zAt > GOAL_BAR_H + 0.6) return;
    const off = yAt - p.pos.y;
    if (Math.abs(off) < 0.75 || Math.abs(off) > 5) return;
    // Side in the keeper's own frame: watching +x, a ball at +y is to his right.
    const fx = keeperLook(s, p)?.x || attackDir(s, p.team);
    const right = fx > 0 ? off > 0 : off < 0;
    sn.lastDive = time;
    ev.push({ kind: 'dive', t0: time - 0.05, side: right ? 1 : -1, height: zAt, reach: Math.abs(off) - 0.3 });
  }
}

/** Keeper readiness: crouched when the ball is near and the other side has it or it's coming, and for a penalty against him. */
export function keeperSet(s: MatchState, p: MatchPlayer): number {
  if (p.role !== 'GK') return 0;
  // Facing a penalty he is set on his line, not standing to attention, from the whistle until it is struck.
  const r = s.restart;
  if (r?.kind === 'penalty' && r.team !== p.team && r.stage !== 'whistle') return 1;
  if (s.phase !== 'play') return 0;
  const b = s.ball;
  if (b.owner === p.i) return 0;
  const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
  if (d > 24) return 0;
  const owner = b.owner >= 0 ? s.players[b.owner] : null;
  const threat = owner ? owner.team !== p.team : true;
  return threat ? Math.min(1, (24 - d) / 10) : 0;
}

/**
 * Where a keeper in play looks: at the ball, or up the pitch when it is on top of him. The sim turns him
 * to his velocity, so a keeper shuffling across his line would face the touchline; drawn, he keeps his
 * eyes on play and side-steps. Null when he has the ball or play is stopped (his own facing then).
 */
export function keeperLook(s: MatchState, p: MatchPlayer): { x: number; y: number } | null {
  if (p.role !== 'GK' || s.phase !== 'play' || s.ball.owner === p.i) return null;
  const dx = s.ball.pos.x - p.pos.x;
  const dy = s.ball.pos.y - p.pos.y;
  const d = Math.hypot(dx, dy);
  return d < 1.5 ? { x: attackDir(s, p.team), y: 0 } : { x: dx / d, y: dy / d };
}

/**
 * Defenders in a wall: the sim's own wall (MatchState.wall, kept while it jumps to the shot), or failing that
 * (a state from before it had one) within 11 m of a free kick against them, roughly on the line from the
 * ball to their goal. They stand shoulder to shoulder with their hands in front.
 */
export function inWall(s: MatchState, p: MatchPlayer): boolean {
  if (s.wall) return s.wall.players.includes(p.i) && !p.sentOff;
  const r = s.restart;
  if (!r || r.kind !== 'freekick' || p.team === r.team || p.role === 'GK' || p.sentOff) return false;
  const gx = ownGoal(s, p.team).x;
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
