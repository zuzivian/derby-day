// In-match HUD laid over the pitch: crests and score top-left with the match
// clock under it, menu and mode top-right, big centre words (GOAL, HALF TIME,
// FULL TIME, REPLAY, OFFSIDE, FOUL), a radar minimap bottom centre and the
// shot-power bar bottom right. Shared by live, hot-seat and linked matches.
//
// Ids kept from the old header so tooling still finds them: #sb-h, #sb-a,
// #sb-min, #sb-phase, #banner; and the score bar keeps the .scoreboard class
// (it carries both club names for screen readers).

import type { CrestPattern } from '../meta/names.ts';
import { BOX_DEPTH, BOX_W, CENTRE_R, PITCH_H, PITCH_W, RESTART_HUMAN_WAIT, TICK_HZ } from '../sim/constants.ts';
import { keeperHoldLeft } from '../sim/human.ts';
import { inAddedTime, indirectPending, matchSeconds } from '../sim/rules.ts';
import type { MatchEvent, MatchState, TeamSetup } from '../sim/types.ts';
import { crestSvg } from './crest.ts';
import type { Gauge } from './power.ts';
import { HUMAN_COLORS } from './render.ts';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const GAUGE_LABEL: Record<Gauge['kind'], string> = { pass: 'Pass', loft: 'Loft', shot: 'Shot' };

/** Where a hard shot starts to fly off target: the tick on the power bar. */
export const SWEET_SPOT = 0.8;

export interface HudOptions {
  teams: [TeamSetup, TeamSetup];
  crests: [CrestPattern, CrestPattern];
  /** Top-right mode label, e.g. "You vs AI". */
  mode: string;
  /** Label for the phase line read by screen readers, e.g. "Ranked". */
  label: string;
  /** Menu button: id and text. */
  menuId?: string;
  menuText?: string;
}

const code = (t: TeamSetup) => esc((t.short || t.name.slice(0, 3)).toUpperCase().slice(0, 3));

/** Markup for inside .pitch-wrap, after the canvas. */
export function hudMarkup(o: HudOptions): string {
  const [home, away] = o.teams;
  return `
    <div class="hud" data-hud>
      <div class="hud-tl">
        <div class="hud-crests" aria-hidden="true">
          <span class="hud-club">${crestSvg({ ...home, crest: o.crests[0] }, 26)}<b>${code(home)}</b></span>
          <span class="hud-club">${crestSvg({ ...away, crest: o.crests[1] }, 26)}<b>${code(away)}</b></span>
        </div>
        <div class="hud-bars">
          <div class="hud-bar scoreboard" title="${esc(home.name)} v ${esc(away.name)}">
            <span class="visually-hidden">${esc(home.name)}</span><span aria-hidden="true">${code(home)}</span>
            <span class="hud-goals"><span id="sb-h">0</span><span class="hud-dash">-</span><span id="sb-a">0</span></span>
            <span aria-hidden="true">${code(away)}</span><span class="visually-hidden">${esc(away.name)}</span>
          </div>
          <div class="hud-bar hud-clock"><span id="sb-clock">00:00</span><span class="visually-hidden"> · <span id="sb-min">1'</span> · <span id="sb-phase">${esc(o.label)}</span></span></div>
        </div>
      </div>
      <div class="hud-tr">
        <button class="hud-menu" id="${o.menuId ?? 'pause-btn'}" type="button" aria-keyshortcuts="Escape P" aria-label="${esc(o.menuText ?? 'Menu')}"><kbd aria-hidden="true">Esc</kbd>${esc(o.menuText ?? 'Menu')}</button>
        <span class="hud-mode">${esc(o.mode)}</span>
      </div>
      <div class="banner hud-word" id="banner" hidden></div>
      <canvas class="hud-radar" aria-hidden="true" style="aspect-ratio: ${PITCH_W} / ${PITCH_H}"></canvas>
      <div class="hud-me" aria-hidden="true" hidden><span class="hud-me-no"></span><span class="hud-me-name"></span><span class="hud-me-legs"><i></i></span></div>
      <div class="hud-power" aria-hidden="true"><span class="hud-power-label"></span><i></i><b style="left:${SWEET_SPOT * 100}%"></b></div>
      <div class="hud-hold" hidden></div>
      <div class="hud-replay" hidden><span>Replay</span><small></small></div>
      <div class="hud-tag" hidden role="status"></div>
      <div class="hud-fk" hidden aria-hidden="true"></div>
      <div class="hud-prompt" hidden role="status"></div>
    </div>`;
}

