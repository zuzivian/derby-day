// Match "juice": sound hookup, mute button, goal shake and confetti, kick-off
// label. Self-contained so matchView only needs to call mountJuice() once,
// tick() after each sim step and dispose() on the way out.
//
// Nothing here touches the pitch renderer. Effects live on an overlay canvas
// (pointer-events: none) and on CSS transforms of the pitch wrapper.

import type { MatchState } from '../sim/types.ts';
import { crowdLevel, detectSfx, getSound, initialSnapshot, snapshot, type SfxEvent, type Snapshot } from './audio.ts';

export interface Juice {
  /** Call after every sim step with the live state. */
  tick(s: MatchState): void;
  dispose(): void;
}

const STYLE_ID = 'juice-style';
const CSS = `
.match { overflow-x: clip; }
.juice-fx, .juice-flash { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; border-radius: 10px; }
.juice-flash { opacity: 0; }
.juice-label {
  position: absolute; left: 50%; bottom: 11%; transform: translateX(-50%); pointer-events: none; opacity: 0;
  font-family: var(--font-display, inherit); font-weight: 800; font-size: clamp(14px, 2.4vw, 22px); letter-spacing: .32em;
  text-transform: uppercase; color: rgba(255, 255, 255, .85); text-shadow: 0 1px 0 rgba(0, 0, 0, .5), 0 0 12px rgba(0, 0, 0, .4); white-space: nowrap;
}
.juice-mute {
  position: absolute; top: 8px; right: 8px; width: 36px; height: 36px; padding: 0; display: grid; place-items: center;
  border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, .7); background: rgba(15, 21, 19, .55); color: #fff; cursor: pointer;
  touch-action: manipulation;
}
.juice-mute:hover { background: rgba(15, 21, 19, .75); }
.juice-mute:focus-visible { outline: 3px solid #ffd60a; outline-offset: 2px; }
.juice-mute svg { width: 20px; height: 20px; display: block; }
.juice-mute .x { display: none; }
.juice-mute[aria-pressed="true"] .waves { display: none; }
.juice-mute[aria-pressed="true"] .x { display: block; }
`;

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>
<g class="waves"><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/></g>
<g class="x"><path d="M16 9.5l5 5M21 9.5l-5 5"/></g></svg>`;

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  age: number;
  life: number;
}

export function mountJuice(root: HTMLElement, s: MatchState): Juice {
  const sound = getSound();
  const wrap = root.querySelector<HTMLElement>('.pitch-wrap');
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // Elements go in before the pause overlay so pause still covers them.
  const cleanup: (() => void)[] = [];
  let canvas: HTMLCanvasElement | null = null;
  let flash: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let btn: HTMLButtonElement | null = null;
  if (wrap) {
    canvas = document.createElement('canvas');
    canvas.className = 'juice-fx';
    canvas.setAttribute('aria-hidden', 'true');
    flash = document.createElement('div');
    flash.className = 'juice-flash';
    flash.setAttribute('aria-hidden', 'true');
    label = document.createElement('div');
    label.className = 'juice-label';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = 'Kick-off';
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'juice-mute';
    btn.id = 'juice-mute';
    btn.setAttribute('aria-label', 'Mute sound');
    btn.innerHTML = ICON;
    const anchor = wrap.querySelector('#pause');
    for (const el of [canvas, flash, label, btn]) anchor ? wrap.insertBefore(el, anchor) : wrap.appendChild(el);
  }

  // -- mute ----------------------------------------------------------------
  const syncMute = () => {
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(sound.muted));
    btn.title = sound.muted ? 'Sound off (M)' : 'Sound on (M)';
  };
  syncMute();
  cleanup.push(sound.onChange(syncMute));
  if (btn) {
    const b = btn;
    b.addEventListener('click', (e) => {
      sound.toggle();
      // Mouse users shouldn't leave focus here: Space is the pass key.
      if (e.detail > 0) b.blur();
    });
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === ' ' && btn && document.activeElement === btn) btn.blur(); // Space plays; Enter toggles
    else if (e.key.toLowerCase() === 'm') sound.toggle();
  };
  // Browsers may start the AudioContext suspended; any gesture wakes it.
  const wake = () => sound.unlock();
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', wake, true);
  window.addEventListener('keydown', wake, true);
  cleanup.push(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', wake, true);
    window.removeEventListener('keydown', wake, true);
  });
  sound.startCrowd();

  // -- confetti --------------------------------------------------------------
  let particles: Particle[] = [];
  let raf = 0;
  let lastT = 0;
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  const ctx = canvas?.getContext('2d') ?? null;

  const resize = () => {
    if (!canvas || !wrap) return;
    const r = wrap.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = r.width;
    ch = r.height;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
  };
  resize();
  const ro = wrap ? new ResizeObserver(resize) : null;
  if (ro && wrap) ro.observe(wrap);

  function drawConfetti(now: number) {
    if (!ctx || !canvas) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    particles = particles.filter((p) => (p.age += dt) < p.life);
    for (const p of particles) {
      p.vy += 760 * dt;
      p.vx *= 1 - 0.9 * dt;
      p.vy *= 1 - 0.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const fade = Math.min(1, (p.life - p.age) / 0.7);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // Flutter: squash the height as it spins.
      ctx.scale(1, Math.cos(p.age * 9 + p.rot));
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (particles.length) raf = requestAnimationFrame(drawConfetti);
    else {
      raf = 0;
      ctx.clearRect(0, 0, cw, ch);
    }
  }

  function confetti(team: 0 | 1) {
    if (!ctx) return;
    resize();
    const t = s.teams[team];
    const colours = [t.primary, t.secondary, t.primary, '#ffd60a', '#ffffff'];
    const scale = Math.min(1, cw / 640);
    const n = Math.round(150 * Math.max(0.5, scale));
    const goalX = team === 0 ? cw * 0.98 : cw * 0.02;
    const spray = team === 0 ? Math.PI : 0; // direction pointing back into the pitch
    for (let i = 0; i < n; i++) {
      const fromGoal = i % 3 !== 0;
      const speed = (fromGoal ? 380 + Math.random() * 520 : 120 + Math.random() * 260) * Math.max(0.6, scale);
      const ang = fromGoal ? spray + (Math.random() - 0.5) * 1.5 + 0.5 * (team === 0 ? 1 : -1) : -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      particles.push({
        x: fromGoal ? goalX : cw * (0.25 + Math.random() * 0.5),
        y: fromGoal ? ch * (0.4 + Math.random() * 0.2) : ch * 0.08,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 14,
        w: (5 + Math.random() * 5) * Math.max(0.7, scale),
        h: (3 + Math.random() * 4) * Math.max(0.7, scale),
        color: colours[(Math.random() * colours.length) | 0],
        age: 0,
        life: 2.0 + Math.random() * 1.0,
      });
    }
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(drawConfetti);
    }
  }

  // -- shake / flash / label -----------------------------------------------
  const anims: Animation[] = [];
  const animate = (el: HTMLElement | null, kf: Keyframe[], opts: KeyframeAnimationOptions) => {
    if (!el || typeof el.animate !== 'function') return;
    const a = el.animate(kf, opts);
    anims.push(a);
    a.onfinish = () => anims.splice(anims.indexOf(a), 1);
  };

  function shake() {
    const frames: Keyframe[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const amp = 7 * (1 - i / steps) ** 1.5;
      frames.push({ transform: `translate(${(i % 2 ? 1 : -1) * amp}px, ${((i % 3) - 1) * amp * 0.6}px)` });
    }
    animate(wrap, frames, { duration: 520, easing: 'linear' });
  }

  function goal(team: 0 | 1) {
    if (reducedMotion()) {
      // No shake or particles: a slow, soft wash of the scorer's colour.
      if (flash) flash.style.background = s.teams[team].primary;
      animate(flash, [{ opacity: 0 }, { opacity: 0.28, offset: 0.25 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' });
      return;
    }
    shake();
    confetti(team);
  }

  function kickoff() {
    animate(label, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.65 }, { opacity: 0 }], { duration: 1000, easing: 'ease-out' });
  }

  // -- the hook ----------------------------------------------------------------
  let prev: Snapshot = initialSnapshot(s);
  const handle = (ev: SfxEvent) => {
    sound.play(ev);
    if (ev.type === 'goal') goal(ev.team);
    else if (ev.type === 'whistle' && ev.kind === 'kickoff') kickoff();
  };

  return {
    tick(state: MatchState) {
      for (const ev of detectSfx(prev, state)) handle(ev);
      prev = snapshot(state);
      if (state.tick % 6 === 0) sound.setCrowd(crowdLevel(state));
    },
    dispose() {
      cleanup.forEach((c) => c());
      ro?.disconnect();
      cancelAnimationFrame(raf);
      for (const a of anims) a.cancel();
      sound.stopCrowd();
      for (const el of [canvas, flash, label, btn]) el?.remove();
    },
  };
}
