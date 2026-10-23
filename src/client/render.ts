// Canvas renderer for a match. Reads state, never writes it.

import { resolvePassTarget } from '../sim/ai.ts';
import { BOX_DEPTH, BOX_W, GOAL_BOTTOM, GOAL_DEPTH, GOAL_TOP, PITCH_H, PITCH_W } from '../sim/constants.ts';
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
}

export class PitchRenderer {
  private ctx: CanvasRenderingContext2D;
  private k = 10;
  private ballSpin = 0;

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

    // Pass preview: who a click would pass to right now.
    const ctrl = s.controlled >= 0 ? s.players[s.controlled] : null;
    if (ctrl && s.ball.owner === ctrl.i && x.cursor && s.phase === 'play') {
      const r = resolvePassTarget(s, ctrl, x.cursor);
      ctx.save();
      ctx.setLineDash([0.5, 0.5]);
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
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
    }

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
      ctx.stroke();
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

    // Ball
    const b = s.ball;
    this.ballSpin += Math.hypot(b.vel.x, b.vel.y) * 0.03;
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath();
    ctx.arc(b.pos.x + 0.12, b.pos.y + 0.14, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbfbf7';
    ctx.strokeStyle = '#1b1f24';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1b1f24';
    ctx.beginPath();
    ctx.arc(b.pos.x + Math.cos(this.ballSpin) * 0.09, b.pos.y + Math.sin(this.ballSpin) * 0.09, 0.075, 0, Math.PI * 2);
    ctx.fill();

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