export interface Hud {
  /**
   * Every frame. `charge` is the human's shot charge (0 when not charging). `gauge`, when given,
   * drives the bar instead (src/client/power.ts hudGauge, the same numbers as the 3D aim wedge): the
   * shot or loft while it charges, or a click queued for a ball on its way; null hides the bar.
   */
  update(s: MatchState, charge: number, gauge?: Gauge | null): void;
  /** The REPLAY tag over an instant replay (top centre), or null to hide it. */
  replay(text: string | null): void;
  /** A small tag at the top for a call made while play goes on (Advantage), for `ms`. */
  tag(text: string, ms: number, sub?: string): void;
  /** Big centre word, with an optional smaller line under it. */
  word(text: string, ms: number, sub?: string): void;
  dispose(): void;
}

/**
 * The big HUD word for a referee's call (goals, half and full time are shown by the match view
 * from s.goals and the phase), with a smaller line under it.
 */
export function refereeWord(s: MatchState, e: MatchEvent): { word: string; sub?: string; live?: boolean } | null {
  const name = (i: number) => (i >= 0 && s.players[i] ? s.players[i].name : undefined);
  switch (e.kind) {
    case 'offside':
      return { word: 'Offside', sub: name(e.player) };
    case 'foul':
      // Play goes on under it, so it is a small tag at the top, not the big centre word.
      if (e.advantage) return { word: 'Advantage', sub: s.teams[e.team === 0 ? 1 : 0].name, live: true };
      return e.penalty ? { word: 'Penalty', sub: s.teams[e.team === 0 ? 1 : 0].name } : { word: 'Foul', sub: name(e.player) };
    case 'card':
      // A second yellow is followed by its red in the same tick; the red is the word left showing.
      return { word: e.color === 'yellow' ? 'Yellow card' : 'Red card', sub: e.secondYellow && e.color === 'red' ? `${e.name}, second yellow` : e.name };
    case 'restart':
      // The advantage came to nothing: play comes back for the foul.
      if (e.reason === 'advantage') return { word: e.restart === 'penalty' ? 'Penalty' : 'Free kick', sub: 'Advantage brought back' };
      if (e.reason === 'second-touch') return { word: 'Free kick', sub: `${s.teams[e.team].name} · second touch` };
      return null;
    case 'addedTime':
      return { word: `+${e.minutes}`, sub: `minute${e.minutes === 1 ? '' : 's'} added`, live: true };
    case 'abandoned':
      return { word: 'Abandoned', sub: `${s.teams[e.team].name} down to six` };
    default:
      return null;
  }
}

/** The free kick the HUD names: 'direct' while one is set up, 'indirect' from its set-up until a second touch, else ''. */
export function freeKickKind(s: MatchState): '' | 'direct' | 'indirect' {
  if (indirectPending(s)) return 'indirect';
  const r = s.restart;
  return r && r.kind === 'freekick' && r.stage !== 'whistle' ? 'direct' : '';
}

/** Match clock as MM:SS of the 90 shown minutes (matchSeconds: live play only, so it holds at stoppages). */
export function matchClock(s: MatchState): string {
  const secs = matchSeconds(s);
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const clock = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  // Law 7: the board is up; the clock holds while the added time is played.
  return inAddedTime(s) && s.added ? `${clock} +${s.added.minutes}` : clock;
}

/**
 * A human's kick-off waiting to be taken (Law 8: it is a kick): the side, and the seconds left before the CPU takes it
 * for them (RESTART_HUMAN_WAIT). Null otherwise, or when the CPU takes this one (its side has no human on the taker).
 */
export function kickoffWait(s: MatchState): { team: 0 | 1; secs: number } | null {
  const r = s.restart;
  if (s.phase !== 'restart' || !r || r.kind !== 'kickoff' || r.stage !== 'ready' || !s.humans[r.team] || s.controlled[r.team] !== r.taker) return null;
  return { team: r.team, secs: Math.max(1, Math.ceil((RESTART_HUMAN_WAIT - r.ticks) / TICK_HZ)) };
}

/**
 * What the kick-off prompt says for a side: who kicks off and how (e.g. "Player 2 kicks off: press Enter"), or null for none.
 * Each view knows its players and keys (hot-seat has two on one keyboard; Link and Online one per screen).
 */
export type KickoffPrompt = (team: 0 | 1) => string | null;

