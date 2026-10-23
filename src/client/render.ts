// Canvas renderer for a match. Reads state, never writes it.

import { BOX_DEPTH, BOX_W, CHIP_Z0, GOAL_BOTTOM, GOAL_DEPTH, GOAL_TOP, PITCH_H, PITCH_W } from '../sim/constants.ts';
import { chipPlan, humanPass } from '../sim/kicks.ts';
import type { MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';

export const MARGIN = 2.6;
// Drawn larger than their physical size so players read at a glance.
const PLAYER_R = 0.95;
const BALL_R = 0.3;
export const VIEW_W = PITCH_W + MARGIN * 2;
export const VIEW_H = PITCH_H + MARGIN * 2;

export interface RenderExtras {
  cursor: Vec | null;
  charge: number;
  showCursor: boolean;
  /** What the next kick would be: through ball (modifier held) or a chip being charged. */
  armed?: { through: boolean; chip: boolean };
}

export class PitchRenderer {
  private ctx: CanvasRenderingContext2D;
  private k = 10;
  private ballSpin = 0;
  private trail: Vec[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.k = this.canvas.width / VIEW_W;
  }

  /** CSS pixel position inside the canvas to world metres. */
  toWorld(cssX: number, cssY: number): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (cssX / rect.width) * VIEW_W - MARGIN, y: (cssY / rect.height) * VIEW_H - MARGIN };
  }

  draw(s: MatchState, x: RenderExtras): void {
    const { ctx, k } = this;
    ctx.setTransform(k, 0, 0, k, MARGIN * k, MARGIN * k);
    this.drawPitch();

    // Pass preview: who a click would pass to right now, or where a through ball lands.
    const ctrl = s.controlled >= 0 ? s.players[s.controlled] : null;
    const hasBall = !!ctrl && s.ball.owner === ctrl.i && s.phase === 'play';
    const through = !!x.armed?.through;
    if (ctrl && hasBall && x.cursor) {
      const r = humanPass(s, ctrl, x.cursor, through);
      ctx.save();
      ctx.setLineDash([0.5, 0.5]);
      ctx.strokeStyle = through ? 'rgba(255,214,10,.8)' : 'rgba(255,255,255,.55)';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.moveTo(s.ball.pos.x, s.ball.pos.y);
      ctx.lineTo(r.target.x, r.target.y);
      ctx.stroke();
      ctx.restore();
      if (r.receiver >= 0) {
        const m = s.players[r.receiver];
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.arc(m.pos.x, m.pos.y, PLAYER_R + 0.35, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (through) {
        // Target diamond where the ball is headed, with a run line from the receiver.
        const tx = r.target.x;
        const ty = r.target.y;
        if (r.receiver >= 0) {
          const m = s.players[r.receiver];
          ctx.save();
          ctx.setLineDash([0.25, 0.35]);
          ctx.strokeStyle = 'rgba(255,214,10,.5)';
          ctx.lineWidth = 0.1;
          ctx.beginPath();
          ctx.moveTo(m.pos.x, m.pos.y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = '#ffd60a';
        ctx.lineWidth = 0.14;
        ctx.beginPath();
        ctx.moveTo(tx, ty - 0.75);
        ctx.lineTo(tx + 0.75, ty);
        ctx.lineTo(tx, ty + 0.75);
        ctx.lineTo(tx - 0.75, ty);
        ctx.closePath();
        ctx.stroke();
      }
    }
    // Chip preview: landing ring plus the arc the ball will fly.
    if (ctrl && hasBall && x.cursor && x.armed?.chip && x.charge > 0) {
      const plan = chipPlan(s.ball.pos, x.cursor, x.charge);
      const a = s.ball.pos;
      const peak = CHIP_Z0 + (plan.vz * plan.vz) / (2 * 9.8);
      ctx.save();
      ctx.setLineDash([0.35, 0.45]);
      ctx.strokeStyle = 'rgba(140,220,255,.85)';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const u = i / 16;
        const px = a.x + (plan.landing.x - a.x) * u;
        const py = a.y + (plan.landing.y - a.y) * u - 4 * peak * 0.55 * u * (1 - u);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(140,220,255,.95)';
      ctx.lineWidth = 0.13;
      ctx.beginPath();
      ctx.arc(plan.landing.x, plan.landing.y, 0.9, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Sprint streaks behind anyone running flat out.
    ctx.lineCap = 'round';
    for (const p of s.players) {
      if (!p.sprinting) continue;
      const sp = Math.hypot(p.vel.x, p.vel.y);
      if (sp < 1) continue;
      const dx = p.vel.x / sp;
      const dy = p.vel.y / sp;
      for (let i = -1; i <= 1; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${i === 0 ? 0.32 : 0.18})`;
        ctx.lineWidth = 0.14;
        ctx.beginPath();
        ctx.moveTo(p.pos.x - dx * (PLAYER_R + 0.25) - dy * i * 0.5, p.pos.y - dy * (PLAYER_R + 0.25) + dx * i * 0.5);
        ctx.lineTo(p.pos.x - dx * (PLAYER_R + 1.6) - dy * i * 0.5, p.pos.y - dy * (PLAYER_R + 1.6) + dx * i * 0.5);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';

    // Shadows first so nobody's shadow sits on top of another player.
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    for (const p of s.players) {
      ctx.beginPath();
      ctx.ellipse(p.pos.x + 0.18, p.pos.y + 0.22, PLAYER_R, PLAYER_R * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of s.players) {
      const team = s.teams[p.team];
      const isCtrl = p.i === s.controlled;
      ctx.globalAlpha = p.stun > 0 ? 0.55 : 1;
      if (isCtrl) {
        ctx.fillStyle = 'rgba(255,214,10,.28)';
        ctx.beginPath();
        ctx.arc(p.pos.x, p.pos.y, PLAYER_R + 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = p.role === 'GK' ? team.secondary : team.primary;
      ctx.strokeStyle = p.role === 'GK' ? team.primary : team.secondary;
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, PLAYER_R, 0, Math.PI * 2);
      ctx.fill();
      // Away players get a dashed rim so the teams differ by shape, not only by colour.
      if (p.team === 1) ctx.setLineDash([0.34, 0.2]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Facing notch
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(p.pos.x + p.facing.x * PLAYER_R * 0.78, p.pos.y + p.facing.y * PLAYER_R * 0.78, 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.role === 'GK' ? team.primary : team.secondary;
      ctx.font = `800 1.05px 'Big Shoulders Display', 'Arial Narrow', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.number), p.pos.x, p.pos.y + 0.04);
      ctx.globalAlpha = 1;
      if (isCtrl) {
        ctx.fillStyle = '#ffd60a';
        ctx.beginPath();
        ctx.moveTo(p.pos.x, p.pos.y - PLAYER_R - 0.35);
        ctx.lineTo(p.pos.x - 0.38, p.pos.y - PLAYER_R - 0.95);
        ctx.lineTo(p.pos.x + 0.38, p.pos.y - PLAYER_R - 0.95);
        ctx.closePath();
        ctx.fill();
        ctx.font = `600 0.8px 'Barlow', system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.fillText(p.name, p.pos.x, p.pos.y + PLAYER_R + 0.75);
      }
    }

    // Ball: a lofted ball is drawn raised and larger, its shadow stays on the floor.
    const b = s.ball;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    this.ballSpin += speed * 0.03;
    const lift = b.z * 0.55;
    const bx = b.pos.x;
    const by = b.pos.y - lift;
    const br = BALL_R * (1 + b.z * 0.09);

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

    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.12, 0.3 - b.z * 0.05).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(b.pos.x + 0.12 + b.z * 0.1, b.pos.y + 0.14 + b.z * 0.06, BALL_R * (1 + b.z * 0.03), BALL_R * 0.8 * (1 + b.z * 0.03), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbfbf7';
    ctx.strokeStyle = '#1b1f24';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1b1f24';
    ctx.beginPath();
    ctx.arc(bx + Math.cos(this.ballSpin) * 0.09 * (br / BALL_R), by + Math.sin(this.ballSpin) * 0.09 * (br / BALL_R), 0.075 * (br / BALL_R), 0, Math.PI * 2);
    ctx.fill();

    // Stamina under the controlled player: fills as they recover, red when winded.
    if (ctrl) {
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

    // Shot charge bar above the controlled player
    if (ctrl && x.charge > 0) {
      const w = 2.4;
      const y = ctrl.pos.y - PLAYER_R - 1.7;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(ctrl.pos.x - w / 2, y, w, 0.34);
      ctx.fillStyle = x.charge > 0.85 ? '#ff5a3c' : '#ffd60a';
      ctx.fillRect(ctrl.pos.x - w / 2, y, w * x.charge, 0.34);
    }

    // Mouse target
    if (x.cursor && x.showCursor) {
      const c = x.cursor;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 0.55, 0, Math.PI * 2);
      ctx.moveTo(c.x - 0.95, c.y);
      ctx.lineTo(c.x - 0.3, c.y);
      ctx.moveTo(c.x + 0.3, c.y);
      ctx.lineTo(c.x + 0.95, c.y);
      ctx.moveTo(c.x, c.y - 0.95);
      ctx.lineTo(c.x, c.y - 0.3);
      ctx.moveTo(c.x, c.y + 0.3);
      ctx.lineTo(c.x, c.y + 0.95);
      ctx.stroke();
    }
  }

  private drawPitch(): void {
    const { ctx } = this;
    // Surround (the boards and the floor outside them)
    ctx.fillStyle = '#1f4f33';
    ctx.fillRect(-MARGIN, -MARGIN, VIEW_W, VIEW_H);
    const bands = 10;
    for (let i = 0; i < bands; i++) {
      ctx.fillStyle = i % 2 ? '#2f7d4a' : '#348752';
      ctx.fillRect((PITCH_W / bands) * i, 0, PITCH_W / bands + 0.01, PITCH_H);
    }
    ctx.strokeStyle = 'rgba(243,246,241,.85)';
    ctx.lineWidth = 0.14;
    ctx.strokeRect(0, 0, PITCH_W, PITCH_H);
    ctx.beginPath();
    ctx.moveTo(PITCH_W / 2, 0);
    ctx.lineTo(PITCH_W / 2, PITCH_H);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(PITCH_W / 2, PITCH_H / 2, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(243,246,241,.85)';
    for (const x of [PITCH_W / 2, 5.5, PITCH_W - 5.5]) {
      ctx.beginPath();
      ctx.arc(x, PITCH_H / 2, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeRect(0, (PITCH_H - BOX_W) / 2, BOX_DEPTH, BOX_W);
    ctx.strokeRect(PITCH_W - BOX_DEPTH, (PITCH_H - BOX_W) / 2, BOX_DEPTH, BOX_W);
    // Boards
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 0.4;
    ctx.strokeRect(-0.2, -0.2, PITCH_W + 0.4, PITCH_H + 0.4);
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
}
