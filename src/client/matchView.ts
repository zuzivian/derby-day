// Runs a live match: fixed 60 Hz sim steps on a requestAnimationFrame loop,
// with the HUD in DOM and the pitch on canvas.

import { DT } from '../sim/constants.ts';
import { createMatch, matchMinute, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchState, TeamInputs } from '../sim/types.ts';
import { announce, trapTab } from './a11y.ts';
import { crestSvg } from './crest.ts';
import { mountJuice } from './fx.ts';
import { InputController } from './input.ts';
import { PitchRenderer, type RenderExtras } from './render.ts';
import { ReplayRecorder } from '../meta/replay.ts';
import { clearLastReplay, storeReplay } from './replayStore.ts';
import type { CrestPattern } from '../meta/names.ts';

export interface MatchViewOptions extends MatchOptions {
  crests: [CrestPattern, CrestPattern];
  label: string;
  /** Pause-menu text for leaving early. Defaults by label (ranked forfeits count as 0–3). */
  forfeitText?: string;
  /** Preferred control style; the input still follows whatever the player touches. */
  controls?: 'mouse' | 'keys';
  onEnd: (s: MatchState, forfeited: boolean) => void;
  /** Replaces the default mouse/keyboard controller, e.g. two keyboard pads for hot-seat (versus.ts). */
  inputSource?: (canvas: HTMLCanvasElement, renderer: PitchRenderer, s: MatchState, togglePause: () => void) => MatchInputSource;
  /** Replaces the controls line under the pitch (HTML). */
  controlsHint?: string;
}

/** Where a live match gets its per-tick input and the renderer's cursor and previews. */
export interface MatchInputSource {
  take(): HumanInput | TeamInputs;
  extras(): RenderExtras;
  dispose(): void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function mountMatch(root: HTMLElement, o: MatchViewOptions): () => void {
  const s = createMatch(o);
  // End-to-end tests set window.__e2e before the page loads to get at the live state (to set a scene up and read it back).
  if ((globalThis as { __e2e?: boolean }).__e2e) (globalThis as { __derbyMatch?: MatchState }).__derbyMatch = s;
  // Replays record one human's input; two-human matches (hot-seat) aren't recorded.
  const rec = o.humans?.[0] && o.humans?.[1] ? null : new ReplayRecorder(o, o.label);
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
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Pitch. Mouse: move to run, the further the pointer the faster. With the ball, left click to pass to the pointer, hold left to loft, right click to shoot. Without it, left click to pick a player, right click to tackle. Keys: WASD or arrows to run, Space to pass or tackle, hold F to shoot, hold C to loft, E to switch, Shift to sprint, Esc to pause."></canvas>
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
        <button class="pad-btn" id="pad-pass" aria-label="Pass: tap to pass, hold to loft">Pass</button>
        <button class="pad-btn shoot" id="pad-shoot">Shoot</button>
      </div>
    </div>
    <p class="controls-hint">${o.controlsHint ?? `<b>Mouse:</b> your player runs to the pointer, faster the further it is. <b>With the ball:</b> <b>left click</b> pass to the pointer · <b>hold left</b> loft · <b>right click</b> shoot (hold for power). <b>Without:</b> <b>left click</b> pick a player · <b>right click</b> tackle (slide if far). <b>Keys:</b> WASD · Space pass / tackle · hold F shoot · hold C loft · Shift sprint · E switch.`}</p>
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
  const input: MatchInputSource = o.inputSource?.(canvas, renderer, s, () => setPaused(!paused)) ?? defaultInput();
  function defaultInput(): MatchInputSource {
    const c = new InputController(canvas, renderer, () => s.controlled[0] >= 0 && s.ball.owner === s.controlled[0], () => setPaused(!paused));
    if (o.controls) c.mode = o.controls;
    c.bindTouchButtons($('pad-pass'), $('pad-shoot'));
    return { take: () => c.take(), extras: () => ({ cursor: c.cursor, charge: c.charge(), showCursor: c.mode === 'mouse', armed: c.armed(), switchTo: c.switchCandidate(s) }), dispose: () => c.dispose() };
  }
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
    if (forfeited) clearLastReplay();
    else if (rec) storeReplay(rec.finish(s, Date.now() / 1000));
    else clearLastReplay(); // so the result dialog doesn't offer the previous match's replay
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
        const raw = input.take();
        step(s, rec && !Array.isArray(raw) ? rec.push(raw) : raw);
        juice.tick(s);
        acc -= DT;
        steps++;
      }
    }
    renderer.draw(s, input.extras());

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