export function mountHud(wrap: HTMLElement, s0: MatchState, kickoffPrompt: KickoffPrompt | null = null): Hud {
  const q = <T extends HTMLElement>(sel: string) => wrap.querySelector<T>(sel)!;
  // A human's kick-off waiting: who kicks off, with which key, and how long before the CPU takes it.
  const prompt = q('.hud-prompt');
  let lastPrompt = '';
  const banner = q('#banner');
  const clock = q('#sb-clock');
  const radar = q<HTMLCanvasElement>('.hud-radar');
  const power = q('.hud-power');
  const fill = power.querySelector('i') as HTMLElement;
  const powerLabel = q('.hud-power-label');
  // The man you control (one human only): shirt number, name and his legs (energy), Power Soccer style.
  const me = q('.hud-me');
  const meNo = q('.hud-me-no');
  const meName = q('.hud-me-name');
  const meLegs = q('.hud-me-legs');
  const meFill = meLegs.querySelector('i') as HTMLElement;
  let lastMe = '';
  // The human's keeper with the ball in his hands: seconds left to play it (Law 12), src/sim/human.ts.
  const hold = q('.hud-hold');
  let lastHold: number | null = null;
  const tick = power.querySelector('b') as HTMLElement;
  const replayTag = q('.hud-replay');
  const callTag = q('.hud-tag');
  let tagUntil = 0;
  // Which kind of free kick is being taken (Law 13), until it is a goal or not: from the set-up, while an
  // indirect one is still waiting for a second touch (the referee's arm is up for that long too).
  const fkTag = q('.hud-fk');
  let lastFk = '';
  let lastGauge = '';
  const ctx = radar.getContext('2d');
  let until = 0;
  let lastClock = '';
  let lastCharge = -1;
  const colors: [string, string] = [s0.teams[0].primary, s0.teams[1].primary];
  // Radar dot outlines: light round a dark kit, dark round a light one, so every team's dots stand
  // off the dark radar panel.
  const rims = colors.map((c) => (luma(c) < 0.35 ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.9)'));

  function drawRadar(s: MatchState) {
    if (!ctx) return;
    const r = radar.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (radar.width !== w || radar.height !== h) {
      radar.width = w;
      radar.height = h;
    }
    const pad = 4 * dpr;
    const k = Math.min((w - 2 * pad) / PITCH_W, (h - 2 * pad) / PITCH_H);
    const ox = (w - PITCH_W * k) / 2;
    const oy = (h - PITCH_H * k) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // A dark panel, so kit-coloured dots read even when the kit is the grass's colour (a green team's
    // dots on a see-through radar over green grass vanished).
    ctx.fillStyle = 'rgba(8,12,10,.62)';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.2 / k;
    ctx.strokeRect(0, 0, PITCH_W, PITCH_H);
    ctx.beginPath();
    ctx.moveTo(PITCH_W / 2, 0);
    ctx.lineTo(PITCH_W / 2, PITCH_H);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(PITCH_W / 2, PITCH_H / 2, CENTRE_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeRect(0, (PITCH_H - BOX_W) / 2, BOX_DEPTH, BOX_W);
    ctx.strokeRect(PITCH_W - BOX_DEPTH, (PITCH_H - BOX_W) / 2, BOX_DEPTH, BOX_W);
    const dot = (2.3 * dpr) / k;
    for (const p of s.players) {
      if (p.sentOff) continue;
      const ctrl = s.humans[p.team] && s.controlled[p.team] === p.i;
      ctx.fillStyle = colors[p.team];
      ctx.strokeStyle = ctrl ? HUMAN_COLORS[s.humans[0] && s.humans[1] ? p.team : 0] : rims[p.team];
      ctx.lineWidth = (ctrl ? 1.6 : 1.1) * dpr / k;
      ctx.beginPath();
      if (p.team === 0) ctx.arc(p.pos.x, p.pos.y, dot, 0, Math.PI * 2);
      else {
        // Away: triangles pointing where they face.
        const fl = Math.hypot(p.facing.x, p.facing.y) || 1;
        const fx = p.facing.x / fl;
        const fy = p.facing.y / fl;
        const r2 = dot * 1.35;
        ctx.moveTo(p.pos.x + fx * r2, p.pos.y + fy * r2);
        ctx.lineTo(p.pos.x - fx * r2 * 0.7 - fy * r2 * 0.8, p.pos.y - fy * r2 * 0.7 + fx * r2 * 0.8);
        ctx.lineTo(p.pos.x - fx * r2 * 0.7 + fy * r2 * 0.8, p.pos.y - fy * r2 * 0.7 - fx * r2 * 0.8);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.ball.pos.x, s.ball.pos.y, dot * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMe(s: MatchState) {
    const team: 0 | 1 | null = s.humans[0] && !s.humans[1] ? 0 : s.humans[1] && !s.humans[0] ? 1 : null;
    const p = team === null ? undefined : s.players[s.controlled[team]];
    // Energy in 5% steps, so the DOM changes a few times a minute, not every frame.
    const legs = p ? Math.round(p.energy * 20) * 5 : 0;
    const key = p && !p.sentOff ? `${p.i}|${legs}|${p.winded}` : '';
    if (key === lastMe) return;
    lastMe = key;
    me.hidden = !key;
    if (!p || !key) return;
    meNo.textContent = String(p.number);
    meNo.style.background = colors[p.team];
    meNo.style.color = s.teams[p.team].secondary;
    meName.textContent = p.name;
    meFill.style.width = `${legs}%`;
    meLegs.classList.toggle('low', legs <= 35);
    me.classList.toggle('winded', p.winded);
  }

  const hud: Hud = {
    update(s, charge, gauge) {
      const ko = kickoffPrompt ? kickoffWait(s) : null;
      const say = ko ? kickoffPrompt!(ko.team) : null;
      const pr = say && ko ? `${say} · the CPU takes it in ${ko.secs} s` : '';
      if (pr !== lastPrompt) {
        lastPrompt = pr;
        prompt.hidden = !pr;
        if (say && ko) prompt.innerHTML = `<b>${esc(say)}</b> <small>the CPU takes it in ${ko.secs} s</small>`;
      }
      const c = matchClock(s);
      if (c !== lastClock) {
        clock.textContent = c;
        lastClock = c;
      }
      if (gauge !== undefined) {
        // Shown only while a kick charges or a click is queued (power.ts hudGauge); hidden while he dribbles.
        const g = gauge;
        const key = g ? `${Math.round(g.fill * 100)}|${g.band}|${g.tick}` : '';
        if (key !== lastGauge) {
          lastGauge = key;
          fill.style.width = `${g ? Math.round(g.fill * 100) : 0}%`;
          tick.style.left = `${(g ? g.tick : SWEET_SPOT) * 100}%`;
          tick.hidden = !!g && g.tick >= 1;
          power.classList.toggle('on', !!g);
          power.classList.toggle('amber', g?.band === 'amber');
          power.classList.toggle('hot', g?.band === 'red');
          powerLabel.textContent = g ? GAUGE_LABEL[g.kind] : '';
        }
      } else if (charge !== lastCharge) {
        lastCharge = charge;
        fill.style.width = `${Math.round(charge * 100)}%`;
        power.classList.toggle('on', charge > 0);
        power.classList.toggle('hot', charge > SWEET_SPOT + 0.05);
      }
      const left = keeperHoldLeft(s, 0) ?? keeperHoldLeft(s, 1);
      if (left !== lastHold) {
        lastHold = left;
        hold.hidden = left === null;
        if (left !== null) hold.textContent = `Keeper · ${left}`;
        hold.classList.toggle('hot', left !== null && left <= 2);
      }
      drawMe(s);
      drawRadar(s);
      const fk = freeKickKind(s);
      if (fk !== lastFk) {
        lastFk = fk;
        fkTag.hidden = !fk;
        fkTag.classList.toggle('indirect', fk === 'indirect');
        fkTag.innerHTML = fk === 'indirect' ? '<b>Indirect</b> free kick <small>a goal needs a second touch</small>' : fk === 'direct' ? '<b>Direct</b> free kick' : '';
      }
      if (tagUntil && performance.now() > tagUntil) {
        callTag.hidden = true;
        tagUntil = 0;
      }
      if (until && performance.now() > until) {
        banner.hidden = true;
        until = 0;
      }
    },
    word(text, ms, sub) {
      banner.innerHTML = `<span>${esc(text)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`;
      banner.hidden = false;
      // Restart the pop-in animation.
      banner.style.animation = 'none';
      void banner.offsetWidth;
      banner.style.animation = '';
      until = performance.now() + ms;
    },
    tag(text, ms, sub) {
      callTag.innerHTML = `<b>${esc(text)}</b>${sub ? ` ${esc(sub)}` : ''}`;
      callTag.hidden = false;
      tagUntil = performance.now() + ms;
    },
    replay(text) {
      replayTag.hidden = text === null;
      if (text !== null) replayTag.querySelector('small')!.textContent = text;
    },
    dispose() {
      until = 0;
    },
  };
  return hud;
}

/** Relative luminance (0..1) of a #rrggbb colour, for picking a contrasting outline. */
function luma(hex: string): number {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(f.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
