// Training ground: the first-run tutorial on the real pitch. Same sim, renderer
// and input as a match; drills.ts decides what is being taught and when it is
// passed. Four drills: move, pass, shoot, win the ball back.

import { DT, GOAL_BOTTOM, GOAL_TOP, PITCH_W } from '../sim/constants.ts';
import { step } from '../sim/match.ts';
import type { TeamSetup } from '../sim/types.ts';
import { announce, reducedMotion, trapTab } from './a11y.ts';
import { checkDrill, createTraining, CARRIER, DRILLS, filterInput, holdFrozen, HUMAN, MARKER_R, stageDrill, type DrillId, type Hint, type Retry } from './drills.ts';
import { InputController } from './input.ts';
import { PitchRenderer } from './render.ts';
import type { ControlStyle } from './store.ts';

export interface TutorialOptions {
  home: TeamSetup;
  controls: ControlStyle;
  /** Called once, after the view has cleaned up. `completed` is false when skipped. */
  onDone: (completed: boolean) => void;
  /** Heading level for the section title: 2 inside setup, 1 when it is the whole page. */
  headingLevel?: 1 | 2;
}

type Mode = 'mouse' | 'keys' | 'touch';

const COPY: Record<DrillId, { title: string; text: Record<Mode, string>; done: string }> = {
  move: {
    title: 'Run to the marker',
    text: {
      mouse: 'Your player, under the yellow arrow, runs to the pointer, and the further away the pointer, the faster. Move the pointer onto the marker.',
      keys: 'Use WASD or the arrow keys to run your player, under the yellow arrow, onto the marker.',
      touch: 'Touch and drag on the pitch. Your player, under the yellow arrow, runs to your finger. Run onto the marker.',
    },
    done: 'Good run.',
  },
  pass: {
    title: 'Pass to a teammate',
    text: {
      mouse: 'Move the pointer onto a teammate and left click. The ball rolls to the pointer; the dotted line shows where it will go. (Hold the left button instead to loft it.)',
      keys: 'Run toward a teammate so you face them, then press Space to pass.',
      touch: 'Drag your finger onto a teammate, then tap Pass. The ball goes to your finger; the dotted line shows where. (Hold Pass to loft it.)',
    },
    done: 'Good pass.',
  },
  shoot: {
    title: 'Shoot and score',
    text: {
      mouse: 'Point at the goal and right click to shoot at the pointer. Hold the right button first for a harder shot. Their keeper is having a rest.',
      keys: 'Hold F to power up, release to shoot at goal. Hold W or S as you release to aim high or low.',
      touch: 'Point at the goal. Hold Shoot to power up, release to strike.',
    },
    done: 'Goal.',
  },
  tackle: {
    title: 'Win the ball back',
    text: {
      mouse: 'Their striker has the ball. Run at them, then right click to tackle toward the pointer. Right click with the pointer further out to slide.',
      keys: 'Their striker has the ball. Run into their path, then press Space when you touch.',
      touch: 'Their striker has the ball. Run into their path, then tap Shoot to tackle (without the ball, Shoot is your tackle).',
    },
    done: 'Ball won. That is the whole game.',
  },
};

const RETRY: Record<Retry, string> = {
  'walked-in': 'Nice, but stay on the drill. Setting it up again.',
  'no-receiver': 'Nobody got that one. Aim at a teammate this time.',
  missed: 'Not this time. Setting it up again.',
  'shoot-it': 'That counts in a match, but shoot it this time.',
  conceded: 'They scored. Get close, then tackle.',
  saved: 'Your keeper saved it. Get there first this time.',
  'lost-it': 'Setting it up again. Get close, then tackle.',
};

const HINT: Record<Hint, string> = {
  'too-far': 'Too far away. A missed tackle slows you down. Get in front of them, then tackle.',
  'kept-it': 'Close. They kept the ball. Try again.',
};

