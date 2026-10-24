// Runs a live match: fixed 60 Hz sim steps on a requestAnimationFrame loop,
// with the HUD in DOM and the pitch on canvas. Also orchestrates instant
// replays: highlights.ts spots goals, cards, saves, the woodwork and near
// misses; at the next stoppage the live sim is held while the last few seconds
// are re-simulated from a snapshot buffer and shown with replay cameras, then
// play resumes exactly where it stopped.

import { DT, TICK_HZ } from '../sim/constants.ts';
import { createMatch, matchMinute, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchEvent, MatchState, TeamInputs } from '../sim/types.ts';
import { announce, trapTab } from './a11y.ts';
import { mountCoach, type CoachOptions } from './coach.ts';
import { mountJuice } from './fx.ts';
import { hudMarkup, mountHud, refereeWord } from './hud.ts';
import { HighlightSpotter, HIGHLIGHT_RANK, ReplayBuffer, type Highlight, type TickInput } from './highlights.ts';
import { InputController } from './input.ts';
import { kickGauge } from './power.ts';
import { createMatchRenderer, mountCameraToggle, type MatchRenderer } from './renderer.ts';
import { PitchRenderer, type RenderExtras } from './render.ts';
import { ReplayRecorder } from '../meta/replay.ts';
import { clearLastReplay, storeReplay } from './replayStore.ts';
import type { CrestPattern } from '../meta/names.ts';
import { Renderer3D } from './r3d/renderer3d.ts';

export interface MatchViewOptions extends MatchOptions {
  crests: [CrestPattern, CrestPattern];
  label: string;
  /** Pause-menu text for leaving early. Defaults by label (ranked forfeits count as 0–3). */
  forfeitText?: string;
  /** Preferred control style; the input still follows whatever the player touches. */
  controls?: 'mouse' | 'keys';
  onEnd: (s: MatchState, forfeited: boolean) => void;
  /** Replaces the default mouse/keyboard controller, e.g. two keyboard pads for hot-seat (versus.ts). */
  inputSource?: (canvas: HTMLCanvasElement, renderer: MatchRenderer, s: MatchState, togglePause: () => void) => MatchInputSource;
  /** Replaces the controls line under the pitch (HTML). */
  controlsHint?: string;
  /** Coach tips over the pitch (src/client/coach.ts). Off unless given. */
  coach?: Omit<CoachOptions, 'mode'>;
  /** Called as the match ends with the input mode the player settled on (mouse or keys), to remember it. */
  onControls?: (mode: 'mouse' | 'keys') => void;
  /** Top-right HUD label. Defaults to "You vs AI" (or "P1 vs P2" with two humans). */
  modeLabel?: string;
  /** Instant replays of goals, cards and big chances at the next stoppage. Default: the stored preference (on). */
  instantReplays?: boolean;
}

const REPLAYS_KEY = 'derby-instant-replays';

/** The player's instant-replay setting (on unless turned off in the pause menu). */
export function instantReplaysPref(): boolean {
  // With prefers-reduced-motion, replays (a pitch-level tracking camera, hard cuts) are off until
  // the player turns them on in the pause menu.
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    const v = localStorage.getItem(REPLAYS_KEY);
    return v === null ? !reduce : v !== 'off';
  } catch {
    return !reduce;
  }
}

