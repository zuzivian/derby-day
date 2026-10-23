// Runs a live match: fixed 60 Hz sim steps on a requestAnimationFrame loop,
// with the HUD in DOM and the pitch on canvas.

import { DT } from '../sim/constants.ts';
import { createMatch, matchMinute, step, type MatchOptions } from '../sim/match.ts';
import type { MatchState } from '../sim/types.ts';
import { announce, trapTab } from './a11y.ts';
import { crestSvg } from './crest.ts';
import { mountJuice } from './fx.ts';
import { InputController } from './input.ts';
import { PitchRenderer } from './render.ts';
import type { CrestPattern } from '../meta/names.ts';

export interface MatchViewOptions extends MatchOptions {
  crests: [CrestPattern, CrestPattern];
  label: string;
  /** Pause-menu text for leaving early. Defaults by label (ranked forfeits count as 0–3). */
  forfeitText?: string;
  /** Preferred control style; the input still follows whatever the player touches. */
  controls?: 'mouse' | 'keys';
  onEnd: (s: MatchState, forfeited: boolean) => void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function mountMatch(root: HTMLElement, o: MatchViewOptions): () => void {
  const s = createMatch(o);
  const [home, away] = s.teams;
  root.innerHTML = `
  <section class="match" aria-label="Match">
    <header class="scoreboard">
      <div class="sb-team">${crestSvg({ ...home, crest: o.crests[0] }, 28)}<span class="sb-name">${esc(home.name)}</span></div>
      <div class="sb-center">
        <div class="sb-score"><span id="sb-h">0</span><span class="sb-dash">–</span><span id="sb-a">0</span></div>
        <div class="sb-clock"><span id="sb-min">1'</span> · <span id="sb-phase">${esc(o.label)}</span></div>
      </div>
      <div class="sb-team sb-away"><span class="sb-name">${esc(away.name)}</span>${crestSvg({ ...away, crest: o.crests[1] }, 28)}</div>
    </header>
    <div class="pitch-wrap">
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Pitch. Mouse: move to run, left click to pass or tackle, hold right button to shoot. Keys: WASD or arrows to run, Space to pass or tackle, hold F to shoot, E to switch, Esc to pause."></canvas>
      <button class="pitch-pause" id="pause-btn" type="button" aria-keyshortcuts="Escape P">Pause</button>
      <div class="banner" id="banner" hidden></div>
      <div class="pause" id="pause" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <h2 id="pause-title">Paused</h2>
          <div class="pause-actions">
            <button class="btn primary" id="resume">Resume</button>
            <button class="btn" id="forfeit">${esc(o.forfeitText ?? (o.label === 'Ranked' ? 'Forfeit (counts as 0–3)' : 'Leave match'))}</button>
          </div>
          <p class="hint">Esc or P pauses.</p>
        </div>
      </div>
      <div class="touch-pad" aria-hidden="true">
        <button class="pad-btn" id="pad-pass">Pass</button>
        <button class="pad-btn shoot" id="pad-shoot">Shoot</button>
      </div>
    </div>
    <p class="controls-hint"><b>Mouse:</b> your player runs to the pointer · <b>left click</b> pass / tackle · <b>hold right</b> to shoot · <b>right click</b> switch · <b>Shift</b> or <b>middle button</b> sprint · <b>Ctrl+click</b> through ball · <b>Ctrl + hold right</b> chip. <b>Keys:</b> WASD · Space · R through · hold F shoot · hold C chip · Shift · E.</p>
  </section>`;

  const canvas = root.querySelector<HTMLCanvasElement>('#pitch')!;
  const renderer = new PitchRenderer(canvas);
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  let paused = false;
  let done = false;
  let focusBeforePause: HTMLElement | null = null;
  const setPaused = (v: boolean) => {
    if (done || v === paused) return;
    paused = v;
    $('pause').hidden = !v;
    if (v) {
      focusBeforePause = document.activeElement as HTMLElement | null;
      $('resume').focus();
      announce('Paused.');
    } else {
      (focusBeforePause && root.contains(focusBeforePause) ? focusBeforePause : canvas).focus();
    }
  };
  const input = new InputController(canvas, renderer, () => s.controlled >= 0 && s.ball.owner === s.controlled, () => setPaused(!paused));
  if (o.controls) input.mode = o.controls;
  input.bindTouchButtons($('pad-pass'), $('pad-shoot'));
  $('pause-btn').addEventListener('click', () => setPaused(true));
  $('resume').addEventListener('click', () => setPaused(false));
  $('forfeit').addEventListener('click', () => finish(true));
  const onVis = () => document.hidden && setPaused(true);
  document.addEventListener('visibilitychange', onVis);
  const onKey = (e: KeyboardEvent) => paused && trapTab($('pause'), e);
  document.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);
  renderer.resize();
  const juice = mountJuice(root, s);

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let lastGoals = 0;
  let bannerUntil = 0;
  let shownHalftime = false;
  const scoreLine = () => `${home.name} ${s.score[0]}, ${away.name} ${s.score[1]}.`;

  function banner(text: string, ms: number) {
    const b = $('banner');
    b.textContent = text;
    b.hidden = false;
    bannerUntil = performance.now() + ms;
  }

  function finish(forfeited: boolean) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    dispose();
    o.onEnd(s, forfeited);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const elapsed = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) {
      acc += elapsed;
      let steps = 0;
      while (acc >= DT && steps < 6) {
        step(s, input.take());
        juice.tick(s);
        acc -= DT;
        steps++;
      }
    }
    renderer.draw(s, { cursor: input.cursor, charge: input.charge(), showCursor: input.mode === 'mouse', armed: input.armed() });

    $('sb-h').textContent = String(s.score[0]);
    $('sb-a').textContent = String(s.score[1]);
    $('sb-min').textContent = `${matchMinute(s)}'`;
    $('sb-phase').textContent = s.phase === 'halftime' ? 'Half-time' : s.phase === 'fulltime' ? 'Full-time' : s.half === 1 ? `${o.label} · 1st half` : `${o.label} · 2nd half`;

    if (s.events.length > lastGoals) {
      const ev = s.events[s.events.length - 1];
      lastGoals = s.events.length;
      banner(`Goal! ${ev.scorer} ${ev.minute}'`, 2000);
      announce(`Goal for ${s.teams[ev.team].name}. ${ev.scorer}, minute ${ev.minute}. ${scoreLine()}`);
    }
    if (s.phase === 'halftime' && !shownHalftime) {
      shownHalftime = true;
      banner('Half-time', 1800);
      announce(`Half-time. ${scoreLine()}`);
    }
    if (bannerUntil && now > bannerUntil) {
      $('banner').hidden = true;
      bannerUntil = 0;
    }
    if (s.phase === 'fulltime') {
      banner('Full-time', 99999);
      announce(`Full-time. ${scoreLine()}`);
      setTimeout(() => finish(false), 1100);
      cancelAnimationFrame(raf);
    }
  }
  raf = requestAnimationFrame(frame);
  canvas.focus({ preventScroll: true });
  announce(`${o.label} match. ${home.name} against ${away.name}. Esc pauses.`);

  function dispose() {
    input.dispose();
    juice.dispose();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('keydown', onKey);
  }
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    dispose();
  };
}
