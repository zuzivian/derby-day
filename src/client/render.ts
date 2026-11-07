// Canvas renderer for a match. Reads state, never writes it.

import { watchPixelRatio, type PixelRatioWatch } from './dpr.ts';
import { BOX_DEPTH, BOX_W, CENTRE_R, CORNER_R, GOAL_BOTTOM, GOAL_DEPTH, GOAL_TOP, PENALTY_SPOT, PITCH_H, PITCH_W, RETREAT, SIX_DEPTH, SIX_W } from '../sim/constants.ts';
import { pickTeammate } from '../sim/human.ts';
import { oppGoal } from '../sim/field.ts';
import { HUMAN_SHOT_MIN, humanPass, kickAim, loftPlan, pointerPass, strikePath } from '../sim/kicks.ts';
import { freeKickPlan, setPieceDelivery } from '../sim/match.ts';
import type { MatchPlayer, MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import { GAUGE_COLORS, shotGauge, shotGoalCross } from './power.ts';
import { AnimDirector } from './r3d/director.ts';

export const MARGIN = 3.5;
// Drawn larger than their physical size so players read at a glance.
const PLAYER_R = 0.95;
const BALL_R = 0.3;
/** Smallest drawn sizes in CSS pixels, so a phone's 3 px per metre still shows discs and a ball you can follow. */
const MIN_PLAYER_PX = 4.4;
const MIN_BALL_PX = 2.3;
/** Impact rings: how long one lives (s) and how many at once. Same feel as the 3D view's (r3d/groundfx3d.ts). */
const RING_LIFE = 0.42;
const RING_MAX = 6;

/** Text colour for a number on a kit: its second colour when that stands out, else black or white. */
const inkCache = new Map<string, string>();
function luma(c: string): number {
  const h = c.replace('#', '');
  const v = h.length === 3 ? h.replace(/./g, '$&$&') : h;
  const n = parseInt(v.slice(0, 6), 16);
  if (!(n >= 0)) return 0.5;
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
function ink(on: string, want: string): string {
  const key = on + want;
  let r = inkCache.get(key);
  if (!r) inkCache.set(key, (r = Math.abs(luma(on) - luma(want)) > 0.3 ? want : luma(on) > 0.5 ? '#111418' : '#ffffff'));
  return r;
}

let haloSprite: HTMLCanvasElement | null = null;
/** A soft white disc, drawn scaled under the ball (cheaper than a gradient per frame). */
function halo(): HTMLCanvasElement {
  if (haloSprite) return haloSprite;
  const c = (haloSprite = document.createElement('canvas'));
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,.95)');
  grd.addColorStop(0.45, 'rgba(255,255,255,.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return c;
}
export const VIEW_W = PITCH_W + MARGIN * 2;
export const VIEW_H = PITCH_H + MARGIN * 2;

export interface RenderExtras {
  cursor: Vec | null;
  charge: number;
  showCursor: boolean;
  /** The kick being charged (InputController.armed()): a loft or a shot, and the power it would go with. */
  armed?: { kind: 'loft' | 'shot' | null; power: number; at?: Vec; curl?: number };
  /** Teammate a left click would switch to (InputController.switchCandidate()); computed here when absent. */
  switchTo?: number;
  /** Whose cursor, previews and charge these are. Defaults to the first team with a human. */
  team?: 0 | 1;
  /** Shot charge per team when both humans charge on one screen (hot-seat). Overrides `charge` for the bars. */
  charges?: [number, number];
  /** An instant replay is showing: no pointer, aim wedge or previews. */
  noAim?: boolean;
  /**
   * Seconds of wall time since the drawn state's last tick (the match loop's accumulator, -DT..DT).
   * Positions are drawn extrapolated by velocity times this, so motion is smooth between 60 Hz ticks
   * on any refresh rate instead of moving in tick-sized steps. Omitted: drawn as at the tick.
   */
  since?: number;
}

/** Where to draw something now: its tick position moved on by its velocity for `since` seconds. */
export function drawnAt(out: Vec, pos: Vec, vel: Vec, since: number): Vec {
  out.x = pos.x + vel.x * since;
  out.y = pos.y + vel.y * since;
  return out;
}

/** Controlled-player marker colours when both teams have a human: home yellow, away cyan. */
export const HUMAN_COLORS: [string, string] = ['#ffd60a', '#22d3ee'];
const HUMAN_GLOW: [string, string] = ['rgba(255,214,10,.28)', 'rgba(34,211,238,.3)'];

/** The 2D canvas renderer: the fallback when WebGL is unavailable, and the tutorial's pitch. */
export class PitchRenderer {
  readonly kind = '2d' as const;
  readonly continuous = false;
  private ctx: CanvasRenderingContext2D;
  private k = 10;
  private ballSpin = 0;
  private trail: Vec[] = [];
  /** RenderExtras.since for the frame being drawn, and scratch drawn positions (no allocation per frame). */
  private since = 0;
  private drawn: Vec[] = [];
  private ballAt: Vec = { x: 0, y: 0 };
  private refAt: Vec = { x: 0, y: 0 };

  /** A player's drawn position this frame (see RenderExtras.since). */
  private at(p: MatchPlayer): Vec {
    const q = (this.drawn[p.i] ??= { x: 0, y: 0 });
    return drawnAt(q, p.pos, p.vel, this.since);
  }

  private dpr: PixelRatioWatch;
  /** The pitch, drawn once per size into its own canvas and blitted each frame. */
  private pitch: HTMLCanvasElement | null = null;
  /** CSS pixels per metre, and the player disc radius that gives (metres). */
  private ppm = 10;
  private pr = PLAYER_R;
  private director = new AnimDirector();
  private rings: { x: number; y: number; age: number; reach: number; tint: string }[] = [];
  private punchAge = 9;
  private lastT = 0;
  private reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.dpr = watchPixelRatio(() => this.resize());
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    // Up to 3x on phones (their canvas is small), but never more than ~4.5 M pixels to fill on a big screen.
    const dpr = Math.min(3, window.devicePixelRatio || 1, Math.sqrt(4.5e6 / Math.max(1, rect.width * rect.height)));
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.k = this.canvas.width / VIEW_W;
    this.ppm = rect.width / VIEW_W;
    this.pr = Math.min(1.5, Math.max(PLAYER_R, MIN_PLAYER_PX / this.ppm));
    this.pitch = null;
  }

  /** CSS pixel position inside the canvas to world metres. */
  toWorld(cssX: number, cssY: number): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (cssX / rect.width) * VIEW_W - MARGIN, y: (cssY / rect.height) * VIEW_H - MARGIN };
  }

  /** Nothing to warm up for a 2D canvas. */
  prepare(_s: MatchState): void {}

  /** Top-down view: screen axes are world axes. */
  screenDir(d: Vec): Vec {
    return d;
  }

  dispose(): void {
    this.dpr.dispose();
    this.trail = [];
  }

  draw(s: MatchState, x: RenderExtras): void {
    this.dpr.check();
    this.since = x.since ?? 0;
    const { ctx, k } = this;
    const PLAYER_R = this.pr;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    const still = !!this.reduce?.matches;
    this.juice(s, dt, still);
    // A goal's push-in: the picture swells a few percent about its centre and settles (not under reduced motion).
    const a = this.punchAge;
    const z = 1 + 0.05 * Math.max(0, Math.min(1, a / 0.05) * Math.exp(-a * 5) * Math.cos(a * 3));
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    ctx.setTransform(z, 0, 0, z, cx * (1 - z), cy * (1 - z));
    ctx.drawImage(this.pitchImage(), 0, 0);
    ctx.setTransform(k * z, 0, 0, k * z, cx + (MARGIN * k - cx) * z, cy + (MARGIN * k - cy) * z);
    this.drawOfficials(s);

    // Aim feedback. With the ball: where a click would pass to, or the landing ring and arc of a
    // lofted ball being charged, or the line of a shot being charged. Without it: who a click picks.
    const me: 0 | 1 = x.team ?? (s.humans[0] || !s.humans[1] ? 0 : 1);
    const ctrl = s.controlled[me] >= 0 ? s.players[s.controlled[me]] : null;
    // Each human's player gets a marker; with two humans the colours tell them apart.
    const both = s.humans[0] && s.humans[1];
    const mark = (team: 0 | 1) => (both ? team : 0);
    const ctrls = ([0, 1] as const).filter((t) => s.humans[t] && s.controlled[t] >= 0).map((t) => s.players[s.controlled[t]]);
    const hasBall = !!ctrl && s.ball.owner === ctrl.i && s.phase === 'play';
    const ring = (p: Vec, r: number, style: string) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    const dashed = (a: Vec, b: Vec, style: string, width = 0.12) => {
      ctx.save();
      ctx.setLineDash([0.5, 0.5]);
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };
    const aimAt = x.cursor && x.showCursor ? x.cursor : ctrl ? { x: ctrl.pos.x + ctrl.facing.x * 14, y: ctrl.pos.y + ctrl.facing.y * 14 } : null;
    const armed = x.armed;
    if (ctrl && hasBall && aimAt) {
      if (armed?.kind === 'loft' && armed.at) {
        // A cross from a corner or a free kick: its real flight, and where it comes down.
        const plan = setPieceDelivery(s, ctrl, armed.at, armed.power, armed.curl ?? 0);
        const pts = strikePath(plan.from, plan, 20);
        ctx.save();
        ctx.setLineDash([0.35, 0.45]);
        ctx.strokeStyle = 'rgba(140,220,255,.85)';
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y - p.z * 0.3) : ctx.lineTo(p.x, p.y - p.z * 0.3)));
        ctx.stroke();
        ctx.restore();
        ring(plan.landing, 0.9, 'rgba(140,220,255,.95)');
      } else if (armed?.kind === 'loft') {
        // Lofted ball: landing ring plus the arc the ball will fly.
        const plan = loftPlan(s.ball.pos, x.cursor && x.showCursor ? kickAim(s.ball.pos, ctrl, aimAt, 40) : aimAt, armed.power);
        const a = s.ball.pos;
        ctx.save();
        ctx.setLineDash([0.35, 0.45]);
        ctx.strokeStyle = 'rgba(140,220,255,.85)';
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        for (let i = 0; i <= 16; i++) {
          const u = i / 16;
          const px = a.x + (plan.landing.x - a.x) * u;
          const py = a.y + (plan.landing.y - a.y) * u - 4 * plan.peak * 0.55 * u * (1 - u);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
        ring(plan.landing, 0.9, 'rgba(140,220,255,.95)');
      } else if (armed?.kind === 'shot' && armed.at) {
        // Over a free kick: the strike's real flight, bent by the drag (match.ts freeKickPlan).
        const plan = freeKickPlan(s, ctrl, armed.at, armed.power, armed.curl ?? 0);
        const pts = strikePath(plan.from, plan, 20);
        ctx.save();
        ctx.setLineDash([0.35, 0.45]);
        ctx.strokeStyle = armed.power > 0.85 ? 'rgba(255,90,60,.9)' : 'rgba(255,214,10,.85)';
        ctx.lineWidth = 0.16;
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y - p.z * 0.3) : ctx.lineTo(p.x, p.y - p.z * 0.3)));
        ctx.stroke();
        ctx.restore();
      } else if (armed?.kind === 'shot') {
        dashed(s.ball.pos, x.cursor && x.showCursor ? kickAim(s.ball.pos, ctrl, aimAt, 20) : aimAt, armed.power > 0.85 ? 'rgba(255,90,60,.9)' : 'rgba(255,214,10,.85)', 0.18);
      } else if (x.cursor && x.showCursor) {
        // A click would pass here: the ball rolls to the point, to a teammate near it if there is one.
        const r = pointerPass(s, ctrl, x.cursor);
        dashed(s.ball.pos, r.target, 'rgba(255,255,255,.55)');
        ring(r.target, 0.45, 'rgba(255,255,255,.8)');
        if (r.receiver >= 0) ring(s.players[r.receiver].pos, PLAYER_R + 0.35, 'rgba(255,255,255,.7)');
      } else {
        // Keys: who Space would pass to.
        const r = humanPass(s, ctrl, aimAt);
        dashed(s.ball.pos, r.target, 'rgba(255,255,255,.55)');
        if (r.receiver >= 0) ring(s.players[r.receiver].pos, PLAYER_R + 0.35, 'rgba(255,255,255,.7)');
      }
      // A right click would shoot along the line to the pointer: a crosshair where it crosses their goal line.
      const c = x.cursor && x.showCursor && armed?.kind !== 'loft' && !armed?.at ? shotGoalCross(s, ctrl, x.cursor, armed?.kind === 'shot' ? armed.power : HUMAN_SHOT_MIN) : null;
      if (c) {
        const gx = oppGoal(s, ctrl.team).x;
        const style = armed?.kind === 'shot' ? GAUGE_COLORS[shotGauge(armed.power).band] : 'rgba(255,255,255,.75)';
        const gy = c.y - c.z * 0.3;
        dashed(s.ball.pos, { x: gx, y: c.y }, 'rgba(255,255,255,.25)', 0.1);
        ring({ x: gx, y: gy }, 0.55, style);
        ctx.strokeStyle = style;
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.moveTo(gx - 0.9, gy);
        ctx.lineTo(gx + 0.9, gy);
        ctx.moveTo(gx, gy - 0.9);
        ctx.lineTo(gx, gy + 0.9);
        ctx.stroke();
      }
    } else if (ctrl && !hasBall && x.cursor && x.showCursor && s.phase === 'play') {
      // No ball: the player a left click would switch to.
      const pick = x.switchTo ?? pickTeammate(s, me, x.cursor);
      if (pick >= 0 && pick !== ctrl.i) ring(s.players[pick].pos, PLAYER_R + 0.45, 'rgba(255,214,10,.9)');
    }
    // A pass on its way to a teammate of ours: a ring on him.
    const rcv = s.ball.owner < 0 && s.phase === 'play' ? s.players[s.ball.receiver] : null;
    if (rcv && s.humans[rcv.team] && !rcv.sentOff) ring(rcv.pos, PLAYER_R + 0.4, 'rgba(255,255,255,.75)');

    // Sprint streaks behind anyone running flat out.
    ctx.lineCap = 'round';
    for (const p of s.players) {
      if (!p.sprinting || p.sentOff) continue;
      const sp = Math.hypot(p.vel.x, p.vel.y);
      if (sp < 1) continue;
      const dx = p.vel.x / sp;
      const dy = p.vel.y / sp;
      const q = this.at(p);
      for (let i = -1; i <= 1; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${i === 0 ? 0.32 : 0.18})`;
        ctx.lineWidth = 0.14;
        ctx.beginPath();
        ctx.moveTo(q.x - dx * (PLAYER_R + 0.25) - dy * i * 0.5, q.y - dy * (PLAYER_R + 0.25) + dx * i * 0.5);
        ctx.lineTo(q.x - dx * (PLAYER_R + 1.6) - dy * i * 0.5, q.y - dy * (PLAYER_R + 1.6) + dx * i * 0.5);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';

    // Shadows first so nobody's shadow sits on top of another player.
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    for (const p of s.players) {
      if (p.sentOff) continue;
      const q = this.at(p);
      ctx.beginPath();
      ctx.ellipse(q.x + 0.18, q.y + 0.22, PLAYER_R, PLAYER_R * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of s.players) {
      if (p.sentOff) continue; // sent off: gone from the pitch
      const team = s.teams[p.team];
      const q = this.at(p);
      const isCtrl = s.humans[p.team] && p.i === s.controlled[p.team];
      ctx.globalAlpha = p.stun > 0 ? 0.55 : 1;
      if (isCtrl) {
        ctx.fillStyle = HUMAN_GLOW[mark(p.team)];
        ctx.beginPath();
        ctx.arc(q.x, q.y, PLAYER_R + 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = p.role === 'GK' ? team.secondary : team.primary;
      ctx.strokeStyle = p.role === 'GK' ? team.primary : team.secondary;
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.arc(q.x, q.y, PLAYER_R, 0, Math.PI * 2);
      ctx.fill();
      // Away players get a dashed rim so the teams differ by shape, not only by colour.
      if (p.team === 1) ctx.setLineDash([0.34, 0.2]);
      ctx.stroke();
      ctx.setLineDash([]);
      // A soft highlight on the shoulder so the disc reads as a round kit, not a flat dot.
      ctx.fillStyle = 'rgba(255,255,255,.1)';
      ctx.beginPath();
      ctx.arc(q.x - PLAYER_R * 0.22, q.y - PLAYER_R * 0.28, PLAYER_R * 0.5, 0, Math.PI * 2);
      ctx.fill();
      // Facing notch
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(q.x + p.facing.x * PLAYER_R * 0.78, q.y + p.facing.y * PLAYER_R * 0.78, 0.15, 0, Math.PI * 2);
      ctx.fill();
      // Shirt numbers only where they can be read (a phone's 5 px type is a smudge), in a colour that stands out on the kit.
      if (PLAYER_R * this.ppm >= 8) {
        const [bg, fg] = p.role === 'GK' ? [team.secondary, team.primary] : [team.primary, team.secondary];
        ctx.fillStyle = ink(bg, fg);
        ctx.font = `800 1.05px 'Big Shoulders Display', 'Arial Narrow', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.number), q.x, q.y + 0.04);
      }
      ctx.globalAlpha = 1;
      if (p.yellow > 0) {
        // Booked: a small yellow card by the shoulder.
        ctx.fillStyle = '#ffd60a';
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.lineWidth = 0.05;
        ctx.fillRect(q.x + PLAYER_R * 0.6, q.y - PLAYER_R - 0.2, 0.42, 0.6);
        ctx.strokeRect(q.x + PLAYER_R * 0.6, q.y - PLAYER_R - 0.2, 0.42, 0.6);
      }
      if (isCtrl) {
        ctx.fillStyle = HUMAN_COLORS[mark(p.team)];
        ctx.beginPath();
        ctx.moveTo(q.x, q.y - PLAYER_R - 0.35);
        ctx.lineTo(q.x - 0.38, q.y - PLAYER_R - 0.95);
        ctx.lineTo(q.x + 0.38, q.y - PLAYER_R - 0.95);
        ctx.closePath();
        ctx.fill();
        // The name tag is for screens where it is legible (on a phone the player card shows the name).
        if (this.ppm >= 6) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `600 0.8px 'Barlow', system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,.92)';
          ctx.fillText(p.name, q.x, q.y + PLAYER_R + 0.75);
        }
      }
    }

    // Ball: a lofted ball is drawn raised and larger, its shadow stays on the floor.
    const b = s.ball;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    this.ballSpin += speed * 0.03;
    const lift = b.z * 0.55;
    // At someone's feet the ball moves with him, else with its own velocity.
    const carrier = b.owner >= 0 ? s.players[b.owner] : null;
    const bp = drawnAt(this.ballAt, b.pos, carrier ? carrier.vel : b.vel, this.since);
    const bx = bp.x;
    const by = bp.y - lift;
    const bR = Math.max(BALL_R, MIN_BALL_PX / this.ppm);
    const br = bR * (1 + b.z * 0.09);

    // Trail behind fast shots, fading out.
    if (speed > 13 && b.owner < 0 && s.phase === 'play') {
      this.trail.push({ x: bx, y: by });
      if (this.trail.length > 9) this.trail.shift();
    } else if (this.trail.length) this.trail.shift();
    if (this.trail.length > 1) {
      ctx.lineCap = 'round';
      for (let i = 1; i < this.trail.length; i++) {
        const u = i / this.trail.length;
        ctx.strokeStyle = `rgba(255,255,255,${(0.04 + 0.34 * u).toFixed(3)})`;
        ctx.lineWidth = 0.05 + br * 1.3 * u;
        ctx.beginPath();
        ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
        ctx.lineTo(this.trail[i].x, this.trail[i].y);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }

    // The halo (as in 3D): stronger on a loose ball where the eye goes, faint at a player's feet, off in a keeper's hands.
    const hd = Math.max(0.9, 18 / this.ppm) * (1 + b.z * 0.08);
    if (!b.inHands) {
      ctx.globalAlpha = b.owner < 0 && s.phase === 'play' ? 0.5 : 0.22;
      ctx.drawImage(halo(), bp.x - hd / 2, bp.y - hd / 2, hd, hd);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.12, 0.3 - b.z * 0.05).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(bp.x + 0.12 + b.z * 0.1, bp.y + 0.14 + b.z * 0.06, bR * (1 + b.z * 0.03), bR * 0.8 * (1 + b.z * 0.03), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbfbf7';
    ctx.strokeStyle = '#1b1f24';
    ctx.lineWidth = 0.06 * (bR / BALL_R) ** 0.5;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1b1f24';
    ctx.beginPath();
    ctx.arc(bx + Math.cos(this.ballSpin) * 0.09 * (br / BALL_R), by + Math.sin(this.ballSpin) * 0.09 * (br / BALL_R), 0.075 * (br / BALL_R), 0, Math.PI * 2);
    ctx.fill();

    // Impact rings (tackles, hard shots, goals), expanding and fading on the grass.
    for (const r of this.rings) {
      const t = r.age / RING_LIFE;
      ctx.globalAlpha = 0.75 * (1 - t) ** 2;
      ctx.strokeStyle = r.tint;
      ctx.lineWidth = 0.28 * (1 - t) + 0.06;
      ctx.beginPath();
      ctx.arc(r.x, r.y, (r.reach / 2) * (0.25 + 0.75 * (1 - (1 - t) ** 3)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Stamina under each controlled player: fills as they recover, red when winded.
    for (const ctrl of ctrls) {
      const w = 2.2;
      const sx = ctrl.pos.x - w / 2;
      const sy = ctrl.pos.y + PLAYER_R + 1.5;
      const level = Math.max(0, Math.min(1, (ctrl.energy - 0.4) / 0.6));
      ctx.globalAlpha = level > 0.98 && !ctrl.sprinting ? 0.35 : 0.95;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(sx - 0.08, sy - 0.08, w + 0.16, 0.4);
      ctx.fillStyle = ctrl.winded ? '#ff5a3c' : level < 0.35 ? '#ffb02e' : '#7ee08f';
      ctx.fillRect(sx, sy, w * level, 0.24);
      ctx.globalAlpha = 1;
    }

    // Shot charge bar above the controlled player (each one, in hot-seat)
    for (const c of ctrls) {
      const charge = x.charges ? x.charges[c.team] : c === ctrl ? x.charge : 0;
      if (charge <= 0) continue;
      const w = 2.4;
      const y = c.pos.y - PLAYER_R - 1.7;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(c.pos.x - w / 2, y, w, 0.34);
      ctx.fillStyle = charge > 0.85 ? '#ff5a3c' : HUMAN_COLORS[mark(c.team)];
      ctx.fillRect(c.pos.x - w / 2, y, w * charge, 0.34);
    }

    // Mouse target
    if (x.cursor && x.showCursor) {
      const c = x.cursor;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 0.7, 0, Math.PI * 2);
      ctx.moveTo(c.x - 1.2, c.y);
      ctx.lineTo(c.x - 0.4, c.y);
      ctx.moveTo(c.x + 0.4, c.y);
      ctx.lineTo(c.x + 1.2, c.y);
      ctx.moveTo(c.x, c.y - 1.2);
      ctx.lineTo(c.x, c.y - 0.4);
      ctx.moveTo(c.x, c.y + 0.4);
      ctx.lineTo(c.x, c.y + 1.2);
      // A dark pass under the white one so it reads on the stripes.
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 0.34;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = 0.17;
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  /** Impact rings and the goal push-in, from what changed since the last frame (r3d/director.ts reads the state only). */
  private juice(s: MatchState, dt: number, still: boolean): void {
    const dir = this.director.update(s, performance.now() / 1000);
    this.punchAge += dt;
    const rings = this.rings;
    for (let i = rings.length - 1; i >= 0; i--) if ((rings[i].age += dt) >= RING_LIFE) rings.splice(i, 1);
    const spawn = (x: number, y: number, reach: number, tint: string) => {
      if (rings.length >= RING_MAX) rings.shift();
      rings.push({ x, y, age: 0, reach, tint });
    };
    if (still) {
      rings.length = 0;
      this.punchAge = 9;
    } else {
      for (let i = 0; i < dir.events.length; i++) {
        for (const ev of dir.events[i]) {
          if (ev.kind === 'tackle' && !ev.failed) spawn(s.players[i].pos.x, s.players[i].pos.y, ev.slide ? 4.2 : 3, '#ffe9c4');
          else if (ev.kind === 'kick' && ev.style === 'shot' && ev.power > 0.6) spawn(s.ball.pos.x, s.ball.pos.y, 2 + 3 * ev.power, '#ffffff');
        }
      }
      if (dir.goal) {
        this.punchAge = 0;
        spawn(s.ball.pos.x, s.ball.pos.y, 6, '#ffffff');
        spawn(s.ball.pos.x, s.ball.pos.y, 10, s.teams[s.goals[s.goals.length - 1]?.team ?? 0].primary);
      }
    }
  }

  /** The pitch as a bitmap the size of the canvas, rebuilt only when that changes. */
  private pitchImage(): HTMLCanvasElement {
    if (this.pitch) return this.pitch;
    const c = (this.pitch = document.createElement('canvas'));
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    const k = this.k;
    g.setTransform(k, 0, 0, k, MARGIN * k, MARGIN * k);
    this.drawPitch(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Light falls off toward the edges: a gentle vignette over the whole picture.
    const w = c.width;
    const h = c.height;
    const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,12,4,.18)');
    g.fillStyle = v;
    g.fillRect(0, 0, w, h);
    return c;
  }

  private drawPitch(ctx: CanvasRenderingContext2D): void {
    // Surround: the grass outside the lines.
    ctx.fillStyle = '#245a3a';
    ctx.fillRect(-MARGIN, -MARGIN, VIEW_W, VIEW_H);
    const bands = 14;
    for (let i = 0; i < bands; i++) {
      // Mown stripes, each a touch lighter toward one side as the sun catches the cut blades.
      const x0 = (PITCH_W / bands) * i;
      const gr = ctx.createLinearGradient(x0, 0, x0 + PITCH_W / bands, 0);
      gr.addColorStop(0, i % 2 ? '#2f7d4a' : '#368a54');
      gr.addColorStop(1, i % 2 ? '#33824e' : '#318450');
      ctx.fillStyle = gr;
      ctx.fillRect(x0, 0, PITCH_W / bands + 0.01, PITCH_H);
    }
    // Grass grain: a few thousand faint flecks, the same every time.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.035)' : 'rgba(0,30,10,.05)';
      ctx.fillRect(rnd() * PITCH_W, rnd() * PITCH_H, 0.5 + rnd() * 1.2, 0.12);
    }
    const line = 'rgba(243,246,241,.9)';
    ctx.strokeStyle = line;
    // Whole device pixels wide, so the lines stay crisp at any pixel ratio.
    ctx.lineWidth = Math.max(1, Math.round(0.18 * this.k)) / this.k;
    ctx.strokeRect(0, 0, PITCH_W, PITCH_H);
    ctx.beginPath();
    ctx.moveTo(PITCH_W / 2, 0);
    ctx.lineTo(PITCH_W / 2, PITCH_H);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(PITCH_W / 2, PITCH_H / 2, CENTRE_R, 0, Math.PI * 2);
    ctx.stroke();
    const midY = PITCH_H / 2;
    for (const side of [0, 1] as const) {
      const gx = side === 0 ? 0 : PITCH_W;
      const dir = side === 0 ? 1 : -1;
      // Penalty area, goal area, penalty mark and the arc outside the area.
      ctx.strokeRect(side === 0 ? 0 : PITCH_W - BOX_DEPTH, midY - BOX_W / 2, BOX_DEPTH, BOX_W);
      ctx.strokeRect(side === 0 ? 0 : PITCH_W - SIX_DEPTH, midY - SIX_W / 2, SIX_DEPTH, SIX_W);
      const spot = gx + dir * PENALTY_SPOT;
      const half = Math.acos((BOX_DEPTH - PENALTY_SPOT) / CENTRE_R);
      ctx.beginPath();
      if (side === 0) ctx.arc(spot, midY, CENTRE_R, -half, half);
      else ctx.arc(spot, midY, CENTRE_R, Math.PI - half, Math.PI + half);
      ctx.stroke();
      ctx.fillStyle = line;
      ctx.beginPath();
      ctx.arc(spot, midY, 0.22, 0, Math.PI * 2);
      ctx.fill();
      // Corner arcs.
      for (const cy of [0, PITCH_H]) {
        ctx.beginPath();
        const a0 = side === 0 ? (cy === 0 ? 0 : -Math.PI / 2) : cy === 0 ? Math.PI / 2 : Math.PI;
        ctx.arc(gx, cy, CORNER_R, a0, a0 + Math.PI / 2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = line;
    ctx.beginPath();
    ctx.arc(PITCH_W / 2, midY, 0.22, 0, Math.PI * 2);
    ctx.fill();
    // Goals with net hatch
    for (const side of [0, 1]) {
      const x0 = side === 0 ? -GOAL_DEPTH : PITCH_W;
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      ctx.fillRect(x0, GOAL_TOP, GOAL_DEPTH, GOAL_BOTTOM - GOAL_TOP);
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      for (let y = GOAL_TOP; y <= GOAL_BOTTOM; y += 0.5) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + GOAL_DEPTH, y);
      }
      for (let gx = 0; gx <= GOAL_DEPTH; gx += 0.4) {
        ctx.moveTo(x0 + gx, GOAL_TOP);
        ctx.lineTo(x0 + gx, GOAL_BOTTOM);
      }
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.22;
      const back = side === 0 ? -GOAL_DEPTH : PITCH_W + GOAL_DEPTH;
      const front = side === 0 ? 0 : PITCH_W;
      ctx.beginPath();
      ctx.moveTo(front, GOAL_TOP);
      ctx.lineTo(back, GOAL_TOP);
      ctx.lineTo(back, GOAL_BOTTOM);
      ctx.lineTo(front, GOAL_BOTTOM);
      ctx.stroke();
    }
  }

  /** The referee (black, with a whistle-yellow rim) and, during a restart, the spot and the 9.15 m the opponents must keep. */
  private drawOfficials(s: MatchState): void {
    const { ctx } = this;
    const r = s.restart;
    if (r && r.stage !== 'whistle' && (r.kind === 'freekick' || r.kind === 'corner')) {
      ctx.save();
      ctx.setLineDash([0.4, 0.5]);
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.arc(r.spot.x, r.spot.y, RETREAT, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const ref = s.referee;
    const rq = drawnAt(this.refAt, ref.pos, ref.vel, this.since);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(rq.x + 0.15, rq.y + 0.18, 0.7, 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111418';
    ctx.strokeStyle = '#f5d90a';
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.arc(rq.x, rq.y, 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
