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
import { mountJuice } from './fx.ts';
import { hudMarkup, mountHud, refereeWord } from './hud.ts';
import { HighlightSpotter, HIGHLIGHT_RANK, ReplayBuffer, type Highlight, type TickInput } from './highlights.ts';
import { InputController } from './input.ts';
import { kickGauge } from './power.ts';
import type { RenderExtras } from './render.ts';
import { createMatchRenderer, mountCameraToggle, type MatchRenderer } from './renderer.ts';
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
  /** Top-right HUD label. Defaults to "You vs AI" (or "P1 vs P2" with two humans). */
  modeLabel?: string;
  /** Instant replays of goals, cards and big chances at the next stoppage. Default: the stored preference (on). */
  instantReplays?: boolean;
}

const REPLAYS_KEY = 'derby-instant-replays';

/** The player's instant-replay setting (on unless turned off in the pause menu). */
export function instantReplaysPref(): boolean {
  try {
    return localStorage.getItem(REPLAYS_KEY) !== 'off';
  } catch {
    return true;
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

/** Where a live match gets its per-tick input and the renderer's cursor and previews. */
export interface MatchInputSource {
  take(): HumanInput | TeamInputs;
  extras(): RenderExtras;
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
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Pitch. Mouse: move to run, the further the pointer the faster. With the ball, left click to pass to the pointer, hold left to loft, right click to shoot. Without it, left click to pick a player, right click to tackle. Keys: WASD or arrows to run, Space to pass or tackle, hold F to shoot, hold C to loft, E to switch, Shift to sprint, Esc to pause."></canvas>
      ${hudMarkup({ teams: [home, away], crests: o.crests, mode: o.modeLabel ?? (o.humans?.[0] && o.humans?.[1] ? 'P1 vs P2' : 'You vs AI'), label: o.label })}
      <div class="pause" id="pause" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <h2 id="pause-title">Paused</h2>
          <div class="pause-actions">
            <button class="btn primary" id="resume">Resume</button>
            <button class="btn" id="forfeit">${esc(o.forfeitText ?? (o.label === 'Ranked' ? 'Forfeit (counts as 0–3)' : 'Leave match'))}</button>
          </div>
          <label class="pause-opt"><input type="checkbox" id="opt-replays"> Instant replays of goals and big chances</label>
          <p class="hint">Esc or P pauses. Mouse wheel or + / − zooms the camera.</p>
        </div>
      </div>
      <div class="touch-pad" aria-hidden="true">
        <button class="pad-btn" id="pad-pass" aria-label="Pass: tap to pass, hold to loft">Pass</button>
        <button class="pad-btn shoot" id="pad-shoot">Shoot</button>
      </div>
    </div>
    <p class="controls-hint clamp" id="controls-hint">${o.controlsHint ?? `<b>Mouse:</b> your player runs to the pointer, faster the further it is. <b>With the ball:</b> <b>left click</b> pass to the pointer · <b>hold left</b> loft · <b>right click</b> shoot (hold for power). <b>Without:</b> <b>left click</b> pick a player · <b>right click</b> tackle (slide if far). <b>Keys:</b> WASD · Space pass / tackle · hold F shoot · hold C loft · Shift sprint · E switch.`}</p>
    <button class="hint-more" id="hint-more" type="button" aria-expanded="false" aria-controls="controls-hint">All controls</button>
  </section>`;

  const canvas = root.querySelector<HTMLCanvasElement>('#pitch')!;
  const renderer = createMatchRenderer(canvas);
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
  // The controls line is one line until asked for (the drills taught them); the button opens it all.
  $('hint-more').addEventListener('click', (e) => {
    const open = $('controls-hint').classList.toggle('clamp') === false;
    $('hint-more').setAttribute('aria-expanded', String(open));
    $('hint-more').textContent = open ? 'Fewer' : 'All controls';
    if ((e as MouseEvent).detail > 0) canvas.focus({ preventScroll: true });
  });
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
  renderer.prepare(s);
  const juice = mountJuice(root, s);
  const hud = mountHud(root.querySelector<HTMLElement>('.pitch-wrap')!, s);
  const offCam = s.humans[0] && s.humans[1] ? () => {} : mountCameraToggle(root.querySelector<HTMLElement>('.hud-tr')!, renderer, canvas);

  // Instant replays: never with two tabs in lockstep (versus.ts runs its own loop), only in 3D.
  const replaysOk = renderer instanceof Renderer3D;
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
    replay = { h, state: opened.state, step: opened.step, end: Math.min(buffer.latest, h.tick + REPLAY_TAIL), acc: 0, started: performance.now(), skip };
    // Goals and big chances from behind the goal for the slow-motion finish; cards from the low side.
    r3.replayShot = { kind: 'low', goalX: h.goalX };
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    hud.replay(`${h.label} · ${coarse ? 'tap' : 'click'} to skip`);
    canvas.dataset.replay = h.kind;
    lastReplayTick = s.tick;
    shownThisStop = true;
    announce(`Replay. ${h.label}.`);
  }

  function endReplay() {
    if (!replay) return;
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
    if (replay && !paused) {
      if (!stepReplay(elapsed)) endReplay();
    }
    if (replay) {
      renderer.draw(replay.state, { cursor: null, charge: 0, showCursor: false, noAim: true });
      hud.update(replay.state, 0, null);
    } else {
      if (!paused) {
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

    $('sb-h').textContent = String(s.score[0]);
    $('sb-a').textContent = String(s.score[1]);
    $('sb-min').textContent = `${matchMinute(s)}'`;
    $('sb-phase').textContent = s.phase === 'halftime' ? 'Half-time' : s.phase === 'fulltime' ? 'Full-time' : s.half === 1 ? `${o.label} · 1st half` : `${o.label} · 2nd half`;

    // Referee's calls: offside, fouls, cards, penalties, set pieces, as big HUD words (goals have their own below).
    while (lastEvent < s.events.length) {
      const e = s.events[lastEvent++];
      const w = refereeWord(s, e);
      if (w) banner(w.word, 1500, w.sub);
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
    input.dispose();
    juice.dispose();
    hud.dispose();
    offCam();
    ro.disconnect();
    renderer.dispose();
    document.removeEventListener('visibilitychange', onVis);
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