export function mountTutorial(container: HTMLElement, o: TutorialOptions): () => void {
  const s = createTraining(4242, o.home);
  // End-to-end tests set window.__e2e before the page loads to read the live state.
  if ((globalThis as { __e2e?: boolean }).__e2e) (globalThis as { __derbyMatch?: unknown }).__derbyMatch = s;
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const h = `h${o.headingLevel ?? 2}`;
  container.innerHTML = `
  <section class="training" aria-labelledby="tr-title">
    <div class="training-head">
      <div>
        <p class="eyebrow">Practice skills</p>
        <${h} id="tr-title" class="training-title" tabindex="-1">Learn the controls</${h}>
      </div>
      <button class="btn small ghost" id="tr-skip" type="button">Leave</button>
    </div>
    <div class="coach" id="coach">
      <div class="coach-top">
        <span class="coach-count" id="coach-count"></span>
        <ol class="coach-dots" aria-hidden="true">${DRILLS.map((d) => `<li data-drill="${d}"></li>`).join('')}</ol>
      </div>
      <h3 class="coach-title" id="coach-title"></h3>
      <p class="coach-text" id="coach-text"></p>
      <p class="coach-note" id="coach-note"></p>
    </div>
    <div class="pitch-wrap training-pitch">
      <canvas id="tr-pitch" class="pitch-canvas" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Training pitch" aria-describedby="coach-title coach-text"></canvas>
      <button class="pitch-pause" id="tr-pause" type="button" aria-keyshortcuts="Escape P">Pause</button>
      <div class="pause" id="tr-paused" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="tr-paused-title">
          <h2 id="tr-paused-title">Paused</h2>
          <div class="pause-actions">
            <button class="btn primary" id="tr-resume" type="button">Resume</button>
            <button class="btn" id="tr-skip-2" type="button">Leave</button>
          </div>
          <p class="hint">Esc or P pauses and resumes.</p>
        </div>
      </div>
      <div class="touch-pad" aria-hidden="true">
        <button class="pad-btn" id="tr-pad-pass" tabindex="-1">Pass</button>
        <button class="pad-btn shoot" id="tr-pad-shoot" tabindex="-1">Shoot</button>
      </div>
    </div>
  </section>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  const canvas = $<HTMLCanvasElement>('tr-pitch');
  const renderer = new PitchRenderer(canvas);
  const ctx = canvas.getContext('2d')!;
  let paused = false;
  let finished = false;
  let focusBeforePause: HTMLElement | null = null;

  const setPaused = (v: boolean) => {
    if (finished || paused === v) return;
    paused = v;
    $('tr-paused').hidden = !v;
    if (v) {
      focusBeforePause = document.activeElement as HTMLElement | null;
      $('tr-resume').focus();
      announce('Paused.');
    } else {
      (focusBeforePause && container.contains(focusBeforePause) ? focusBeforePause : canvas).focus();
      announce('Resumed.');
    }
  };
  const input = new InputController(canvas, renderer, () => s.controlled[0] >= 0 && s.ball.owner === s.controlled[0], () => setPaused(!paused));
  input.mode = o.controls;
  input.bindTouchButtons($('tr-pad-pass'), $('tr-pad-shoot'));
  const skip = () => finish(false);
  $('tr-skip').addEventListener('click', skip);
  $('tr-skip-2').addEventListener('click', skip);
  $('tr-pause').addEventListener('click', () => setPaused(true));
  $('tr-resume').addEventListener('click', () => setPaused(false));
  const onKey = (e: KeyboardEvent) => {
    if (paused) trapTab($('tr-paused'), e);
  };
  document.addEventListener('keydown', onKey);
  const onVis = () => document.hidden && setPaused(true);
  document.addEventListener('visibilitychange', onVis);
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);
  renderer.resize();

  let index = 0;
  let drill = stageDrill(s, DRILLS[0]);
  let mode: Mode = touch ? 'touch' : input.mode;
  let holdUntil = 0;
  let pending: (() => void) | null = null;
  const still = reducedMotion();

  function showDrill() {
    const c = COPY[drill.id];
    $('coach-count').textContent = `Drill ${index + 1} of ${DRILLS.length}`;
    $('coach-title').textContent = c.title;
    $('coach-text').textContent = c.text[mode];
    container.querySelectorAll<HTMLElement>('.coach-dots li').forEach((li, i) => {
      li.className = i < index ? 'done' : i === index ? 'on' : '';
    });
  }

  function note(text: string, good: boolean) {
    const n = $('coach-note');
    n.textContent = text;
    n.className = `coach-note ${good ? 'good' : 'again'}`;
  }

  function startDrill(i: number, fresh: boolean) {
    index = i;
    drill = stageDrill(s, DRILLS[i], fresh);
    $('coach-note').textContent = '';
    $('coach-note').className = 'coach-note';
    showDrill();
    const c = COPY[drill.id];
    announce(`Drill ${i + 1} of ${DRILLS.length}. ${c.title}. ${c.text[mode]}`);
  }

  function passed(now: number) {
    const c = COPY[drill.id];
    note(c.done, true);
    container.querySelectorAll<HTMLElement>('.coach-dots li')[index].className = 'done';
    holdUntil = now + 1100;
    if (index === DRILLS.length - 1) {
      announce(`${c.done} Training done.`);
      $('coach-count').textContent = 'Training done';
      pending = () => finish(true);
    } else {
      announce(c.done);
      const nextIndex = index + 1;
      // Move flows straight into pass from where the player stopped.
      pending = () => startDrill(nextIndex, DRILLS[nextIndex] !== 'pass');
    }
  }

  function retry(why: Retry, now: number) {
    const text = why === 'no-receiver' && mode === 'keys' ? 'Nobody got that one. Run a step toward a teammate so you face them, then press Space.' : RETRY[why];
    note(text, false);
    announce(text);
    holdUntil = now + 1100;
    pending = () => {
      drill = stageDrill(s, drill.id);
    };
  }

  function drawExtras(now: number) {
    // The renderer leaves its world transform on the context, so this draws in metres.
    const pulse = still ? 0 : Math.sin(now / 260) * 0.25;
    ctx.save();
    if (drill.marker) {
      const m = drill.marker;
      ctx.strokeStyle = '#ffd60a';
      ctx.fillStyle = 'rgba(255,214,10,.18)';
      ctx.lineWidth = 0.18;
      ctx.setLineDash([0.6, 0.35]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, MARKER_R + pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      // A cross, so the marker reads without colour.
      ctx.beginPath();
      ctx.moveTo(m.x - 0.6, m.y - 0.6);
      ctx.lineTo(m.x + 0.6, m.y + 0.6);
      ctx.moveTo(m.x + 0.6, m.y - 0.6);
      ctx.lineTo(m.x - 0.6, m.y + 0.6);
      ctx.stroke();
    }
    if (drill.id === 'shoot') {
      ctx.fillStyle = `rgba(255,214,10,${0.16 + pulse * 0.2})`;
      ctx.fillRect(PITCH_W - 0.2, GOAL_TOP, 1.8, GOAL_BOTTOM - GOAL_TOP);
    }
    if (drill.id === 'tackle' && s.ball.owner === CARRIER) {
      const c = s.players[CARRIER].pos;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 0.12;
      ctx.setLineDash([0.4, 0.3]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.7 + pulse * 0.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;
    const m: Mode = touch ? 'touch' : input.mode;
    if (m !== mode) {
      mode = m;
      showDrill();
    }
    if (!paused) {
      if (now < holdUntil) {
        input.take(); // drop clicks made during the pause between drills
        acc = 0;
      } else {
        if (pending) {
          const p = pending;
          pending = null;
          p();
          if (finished) return;
        }
        acc += elapsed;
        let steps = 0;
        while (acc >= DT && steps < 6) {
          acc -= DT;
          steps++;
          holdFrozen(s, drill);
          step(s, filterInput(drill.id, input.take()));
          holdFrozen(s, drill);
          const r = checkDrill(s, drill);
          if (r.done) {
            passed(now);
            break;
          }
          if (r.retry) {
            retry(r.retry, now);
            break;
          }
          if (r.hint) {
            note(HINT[r.hint], false);
            announce(HINT[r.hint]);
          }
        }
      }
    }
    renderer.draw(s, { cursor: input.cursor, charge: input.charge(), showCursor: input.mode === 'mouse' && !touch, armed: input.armed() });
    drawExtras(now);
  }

  function dispose() {
    cancelAnimationFrame(raf);
    input.dispose();
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  }

  function finish(completed: boolean) {
    if (finished) return;
    finished = true;
    dispose();
    o.onDone(completed);
  }

  showDrill();
  canvas.setAttribute('aria-label', `Training pitch. You control ${s.players[HUMAN].name}, number ${s.players[HUMAN].number}, marked by a yellow arrow.`);
  announce(`Practice skills. Drill 1 of ${DRILLS.length}. ${COPY.move.title}. ${COPY.move.text[mode]}`);
  canvas.focus({ preventScroll: true });
  raf = requestAnimationFrame(frame);

  return () => {
    if (finished) return;
    finished = true;
    dispose();
  };
}
