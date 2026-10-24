// Watches the sim state from frame to frame and turns changes into animation
// events (a kick when kickCd jumps, a slide when tackleCd does, a dive when a
// shot is heading past the keeper...). Reads state only.
//
// It also reads optional fields a richer sim may add (s.restart, s.referee,
// card and foul events) without depending on their exact shape.

import { GOAL_BAR_H, PITCH_W } from '../../sim/constants.ts';
import { inOwnBox } from '../../sim/field.ts';
import type { MatchPlayer, MatchState } from '../../sim/types.ts';
import type { AnimEvent } from './player3d.ts';
import { hash01 } from './space.ts';

type Loose = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface RestartInfo {
  kind: string;
  taker: number;
}

/** s.restart, when the sim has one: { kind|type: 'throwin' | 'corner' | ..., taker|player: index }. */
export function readRestart(s: MatchState): RestartInfo | null {
  const r = (s as unknown as Loose).restart as Loose | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const kind = str(r.kind) || str(r.type);
  const taker = num(r.taker) ?? num(r.player) ?? num(r.takerIndex) ?? -1;
  return kind ? { kind, taker } : null;
}

export interface RefereeInfo {
  pos: { x: number; y: number };
  vel: { x: number; y: number };
  facing: { x: number; y: number };
}