function setInstantReplaysPref(on: boolean): void {
  try {
    localStorage.setItem(REPLAYS_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked */
  }
}

/**
 * Instant-replay timing (research brief §6, owner ask 10). The clip runs from LEAD before the moment
 * to TAIL after it; the last SLOW_TICKS before the end play at half speed. A goal of 4 s lead,
 * 0.75 s tail and 1.5 s slow-mo is about 6.5 s on screen; other moments are a little shorter.
 */
export const REPLAY_LEAD: Record<Highlight['kind'], number> = { goal: 4 * TICK_HZ, red: 3 * TICK_HZ, yellow: 3 * TICK_HZ, save: 3.2 * TICK_HZ, woodwork: 3.2 * TICK_HZ, miss: 3.2 * TICK_HZ };
export const REPLAY_TAIL = Math.round(0.75 * TICK_HZ);
export const REPLAY_SLOW_TICKS = Math.round(1.5 * TICK_HZ);
/** Wait this long after the moment before cutting to the replay (a goal gets its celebration first). */
const REPLAY_DELAY: Record<Highlight['kind'], number> = { goal: 2.6, red: 1.2, yellow: 1.2, save: 1.1, woodwork: 1.1, miss: 1.1 };
/** A pending moment not shown within this long (play went on) is dropped. */
const REPLAY_STALE = 6 * TICK_HZ;
/** Between replays of anything but goals and red cards, at least this much match time, ticks. */
const REPLAY_GAP = 90 * TICK_HZ;
/** Clicks and keys can't skip in the first moments, so a click already in progress doesn't. */
const REPLAY_SKIP_AFTER_MS = 400;
/** A lost WebGL context not restored within this long: the match carries on in 2D. */
export const GFX_RESTORE_MS = 3000;

/** Where a live match gets its per-tick input and the renderer's cursor and previews. */
export interface MatchInputSource {
  take(): HumanInput | TeamInputs;
  /** The input scheme in use right now, when the source has one (mouse or keys); it follows whatever the player touches. */
  mode?(): 'mouse' | 'keys';
  extras(): RenderExtras;
  /** Drop queued kicks and charges (pause, resume, replays): nothing pressed then fires afterwards. */
  reset?(): void;
  dispose(): void;
}

/** A short banner for a referee decision, or null for events that don't need one. */
export function refereeCall(s: MatchState, e: MatchEvent): string | null {
  const team = s.teams[e.team]?.name ?? '';
  switch (e.kind) {
    case 'offside':
      return `Offside: ${s.players[e.player].name}`;
    case 'card':
      return e.color === 'yellow' ? `Yellow card: ${e.name}` : e.secondYellow ? `Second yellow, red card: ${e.name}` : `Red card: ${e.name}`;
    case 'advantage':
      return 'Advantage';
    case 'restart':
      if (e.restart === 'penalty') return `Penalty to ${team}`;
      if (e.restart === 'freekick' && e.reason === 'foul') return `Free kick to ${team}`;
      if (e.restart === 'corner') return `Corner to ${team}`;
      return null;
    default:
      return null;
  }
}

const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** The controls line on phones and tablets: no mouse or keys to talk about. */
const TOUCH_HINT = `<b>Touch:</b> drag on the pitch and your player runs toward your finger, faster the further it is. <b>Pass</b> passes (hold to loft) · <b>Shoot</b> shoots, or tackles without the ball · tap a player to pick him.`;

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
    <div class="pitch-wrap">
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="${coarsePointer() ? 'Pitch. Drag to run toward your finger, the further the faster. Pass passes, hold it to loft. Shoot shoots, or tackles without the ball. Tap a player to pick him.' : 'Pitch. Mouse: move to run, the further the pointer the faster. With the ball, left click to pass to the pointer, hold left to loft, right click to shoot. Without it, left click to pick a player, right click to tackle. Keys: WASD or arrows to run, Space to pass or tackle, hold F to shoot, hold C to loft, E to switch, Shift to sprint, Esc to pause.'}"></canvas>
      ${hudMarkup({ teams: [home, away], crests: o.crests, mode: o.modeLabel ?? (o.humans?.[0] && o.humans?.[1] ? 'P1 vs P2' : 'You vs AI'), label: o.label })}
      <div class="pause" id="pause" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <h2 id="pause-title">Paused</h2>
          <div class="pause-actions">
            <button class="btn primary" id="resume">Resume</button>
            <button class="btn" id="forfeit">${esc(o.forfeitText ?? (o.label === 'Ranked' ? 'Forfeit (counts as 0–3)' : 'Leave match'))}</button>
          </div>
          <label class="pause-opt"><input type="checkbox" id="opt-replays"> Instant replays of goals and big chances</label>
          <p class="hint">Esc or P pauses.<span id="zoom-hint"> Mouse wheel or + / − zooms the camera.</span></p>
        </div>
      </div>
      <div class="touch-pad" aria-hidden="true">
        <button class="pad-btn" id="pad-pass" tabindex="-1">Pass</button>
        <button class="pad-btn shoot" id="pad-shoot" tabindex="-1">Shoot</button>
      </div>
    </div>
    <p class="controls-hint clamp" id="controls-hint">${o.controlsHint ?? (coarsePointer() ? TOUCH_HINT : `<b>Mouse:</b> your player runs to the pointer, faster the further it is. <b>With the ball:</b> <b>left click</b> pass to the pointer · <b>hold left</b> loft · <b>right click</b> shoot (hold for power). <b>Without:</b> <b>left click</b> pick a player · <b>right click</b> tackle (slide if far). <b>Keys:</b> WASD · Space pass / tackle · hold F shoot · hold C loft · Shift sprint · E switch.`)}</p>
    <button class="hint-more" id="hint-more" type="button" aria-expanded="false" aria-controls="controls-hint">All controls</button>
  </section>`;

  // let: a lost WebGL context that never comes back swaps both for a fresh 2D canvas (fallBackTo2D).
  let canvas = root.querySelector<HTMLCanvasElement>('#pitch')!;
  let renderer = createMatchRenderer(canvas);
  // Only the 3D view zooms (the 2D one already shows the whole pitch).
  if (renderer.kind !== '3d') root.querySelector('#zoom-hint')?.remove();
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  let paused = false;
  let done = false;
  let focusBeforePause: HTMLElement | null = null;
  /** The final whistle has gone: no pause menu and no forfeit any more (the result stands). */
  let ending = false;
  const setPaused = (v: boolean) => {
    if (done || v === paused) return;
    if (v && (ending || s.phase === 'fulltime')) return;
    paused = v;
    input.reset?.();
    $('pause').hidden = !v;
    coach?.setPaused(v);
    juice.setPaused(v);
    if (v) {
      focusBeforePause = document.activeElement as HTMLElement | null;
      $('resume').focus();
      announce('Paused.');
    } else {
      (focusBeforePause && root.contains(focusBeforePause) ? focusBeforePause : canvas).focus();
    }
  };
  let input: MatchInputSource = o.inputSource?.(canvas, renderer, s, () => setPaused(!paused)) ?? defaultInput();
  function defaultInput(): MatchInputSource {
    const c = new InputController(canvas, renderer, () => s.controlled[0] >= 0 && s.ball.owner === s.controlled[0], () => setPaused(!paused));
    if (o.controls) c.mode = o.controls;
    c.paused = () => paused;
    c.bindTouchButtons($('pad-pass'), $('pad-shoot'));
    return { take: () => c.take(), mode: () => c.mode, reset: () => c.reset(), extras: () => ({ cursor: c.cursor, charge: c.charge(), showCursor: c.mode === 'mouse', armed: c.armed(), switchTo: c.switchCandidate(s) }), dispose: () => c.dispose() };
  }
  // The controls line is one line until asked for (the drills taught them); the button opens it all.
  $('hint-more').addEventListener('click', (e) => {
    const open = $('controls-hint').classList.toggle('clamp') === false;
    $('hint-more').setAttribute('aria-expanded', String(open));
    $('hint-more').textContent = open ? 'Fewer' : 'All controls';
    if ((e as MouseEvent).detail > 0) canvas.focus({ preventScroll: true });
  });
  $('pause-btn').addEventListener('click', () => setPaused(true));
  $('resume').addEventListener('click', () => setPaused(false));
  $('forfeit').addEventListener('click', () => {
    if (!ending && s.phase !== 'fulltime') finish(true);
  });
  const onVis = () => document.hidden && setPaused(true);
  document.addEventListener('visibilitychange', onVis);
  // Losing focus (another window, an alert) pauses a one-human match, as hiding the tab does.
  const onBlur = () => {
    if (!(s.humans[0] && s.humans[1])) setPaused(true);
  };
  window.addEventListener('blur', onBlur);
  // No browser menu on a right click anywhere over the match (the HUD buttons too, not just the canvas).
  const onCtx = (e: Event) => e.preventDefault();
  root.querySelector('.pitch-wrap')!.addEventListener('contextmenu', onCtx);
  const onKey = (e: KeyboardEvent) => paused && trapTab($('pause'), e);
  document.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);
  renderer.resize();
  renderer.prepare(s);
  const juice = mountJuice(root, s);
  const hud = mountHud(root.querySelector<HTMLElement>('.pitch-wrap')!, s);
  const coach = o.coach ? mountCoach(root.querySelector<HTMLElement>('.pitch-wrap')!, { ...o.coach, mode: () => input.mode?.() ?? o.controls ?? 'mouse' }) : null;
  let offCam = s.humans[0] && s.humans[1] ? () => {} : mountCameraToggle(root.querySelector<HTMLElement>('.hud-tr')!, renderer, canvas);

  // Instant replays: never with two tabs in lockstep (versus.ts runs its own loop), only in 3D.
  let replaysOk = renderer instanceof Renderer3D;
  let replaysOn = replaysOk && (o.instantReplays ?? instantReplaysPref());
  const optReplays = root.querySelector<HTMLInputElement>('#opt-replays')!;
  optReplays.checked = replaysOn;
  optReplays.closest('label')!.hidden = !replaysOk;
  optReplays.addEventListener('change', () => {
    replaysOn = optReplays.checked;
    setInstantReplaysPref(replaysOn);
  });
  const spotter = new HighlightSpotter(s);
  const buffer = new ReplayBuffer(s);
  let pending: Highlight | null = null;
  let lastReplayTick = -Infinity;
  /** A replay was shown in this stoppage: no second one until play is live again. */
  let shownThisStop = false;
  let replay: {
    h: Highlight;
    state: MatchState;
    step: () => boolean;
    end: number;
    acc: number;
    started: number;
    skip: HTMLButtonElement;
  } | null = null;
  const wrapEl = root.querySelector<HTMLElement>('.pitch-wrap')!;
  const hudEl = root.querySelector<HTMLElement>('.hud')!;
  const live = () => s.phase === 'play' && !s.ball.inHands;

  // WebGL context loss (a GPU or driver reset): hold the match with a calm note instead of playing on
  // under a blank pitch. Resume when the context comes back; if it doesn't within GFX_RESTORE_MS,
  // finish the match on the 2D renderer, on a fresh canvas, from the very same state.
  let gfxLost = false;
  let gfxTimer = 0;
  const gfxNote = document.createElement('div');
  gfxNote.className = 'gfx-note';
  gfxNote.setAttribute('role', 'status');
  gfxNote.hidden = true;
  gfxNote.textContent = 'Restoring graphics…';
  wrapEl.appendChild(gfxNote);
  function watchContext(r: MatchRenderer) {
    if (!(r instanceof Renderer3D)) return;
    r.onContextLost = () => {
      if (done || gfxLost) return;
      gfxLost = true;
      gfxNote.hidden = false;
      announce('Restoring graphics.');
      gfxTimer = window.setTimeout(fallBackTo2D, GFX_RESTORE_MS);
    };
    r.onContextRestored = () => {
      clearTimeout(gfxTimer);
      if (!gfxLost) return;
      gfxLost = false;
      gfxNote.hidden = true;
      last = performance.now();
      acc = 0;
    };
  }
  function fallBackTo2D() {
    if (done || !gfxLost) return;
    endReplay();
    input.dispose();
    offCam();
    ro.unobserve(canvas);
    renderer.dispose();
    const fresh = document.createElement('canvas');
    for (const a of ['id', 'tabindex', 'role', 'aria-roledescription', 'aria-label']) {
      const v = canvas.getAttribute(a);
      if (v !== null) fresh.setAttribute(a, v);
    }
    const hadFocus = document.activeElement === canvas;
    canvas.replaceWith(fresh);
    canvas = fresh;
    renderer = new PitchRenderer(fresh);
    fresh.dataset.renderer = '2d';
    fresh.dataset.fallback = 'context-lost';
    input = o.inputSource?.(canvas, renderer, s, () => setPaused(!paused)) ?? defaultInput();
    offCam = () => {};
    replaysOk = false;
    replaysOn = false;
    optReplays.closest('label')!.hidden = true;
    root.querySelector('#zoom-hint')?.remove();
    ro.observe(fresh);
    renderer.resize();
    renderer.prepare(s);
    gfxLost = false;
    gfxNote.hidden = true;
    last = performance.now();
    acc = 0;
    if (hadFocus) fresh.focus({ preventScroll: true });
    announce('The graphics could not be restored, so the match carries on in the 2D view.');
  }
  watchContext(renderer);

  function consider(h: Highlight) {
    if (!replaysOn) return;
    if (h.kind !== 'goal' && h.kind !== 'red' && s.tick - lastReplayTick < REPLAY_GAP) return;
    if (!pending || HIGHLIGHT_RANK[h.kind] >= HIGHLIGHT_RANK[pending.kind]) pending = h;
  }

  function startReplay(h: Highlight) {
    const r3 = renderer as Renderer3D;
    const from = h.tick - REPLAY_LEAD[h.kind];
    const opened = buffer.open(from);
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'replay-skip';
    skip.setAttribute('aria-label', 'Skip replay');
    skip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (replay && performance.now() - replay.started > REPLAY_SKIP_AFTER_MS) endReplay();
    });
    skip.addEventListener('contextmenu', (e) => e.preventDefault());
    wrapEl.appendChild(skip);
    wrapEl.classList.add('replaying');
    hudEl.classList.add('replaying');
    input.reset?.();
    replay = { h, state: opened.state, step: opened.step, end: Math.min(buffer.latest, h.tick + REPLAY_TAIL), acc: 0, started: performance.now(), skip };
    // Goals and big chances from behind the goal for the slow-motion finish; cards from the low side.
    r3.replayShot = { kind: 'low', goalX: h.goalX };
    hud.replay(`${h.label} · ${coarsePointer() ? 'tap to skip' : hotseat ? 'click or Esc to skip' : 'click, Space or Esc to skip'}`);
    canvas.dataset.replay = h.kind;
    lastReplayTick = s.tick;
    shownThisStop = true;
    announce(`Replay. ${h.label}. Press Escape to skip.`);
  }

  function endReplay() {
    if (!replay) return;
    input.reset?.();
    replay.skip.remove();
    replay = null;
    wrapEl.classList.remove('replaying');
    hudEl.classList.remove('replaying');
    (renderer as Renderer3D).replayShot = null;
    hud.replay(null);
    delete canvas.dataset.replay;
    // Back to the live match: no stale accumulated time, so it resumes on the tick it stopped at.
    last = performance.now();
    acc = 0;
    canvas.focus({ preventScroll: true });
  }

  /** Advance the replay by `elapsed` seconds of wall time; false once it has finished. */
  function stepReplay(elapsed: number): boolean {
    const r = replay!;
    const slow = r.state.tick >= r.end - REPLAY_SLOW_TICKS;
    r.acc += elapsed * (slow ? 0.5 : 1);
    if (slow && r.h.kind !== 'red' && r.h.kind !== 'yellow') (renderer as Renderer3D).replayShot = { kind: 'goal', goalX: r.h.goalX };
    while (r.acc >= DT) {
      r.acc -= DT;
      if (r.state.tick >= r.end || !r.step()) return false;
    }
    return r.state.tick < r.end;
  }

  // Space, Enter and Esc skip a replay; caught before the match's own keys see them. While paused
  // (the pause menu is up), keys go to the menu as usual: Esc resumes, the replay then carries on.
  // Hot-seat: Space and Enter are the two players' pass keys, so only Esc (and a click) skip there.
  const hotseat = s.humans[0] && s.humans[1];
  const onReplayKey = (e: KeyboardEvent) => {
    if (!replay || paused) return;
    if (e.key === 'Escape' || (!hotseat && (e.key === ' ' || e.key === 'Enter'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat && performance.now() - replay.started > REPLAY_SKIP_AFTER_MS) endReplay();
    }
  };
  window.addEventListener('keydown', onReplayKey, true);

  // The score bar is written only when it changes: a write every frame costs a style and layout pass.
  const [sbH, sbA, sbMin, sbPhase] = ['sb-h', 'sb-a', 'sb-min', 'sb-phase'].map($);
  const setText = (el: HTMLElement, v: string) => {
    if (el.textContent !== v) el.textContent = v;
  };

  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let lastGoals = 0;
  let lastEvent = 0;
  let bannerUntil = 0;
  let shownHalftime = false;
  const scoreLine = () => `${home.name} ${s.score[0]}, ${away.name} ${s.score[1]}.`;

  function banner(text: string, ms: number, sub?: string) {
    hud.word(text, ms, sub);
    bannerUntil = performance.now() + ms;
  }

  function finish(forfeited: boolean) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    dispose();
    if (input.mode) o.onControls?.(input.mode());
    if (forfeited) clearLastReplay();
    else if (rec) storeReplay(rec.finish(s, Date.now() / 1000));
    else clearLastReplay(); // so the result dialog doesn't offer the previous match's replay
    o.onEnd(s, forfeited);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    // Up to 0.2 s of catch-up per frame, so a slow GPU (or a software renderer) drops frames, not game time.
    const elapsed = Math.min(0.2, (now - last) / 1000);
    last = now;
    if (replay && !paused && !gfxLost) {
      if (!stepReplay(elapsed)) endReplay();
    }
    if (replay) {
      renderer.draw(replay.state, { cursor: null, charge: 0, showCursor: false, noAim: true });
      hud.update(replay.state, 0, null);
    } else {
      if (!paused && !gfxLost) {
        acc += elapsed;
        let steps = 0;
        while (acc >= DT && steps < 12) {
          const raw = input.take();
          const used: TickInput = rec && !Array.isArray(raw) ? rec.push(raw) : raw;
          step(s, used);
          juice.tick(s);
          buffer.push(used, s);
          for (const h of spotter.update(s)) consider(h);
          acc -= DT;
          steps++;
          if (live()) shownThisStop = false;
          // At a stoppage (or the keeper holding the ball), show the pending moment once it is due.
          const p = pending;
          if (p && s.tick - p.tick > REPLAY_STALE) pending = null;
          else if (p && !live() && !shownThisStop && s.phase !== 'fulltime' && s.tick - p.tick >= REPLAY_DELAY[p.kind] * TICK_HZ && s.tick >= p.tick + REPLAY_TAIL) {
            pending = null;
            startReplay(p);
            break;
          }
        }
      }
      if (replay) {
        renderer.draw((replay as { state: MatchState }).state, { cursor: null, charge: 0, showCursor: false, noAim: true });
        hud.update((replay as { state: MatchState }).state, 0, null);
      } else {
        const extras = input.extras();
        renderer.draw(s, extras);
        const charge = extras.charges ? Math.max(extras.charges[0], extras.charges[1]) : extras.charge;
        hud.update(s, charge, extras.charges ? undefined : kickGauge(s, extras));
      }
    }
    // Coach tips: hidden behind the pause menu and while an instant replay plays; they watch the live match only,
    // never the replayed one.
    coach?.setPaused(paused || !!replay);
    if (!replay) coach?.update(s, paused ? 0 : elapsed * 1000);

    setText(sbH, String(s.score[0]));
    setText(sbA, String(s.score[1]));
    setText(sbMin, `${matchMinute(s)}'`);
    setText(sbPhase, s.phase === 'halftime' ? 'Half-time' : s.phase === 'fulltime' ? 'Full-time' : s.half === 1 ? `${o.label} · 1st half` : `${o.label} · 2nd half`);

    // Referee's calls: offside, fouls, cards, penalties, set pieces, as big HUD words (goals have their own below).
    while (lastEvent < s.events.length) {
      const e = s.events[lastEvent++];
      const w = refereeWord(s, e);
      if (w?.live) hud.tag(w.word, 1800, w.sub);
      else if (w) banner(w.word, 1500, w.sub);
      const call = refereeCall(s, e);
      if (call) announce(call);
    }
    if (s.goals.length > lastGoals) {
      const ev = s.goals[s.goals.length - 1];
      lastGoals = s.goals.length;
      banner('Goal!', 2000, `${ev.scorer} ${ev.minute}'`);
      announce(`Goal for ${s.teams[ev.team].name}. ${ev.scorer}, minute ${ev.minute}. ${scoreLine()}`);
    }
    if (s.phase === 'halftime' && !shownHalftime) {
      shownHalftime = true;
      banner('Half time', 1800);
      announce(`Half-time. ${scoreLine()}`);
    }
    if (bannerUntil && now > bannerUntil) {
      bannerUntil = 0;
    }
    if (s.phase === 'fulltime') {
      ending = true;
      banner('Full time', 99999);
      announce(`Full-time. ${scoreLine()}`);
      setTimeout(() => finish(false), 1100);
      cancelAnimationFrame(raf);
    }
  }
  raf = requestAnimationFrame(frame);
  canvas.focus({ preventScroll: true });
  announce(`${o.label} match. ${home.name} against ${away.name}. Esc pauses.`);

  function dispose() {
    clearTimeout(gfxTimer);
    gfxNote.remove();
    input.dispose();
    juice.dispose();
    hud.dispose();
    coach?.dispose();
    offCam();
    ro.disconnect();
    renderer.dispose();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onReplayKey, true);
    replay?.skip.remove();
    replay = null;
  }
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    dispose();
  };
}