export function readReferee(s: MatchState): RefereeInfo | null {
  const r = (s as unknown as Loose).referee as Loose | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const pos = r.pos as { x: number; y: number } | undefined;
  if (!pos || num(pos.x) === null || num(pos.y) === null) return null;
  const vel = (r.vel as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
  const facing = (r.facing as { x: number; y: number } | undefined) ?? null;
  return { pos, vel, facing: facing ?? { x: s.ball.pos.x - pos.x, y: s.ball.pos.y - pos.y } };
}

export interface CardInfo {
  player: number;
  color: 'yellow' | 'red';
}

/** A match event, classified. Goal events today have no kind; richer ones may. */
export function classifyEvent(s: MatchState, ev: unknown): { kind: 'goal' | 'card' | 'foul' | 'offside' | 'other'; card?: CardInfo } {
  const e = ev as Loose;
  const kind = (str(e.kind) || str(e.type)).toLowerCase();
  if (!kind || kind === 'goal') return { kind: 'goal' };
  if (kind.includes('card') || kind === 'yellow' || kind === 'red' || kind.includes('booking') || kind.includes('sendoff')) {
    const color: 'yellow' | 'red' = kind.includes('red') || str(e.card).toLowerCase() === 'red' || str(e.color).toLowerCase() === 'red' ? 'red' : 'yellow';
    let player = num(e.player) ?? num(e.playerIndex) ?? num(e.i) ?? -1;
    if (player < 0) {
      const name = str(e.player) || str(e.name) || str(e.scorer);
      const id = str(e.playerId) || str(e.id);
      const found = s.players.find((p) => (id && p.id === id) || (name && p.name === name));
      player = found ? found.i : -1;
    }
    return { kind: 'card', card: { player, color } };
  }
  if (kind.includes('foul')) return { kind: 'foul' };
  if (kind.includes('offside')) return { kind: 'offside' };
  return { kind: 'other' };
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
  cards: CardInfo[];
}

export class AnimDirector {
  private snaps: Snap[] = [];
  private tick = -1;
  private state: MatchState | null = null;
  private nEvents = 0;
  private ownerPrev = -1;
  private ballSpeedPrev = 0;
  private restartPrev: RestartInfo | null = null;

  /** Forget history (a seek in a replay, or a new state object). */
  reset(s: MatchState): void {
    this.state = s;
    this.tick = s.tick;
    this.snaps = s.players.map((p) => ({ kickCd: p.kickCd, tackleCd: p.tackleCd, stun: p.stun, lastJump: -99, lastDive: -99 }));
    this.nEvents = s.events.length;
    this.ownerPrev = s.ball.owner;
    this.ballSpeedPrev = Math.hypot(s.ball.vel.x, s.ball.vel.y);
    this.restartPrev = readRestart(s);
  }

  /** `time` is the animation clock (seconds); `tickTime` the clock time of s.tick. */
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
    const restart = readRestart(s);

    for (const p of s.players) {
      const sn = this.snaps[p.i];
      const ev = out.events[p.i];
      if (p.kickCd > sn.kickCd) {
        const ago = (18 - p.kickCd) / 60;
        const thrown = !!this.restartPrev && /throw/i.test(this.restartPrev.kind) && (this.restartPrev.taker === p.i || this.restartPrev.taker < 0);
        const style = thrown ? 'throw' : b.z > 0.3 || b.vz > 0.5 ? 'chip' : speed > 16 ? 'shot' : 'pass';
        ev.push({ kind: 'kick', style, t0: time - ago - 0.12, dir: speed > 0.1 ? { x: b.vel.x / speed, y: b.vel.y / speed } : p.facing, power: Math.min(1, speed / 25) });
      }
      if (p.tackleCd > sn.tackleCd) {
        // A slide sets a long cooldown (70+), a standing tackle a short one (36, 50 when it fails).
        const slide = p.tackleCd >= 60;
        const full = slide ? (p.tackleCd >= 85 ? 90 : 70) : p.tackleCd > 40 ? 50 : 36;
        ev.push({ kind: 'tackle', t0: time - Math.max(0, full - p.tackleCd) / 60, failed: p.stun > (slide ? 30 : 15), slide });
      } else if (p.stun > sn.stun + 3) {
        ev.push({ kind: 'knockdown', t0: time - 1 / 60 });
      }
      // Headers: a high ball arriving at an outfield player's head.
      if (p.role !== 'GK' && b.owner < 0 && b.z > 1.05 && b.z < 2.7 && time - sn.lastJump > 1.1 && s.phase === 'play') {
        const dx = b.pos.x - p.pos.x;
        const dy = b.pos.y - p.pos.y;
        const d = Math.hypot(dx, dy);
        const closing = dx * b.vel.x + dy * b.vel.y < 0;
        if (d < 1.4 && closing && speed > 4) {
          sn.lastJump = time;
          ev.push({ kind: 'header', t0: time - 0.15 });
        }
      }
      if (p.role === 'GK') this.keeper(s, p, sn, ev, time, speed);
      sn.kickCd = p.kickCd;
      sn.tackleCd = p.tackleCd;
      sn.stun = p.stun;
    }

    // Goals and cards from new events.
    if (s.events.length > this.nEvents) {
      for (let i = this.nEvents; i < s.events.length; i++) {
        const e = s.events[i];
        const c = classifyEvent(s, e);
        if (c.kind === 'goal') {
          const team = e.team;
          const scorerName = e.scorer;
          const scorer = s.players.find((p) => p.team === team && p.name === scorerName);
          const style = Math.floor(hash01(`${scorerName}|${e.tick}`) * 3);
          for (const p of s.players) {
            const list = out.events[p.i];
            if (scorer && p.i === scorer.i) list.push({ kind: 'celebrate', t0: time + 0.15, style });
            else if (p.team === team && p.role !== 'GK') list.push({ kind: 'cheer', t0: time + 0.35 + hash01(p.id) * 0.4 });
            else if (p.team !== team && (p.role === 'GK' || hash01(p.id, 3) < 0.5)) list.push({ kind: 'dejected', t0: time + 0.3 + hash01(p.id) * 0.5 });
          }
          out.goal = { side: b.pos.x < PITCH_W / 2 ? 0 : 1, speed: Math.max(speed, this.ballSpeedPrev) };
        } else if (c.kind === 'card' && c.card) {
          out.cards.push(c.card);
          out.referee.push({ kind: 'card', t0: time, color: c.card.color });
        }
      }
      this.nEvents = s.events.length;
    }
    this.ownerPrev = b.owner;
    this.ballSpeedPrev = speed;
    this.restartPrev = restart;
    return out;
  }

  private keeper(s: MatchState, p: MatchPlayer, sn: Snap, ev: AnimEvent[], time: number, speed: number) {
    const b = s.ball;
    // Caught it: the keeper now owns a ball that was travelling.
    if (b.owner === p.i && this.ownerPrev !== p.i && this.ballSpeedPrev > 7 && time - sn.lastDive > 0.6) {
      ev.push({ kind: 'catch', t0: time - 0.12, height: b.z });
    }
    if (b.owner >= 0 || s.phase !== 'play' || speed < 9 || time - sn.lastDive < 1.4) return;
    if (!inOwnBox(p.team, p.pos) && Math.abs(p.pos.x - (p.team === 0 ? 0 : PITCH_W)) > 12) return;
    const towardOwn = p.team === 0 ? b.vel.x < 0 : b.vel.x > 0;
    if (!towardOwn) return;
    const t = (p.pos.x - b.pos.x) / b.vel.x;
    if (t < 0.05 || t > 0.6) return;
    const yAt = b.pos.y + b.vel.y * t;
    const zAt = Math.max(0, b.z + b.vz * t - 4.9 * t * t);
    if (zAt > GOAL_BAR_H + 0.6) return;
    const off = yAt - p.pos.y;
    if (Math.abs(off) < 0.75 || Math.abs(off) > 5) return;
    // Side in the keeper's own frame: facing f, a ball at +y offset is to the right when facing +x.
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
