// Runs a live match: fixed 60 Hz sim steps on a requestAnimationFrame loop,
// with the HUD in DOM and the pitch on canvas. Also orchestrates instant
// replays: highlights.ts spots goals, cards, saves, the woodwork and near
// misses; at the next stoppage the live sim is held while the last few seconds
// are re-simulated from a snapshot buffer and shown with replay cameras, then
// play resumes exactly where it stopped.

import { DT, TICK_HZ } from '../sim/constants.ts';
import { createMatch, matchMinute, possessionShare, step, type MatchOptions } from '../sim/match.ts';
import type { HumanInput, MatchEvent, MatchState, TeamInputs } from '../sim/types.ts';
import { announce, trapTab } from './a11y.ts';
import { controlsHelp } from './controls.ts';
import { getSound, homeTeam, isConceded } from './audio.ts';
import { fullTimeMoment, goalMoment } from './moments.ts';
import { mountCoach, type CoachOptions } from './coach.ts';
import { mountJuice } from './fx.ts';
import { tickDue } from './ticks.ts';
import { hudMarkup, mountHud, refereeWord } from './hud.ts';
import { HighlightSpotter, HIGHLIGHT_RANK, ReplayBuffer, type Highlight, type TickInput } from './highlights.ts';
import { setPieceSpot, InputController } from './input.ts';
import { hudGauge } from './power.ts';
import { createMatchRenderer, mountCameraToggle, type MatchRenderer } from './renderer.ts';
import { HUMAN_COLORS, type RenderExtras } from './render.ts';
import { fallback2D, watchGfxLoss } from './gfxloss.ts';
import { ReplayRecorder } from '../meta/replay.ts';
import { clearLastReplay, storeReplay } from './replayStore.ts';
import type { CrestPattern } from '../meta/names.ts';
import { Renderer3D } from './r3d/renderer3d.ts';
import { MENTALITY_NOTE, quickTacticsMarkup } from './tactics.ts';
import { MENTALITY_IDS, MENTALITY_LABEL, type Mentality } from '../sim/constants.ts';

export interface MatchViewOptions extends MatchOptions {
  crests: [CrestPattern, CrestPattern];
  label: string;
  /** Opening banner: the stakes of this match (stakes.ts introLine). */
  intro?: { title: string; sub: string };
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
export { GFX_RESTORE_MS } from './gfxloss.ts';

/** Where a live match gets its per-tick input and the renderer's cursor and previews. */
export interface MatchInputSource {
  take(): HumanInput | TeamInputs;
  /** The input scheme in use right now, when the source has one (mouse or keys); it follows whatever the player touches. */
  mode?(): 'mouse' | 'keys';
  extras(): RenderExtras;
  /** Drop queued kicks and charges (pause, resume, replays): nothing pressed then fires afterwards. */
  reset?(): void;
  /** A one-shot action (pass, shot, tackle, switch…) is waiting for the next tick. */
  waiting?(): boolean;
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
    case 'addedTime':
      return `${e.minutes} minute${e.minutes === 1 ? '' : 's'} of added time`;
    case 'abandoned':
      return `Match abandoned: ${team} down to six players`;
    case 'restart':
      if (e.reason === 'advantage') return `Advantage brought back: ${e.restart === 'penalty' ? 'penalty' : 'free kick'} to ${team}`;
      if (e.reason === 'second-touch') return `Second touch: indirect free kick to ${team}`;
      if (e.restart === 'penalty') return `Penalty to ${team}`;
      if (e.restart === 'freekick' && e.reason === 'foul') return `${e.direct ? 'Free kick' : 'Indirect free kick'} to ${team}`;
      if (e.restart === 'corner') return `Corner to ${team}`;
      return null;
    default:
      return null;
  }
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** The controls line: the essentials (always shown whole) and the detail behind "All controls" (hud.css). */
const hint = (key: string, rest: string) => `<span class="hint-key">${key}</span> <span class="hint-rest">${rest}</span>`;
/** On phones and tablets: no mouse or keys to talk about. */
const TOUCH_HINT = hint(
  `<b>Drag</b> to run · <b>Pass</b>, hold to loft · <b>Shoot</b>, hold for power, tackles off the ball · <b>tap</b> a player to switch`,
  `Your player runs toward your finger, faster the further it is.`,
);
const MOUSE_HINT = hint(
  `<b>Left click</b> pass · <b>hold left</b> loft · <b>right click</b> shoot · <b>WASD</b> run · <b>Space</b> pass · <b>F</b> shoot · <b>V</b> camera · <b>Esc</b> pause`,
  `Hold <b>right click</b> for power. Without the ball <b>right click</b> tackles (far away it slides), <b>left click</b> switches player. Your player runs to the pointer, faster the further it is. Also: hold <b>C</b> loft · <b>Shift</b> sprint · <b>E</b> switch · <b>wheel</b> or <b>+/−</b> zoom · <b>P</b> pause · <b>1–5</b> mentality (1 Park the bus … 5 High press).`,
);

/** The same line for a keyboard player: the keys first, the mouse as the extra. */
const KEYS_HINT = hint(
  `<b>WASD</b> run · <b>Space</b> pass · <b>F</b> shoot · <b>C</b> loft · <b>E</b> switch · <b>Shift</b> sprint · <b>V</b> camera · <b>Esc</b> pause`,
  `Hold <b>F</b> for power, hold <b>C</b> to loft. Without the ball <b>Space</b> tackles. Arrows run too. The mouse works any time: <b>left click</b> pass, <b>right click</b> shoot. Also: <b>wheel</b> or <b>+/−</b> zoom · <b>P</b> pause · <b>1–5</b> mentality (1 Park the bus … 5 High press).`,
);
const pointerHint = (mode: 'mouse' | 'keys'): string => (coarsePointer() ? TOUCH_HINT : mode === 'keys' ? KEYS_HINT : MOUSE_HINT);

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function mountMatch(root: HTMLElement, o: MatchViewOptions): () => void {
  const s = createMatch(o);
  // End-to-end tests set window.__e2e before the page loads to get at the live state (to set a scene up and read it back).
  if ((globalThis as { __e2e?: boolean }).__e2e) (globalThis as { __derbyMatch?: MatchState }).__derbyMatch = s;
  // End-to-end tests that only need a match played out set window.__e2eSpeed (2 to 16) to run the sim that many times
  // faster than real time. The ticks and their inputs are the same, so the match, its result and its replay are too; only
  // the wait is shorter. Nothing else sets it.
  const e2eSpeed = (globalThis as { __e2eSpeed?: unknown }).__e2eSpeed;
  const speed = typeof e2eSpeed === 'number' && e2eSpeed >= 2 && e2eSpeed <= 16 ? e2eSpeed : 1;
  // Replays record one human's input; two-human matches (hot-seat) aren't recorded.
  const rec = o.humans?.[0] && o.humans?.[1] ? null : new ReplayRecorder(o, o.label);
  const [home, away] = s.teams;
  // Quick tactics: only for a single human side (hot-seat has two, and no setup to change).
  const me: 0 | 1 | null = s.humans[0] !== s.humans[1] ? (s.humans[0] ? 0 : 1) : null;
  root.innerHTML = `
  <section class="match" aria-label="Match">
    <div class="pitch-wrap">
      <canvas id="pitch" tabindex="0" role="application" aria-roledescription="pitch" aria-label="Pitch" aria-describedby="pitch-help"></canvas><span class="sr-only" id="pitch-help">${coarsePointer() ? 'Drag to run toward your finger, the further the faster. Pass passes, hold it to loft. Shoot shoots, or tackles without the ball. Tap a player to pick him.' : 'Mouse: move to run, the further the pointer the faster. With the ball, left click to pass to the pointer, hold left to loft, right click to shoot. Without it, left click to pick a player, right click to tackle. Keys: WASD or arrows to run, Space to pass or tackle, hold F to shoot, hold C to loft, E to switch, Shift to sprint, 1 to 5 for the mentality, T for the score and time, Esc to pause.'}</span>
      <span class="aim-charge" aria-hidden="true"><i></i></span><p class="key-hint" aria-hidden="true"><kbd>WASD</kbd> run <kbd>Space</kbd> pass <kbd>F</kbd> shoot <kbd>C</kbd> loft <kbd>E</kbd> switch <kbd>Shift</kbd> sprint</p>
      ${hudMarkup({ teams: [home, away], crests: o.crests, mode: o.modeLabel ?? (o.humans?.[0] && o.humans?.[1] ? 'P1 vs P2' : 'You vs CPU'), label: o.label, marks: o.humans?.[0] && o.humans?.[1] ? HUMAN_COLORS : undefined })}
      <div class="pause" id="pause" hidden>
        <div class="pause-card" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <h2 id="pause-title">Paused</h2>
          <div class="pause-actions">
            <button class="btn primary" id="resume">Resume</button>
            <button class="btn" id="forfeit">${esc(o.forfeitText ?? (o.label === 'Ranked' ? 'Forfeit (counts as 0–3)' : 'Leave match'))}</button>
          </div>
          ${me !== null ? quickTacticsMarkup(s.teams[me].mentality) : ''}
          <label class="pause-opt"><input type="checkbox" id="opt-replays"> Instant replays of goals and big chances</label>
          <label class="pause-opt pause-volume">Sound <input type="range" id="opt-volume" min="0" max="100" step="5" aria-label="Sound volume"><output id="opt-volume-out" for="opt-volume"></output></label>
          ${me !== null ? controlsHelp('help-match') : ''}
          <p class="hint">Esc or P pauses.<span id="zoom-hint"> Mouse wheel or + / − zooms the camera.</span></p>
        </div>
      </div>
      <div class="touch-pad" role="group" aria-label="Kick buttons">
        <button class="pad-btn" id="pad-pass" type="button" aria-label="Pass">Pass</button>
        <button class="pad-btn shoot" id="pad-shoot" type="button" aria-label="Shoot">Shoot</button>
      </div>
    </div>
    <p class="controls-hint clamp" id="controls-hint">${o.controlsHint ?? pointerHint(o.controls ?? 'mouse')}</p>
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
    if (!v) disarmForfeit();
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
      announce('Resumed.');
    }
  };
  let input: MatchInputSource = o.inputSource?.(canvas, renderer, s, () => setPaused(!paused)) ?? defaultInput();
  function defaultInput(): MatchInputSource {
    const c = new InputController(canvas, renderer, () => s.controlled[0] >= 0 && s.ball.owner === s.controlled[0], () => setPaused(!paused));
    if (o.controls) c.mode = o.controls;
    c.paused = () => paused;
    c.setPiece = () => setPieceSpot(s, 0);
    c.bindTouchButtons($('pad-pass'), $('pad-shoot'));
    return { take: () => c.take(), waiting: () => c.waiting(), mode: () => c.mode, reset: () => c.reset(), extras: () => ({ cursor: c.cursor, charge: c.charge(), showCursor: c.mode === 'mouse' && c.pointerShown(), armed: c.armed(), switchTo: c.switchCandidate(s) }), dispose: () => c.dispose() };
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
  // Arm-then-confirm (as the shootout's Leave): one stray Enter after Resume must not end the match.
  let forfeitArmed = false;
  let forfeitTimer = 0;
  const forfeitLabel = $('forfeit').textContent ?? '';
  const disarmForfeit = () => {
    clearTimeout(forfeitTimer);
    if (!forfeitArmed) return;
    forfeitArmed = false;
    $('forfeit').textContent = forfeitLabel;
    $('forfeit').classList.remove('danger');
  };
  $('forfeit').addEventListener('click', () => {
    if (ending || s.phase === 'fulltime') return;
    if (!forfeitArmed) {
      forfeitArmed = true;
      $('forfeit').textContent = `${coarsePointer() ? 'Tap' : 'Click'} again to ${/forfeit/i.test(forfeitLabel) ? 'forfeit' : 'leave'}`;
      $('forfeit').classList.add('danger');
      announce(`${forfeitLabel}. Press the button again to confirm.`);
      forfeitTimer = window.setTimeout(disarmForfeit, 4000);
      return;
    }
    disarmForfeit();
    finish(true);
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
  // A derby (the kick-off banner said so) and the latest goal's shot length: the big-moment classifier reads both (moments.ts).
  const derby = o.intro?.title === 'Derby';
  let goalDist: number | undefined;
  const juice = mountJuice(root, s, { derby, shotDist: () => goalDist });
  // Who kicks off and with which key: hot-seat has both players on one keyboard (Player 2 passes with Enter).
  const kickoffPrompt = (team: 0 | 1): string | null => {
    if (s.humans[0] && s.humans[1]) return team === 0 ? 'Player 1 kicks off: press Space' : 'Player 2 kicks off: press Enter';
    if (coarsePointer()) return 'Your kick-off: tap Pass';
    return (input.mode?.() ?? o.controls ?? 'mouse') === 'keys' ? 'Your kick-off: press Space to pass' : 'Your kick-off: click to pass';
  };
  const hud = mountHud(root.querySelector<HTMLElement>('.pitch-wrap')!, s, kickoffPrompt);
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
  // Sound volume (the HUD's speaker button still mutes): remembered in this browser.
  const optVolume = root.querySelector<HTMLInputElement>('#opt-volume')!;
  const volumeOut = root.querySelector<HTMLOutputElement>('#opt-volume-out')!;
  const showVolume = () => {
    volumeOut.textContent = `${optVolume.value}%`;
  };
  optVolume.value = String(Math.round(getSound().volume * 100));
  showVolume();
  optVolume.addEventListener('input', () => {
    getSound().setVolume(Number(optVolume.value) / 100);
    showVolume();
  });
  // A mentality picked in the pause menu goes to the sim with the next tick's input.
  let pendingTactic = 0;
  /** A pause-menu pick waits for resume: the HUD names it then, as the keys do at once. */
  let resumeTag: Mentality | null = null;
  const qtNote = (m: Mentality, tail = '') => {
    const n = root.querySelector('#qt-note');
    if (n) n.textContent = MENTALITY_NOTE[m] + tail;
  };
  root.querySelector('#quick-tactics')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value as Mentality;
    pendingTactic = MENTALITY_IDS.indexOf(v) + 1;
    resumeTag = v;
    qtNote(v, ' Applies when you resume.'); // #qt-note is a polite live region: it says this once
  });
  // Quick tactics from the keyboard while playing: 1 Park the bus ... 5 High press, as in the pause menu.
  // By key position (Digit1-5, Numpad1-5), so the top row works on AZERTY too.
  const onTacticKey = (e: KeyboardEvent) => {
    const n = /^(?:Digit|Numpad)([1-5])$/.exec(e.code)?.[1];
    if (!n || me === null || paused || replay || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const m = MENTALITY_IDS[Number(n) - 1];
    pendingTactic = Number(n);
    const radio = root.querySelector<HTMLInputElement>(`#quick-tactics input[value="${m}"]`);
    if (radio) radio.checked = true;
    resumeTag = null;
    qtNote(m);
    hud.tag(MENTALITY_LABEL[m], 1600, 'Mentality');
    announce(`Mentality: ${MENTALITY_LABEL[m]}.`);
  };
  document.addEventListener('keydown', onTacticKey);
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
    /** The tick the slow-motion finish begins at (the strike, for a goal). */
    slowFrom: number;
    acc: number;
    started: number;
    skip: HTMLButtonElement;
  } | null = null;
  const wrapEl = root.querySelector<HTMLElement>('.pitch-wrap')!;
  // Desktop polish, DOM only (the sim sees none of it): the pointer ring hides once the mouse leaves the pitch, a charge ring
  // follows the pointer while a kick charges, and a strip of key caps shows while the keys are in use, then fades.
  const ringEl = wrapEl.querySelector<HTMLElement>('.aim-charge')!;
  const keyEl = wrapEl.querySelector<HTMLElement>('.key-hint')!;
  // Only a real mouse moves this: a finger on the canvas never shows the charge ring (it would sit at 0,0).
  const mouse = { x: 0, y: 0, in: false, seen: false };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const r = wrapEl.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
    mouse.in = mouse.seen = true;
    keyEl.classList.remove('on');
  };
  const onOut = (e: PointerEvent) => e.pointerType === 'mouse' && (mouse.in = false);
  wrapEl.addEventListener('pointermove', onMove);
  wrapEl.addEventListener('pointerleave', onOut);
  let keyUntil = 0;
  let keyLast = -Infinity;
  const onKeyHint = (e: KeyboardEvent) => {
    if (paused || replay || e.ctrlKey || e.metaKey || e.altKey || o.inputSource || (s.humans[0] && s.humans[1]) || coarsePointer()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
    if (!/^(?:Key[WASDFCE]|Arrow(?:Up|Down|Left|Right)|Space|Shift(?:Left|Right))$/.test(e.code)) return;
    const now = performance.now();
    // Up for as long as the keys are used, and not again until they have been left alone a while.
    if (now - keyLast > 22500) keyEl.classList.add('on');
    if (keyEl.classList.contains('on')) keyUntil = keyLast = now + 2500;
  };
  window.addEventListener('keydown', onKeyHint);
  const hudEl = root.querySelector<HTMLElement>('.hud')!;
  const padEl = root.querySelector<HTMLElement>('.touch-pad')!;
  const live = () => s.phase === 'play' && !s.ball.inHands;

  // WebGL context loss (a GPU or driver reset): hold the match under a calm note instead of playing on
  // under a blank pitch (gfxloss.ts). Resume when the context comes back; if it doesn't, finish the
  // match on the 2D renderer, on a fresh canvas, from the very same state.
  const gfx = watchGfxLoss(renderer, wrapEl, {
    onRestored: () => {
      last = performance.now();
      acc = 0;
    },
    onGiveUp: () => {
      if (done) return;
      endReplay();
      input.dispose();
      offCam();
      ro.unobserve(canvas);
      ({ canvas, renderer } = fallback2D(canvas, renderer));
      input = o.inputSource?.(canvas, renderer, s, () => setPaused(!paused)) ?? defaultInput();
      offCam = () => {};
      replaysOk = false;
      replaysOn = false;
      optReplays.closest('label')!.hidden = true;
      root.querySelector('#zoom-hint')?.remove();
      ro.observe(canvas);
      renderer.resize();
      renderer.prepare(s);
      last = performance.now();
      acc = 0;
    },
  });

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
    juice.clear();
    hud.clearWord();
    bannerUntil = 0;
    wrapEl.classList.add('replaying');
    hudEl.classList.add('replaying');
    input.reset?.();
    const end = Math.min(buffer.latest, h.tick + REPLAY_TAIL);
    // A goal's slow-motion starts as the shot is struck (a beat before it), so the swing and the flight to the net
    // are the slow part, capped at 2.2 s of clip; the rest keep the plain last 1.5 s.
    const slowFrom = h.shot !== undefined ? Math.max(h.shot - 9, end - Math.round(2.2 * TICK_HZ), from) : end - REPLAY_SLOW_TICKS;
    replay = { h, state: opened.state, step: opened.step, end, slowFrom: Math.min(slowFrom, end - REPLAY_SLOW_TICKS), acc: 0, started: performance.now(), skip };
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
    const slow = r.state.tick >= r.slowFrom;
    // Slow-motion is for those who haven't asked for less motion; the closer angle on the goal stays.
    r.acc += elapsed * (slow && !reducedMotion() ? 0.5 : 1);
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
  let endSkip = () => {};
  const scoreLine = () => `${home.name} ${s.score[0]}, ${away.name} ${s.score[1]}.`;

  // T: the score and the clock, said on request (the scoreboard is a picture to a screen reader on the canvas).
  const onScoreKey = (e: KeyboardEvent) => {
    if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || paused || replay || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    announce(`${scoreLine()} ${s.phase === 'halftime' ? 'Half-time.' : s.phase === 'fulltime' ? 'Full-time.' : `Minute ${matchMinute(s)}, ${s.half === 1 ? 'first' : 'second'} half.`}`);
  };
  document.addEventListener('keydown', onScoreKey);

  // The break recap, as banner lines: score, each side's scorers with minutes, then what the sim already counts.
  const recap = (hint?: string) => {
    const [h, a] = [home.short, away.short];
    const side = (t: 0 | 1) => {
      const by = new Map<string, string[]>();
      for (const g of s.goals) if (g.team === t) by.set(g.scorer, [...(by.get(g.scorer) ?? []), `${g.minute}'`]);
      const all = [...by].map(([n, m]) => `${n} ${m.join(' ')}`);
      return all.length ? `${(t ? a : h)}: ${all.slice(0, 3).join(', ')}${all.length > 3 ? ` +${all.length - 3}` : ''}` : '';
    };
    const [x, y] = s.stats;
    const [pa, pb] = possessionShare(s);
    const p = pa + pb ? pa : 50;
    const cards = x.yellows + x.reds + y.yellows + y.reds;
    return [`${h} ${s.score[0]}–${s.score[1]} ${a}`, side(0), side(1), `Shots ${x.shots}–${y.shots} · Possession ${p}–${100 - p}%${cards ? ` · Cards ${x.yellows + x.reds}–${y.yellows + y.reds}` : ''}`, hint].filter(Boolean).join('\n');
  };

  function banner(text: string, ms: number, sub?: string, tone?: string) {
    hud.word(text, ms, sub, tone);
    root.querySelector<HTMLElement>('#banner')?.classList.remove('conceded');
    bannerUntil = performance.now() + ms;
  }

  if (o.intro) {
    // Higher and smaller than the goal words, clear of the kick-off prompt in the middle of the pitch.
    const el = root.querySelector<HTMLElement>('#banner')!;
    banner(o.intro.title, 2600, o.intro.sub);
    el.classList.add('intro');
    setTimeout(() => el.classList.remove('intro'), 2700);
  }

  function finish(forfeited: boolean) {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    endSkip();
    dispose();
    if (input.mode) o.onControls?.(input.mode());
    if (forfeited) clearLastReplay();
    else if (rec) storeReplay(rec.finish(s, Date.now() / 1000));
    else clearLastReplay(); // so the result dialog doesn't offer the previous match's replay
    o.onEnd(s, forfeited);
  }

  // The controls line follows the scheme in use: touch WASD and it talks keys, move the mouse and it talks clicks.
  let hintMode = o.controls ?? 'mouse';
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!o.controlsHint && input.mode && input.mode() !== hintMode) {
      hintMode = input.mode();
      $('controls-hint').innerHTML = pointerHint(hintMode);
    }
    // Up to 0.2 s of catch-up per frame, so a slow GPU (or a software renderer) drops frames, not game time.
    const elapsed = Math.min(0.2, (now - last) / 1000);
    last = now;
    if (replay && !paused && !gfx.lost) {
      if (!stepReplay(elapsed * speed)) endReplay();
    }
    if (replay) {
      renderer.draw(replay.state, { cursor: null, charge: 0, showCursor: false, noAim: true, since: replay.acc });
      hud.update(replay.state, 0, null);
    } else {
      if (!paused && !gfx.lost) {
        acc += elapsed * speed;
        let steps = 0;
        // A waiting click or key takes its tick now, not a frame or two later on a fast screen (ticks.ts).
        while (steps < 12 * speed && tickDue(acc, steps, input.waiting?.() ?? false)) {
          let raw = input.take();
          if (pendingTactic && !Array.isArray(raw)) {
            raw = { ...raw, tactic: pendingTactic };
            pendingTactic = 0;
            if (resumeTag) {
              hud.tag(MENTALITY_LABEL[resumeTag], 1600, 'Mentality');
              qtNote(resumeTag); // in effect now: the note drops 'Applies when you resume'
            }
            resumeTag = null;
          }
          const used: TickInput = rec && !Array.isArray(raw) ? rec.push(raw) : raw;
          const before = s.controlled[0];
          step(s, used);
          if (!Array.isArray(used) && (used.select || used.switchPlayer) && s.controlled[0] !== before) juice.buzz(10);
          // Before the sound and effects: a goal's shot length (highlights.ts) is wanted by them.
          for (const h of spotter.update(s)) {
            // The near things get their word as they happen, replay or not.
            if (h.kind === 'woodwork' || h.kind === 'miss') {
              const word = h.kind === 'miss' ? 'So close!' : 'Off the woodwork!';
              const who = h.label.split(' · ')[1];
              hud.tag(word, 1700, who);
              announce(who ? `${word} ${who}` : word); // the tag itself is aria-hidden
            }
            if (h.kind === 'goal') goalDist = h.dist;
            consider(h);
          }
          juice.tick(s);
          buffer.push(used, s);
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
        renderer.draw((replay as { state: MatchState; acc: number }).state, { cursor: null, charge: 0, showCursor: false, noAim: true, since: (replay as { acc: number }).acc });
        // Nothing of the live controls over a replay.
        keyEl.classList.remove('on');
        ringEl.classList.remove('on');
        hud.update((replay as { state: MatchState }).state, 0, null);
      } else {
        const extras = input.extras();
        // Time since the last tick, so positions are drawn between ticks (RenderExtras.since). Held
        // (paused, graphics lost) or capped at 12 ticks a frame, the picture stays on the tick.
        extras.since = paused || gfx.lost ? 0 : Math.max(-DT, Math.min(DT, acc));
        if (mouse.seen && !mouse.in) extras.showCursor = false;
        renderer.draw(s, extras);
        if (performance.now() > keyUntil) keyEl.classList.remove('on');
        const charge = extras.charges ? Math.max(extras.charges[0], extras.charges[1]) : extras.charge;
        // Touch pads: the held button fills with the kick's power.
        const heldPad = padEl.querySelector<HTMLElement>('.pad-btn.down');
        if (heldPad) heldPad.style.setProperty('--charge', String(Math.round(Math.min(1, Math.max(0, charge)) * 50) / 50));
        const gauge = extras.charges ? undefined : hudGauge(s, extras);
        hud.update(s, charge, gauge);
        // The charge at the pointer, where the eye is (a mouse kick: a shot or a loft being held).
        const ring = mouse.seen && mouse.in && !!extras.armed?.kind && extras.showCursor && !!gauge;
        ringEl.classList.toggle('on', ring);
        if (ring) {
          ringEl.style.transform = `translate(${mouse.x}px,${mouse.y}px)`;
          ringEl.style.setProperty('--c', String(Math.round(gauge!.fill * 50) / 50));
          ringEl.dataset.band = gauge!.band;
        }
      }
    }
    // Coach tips: hidden behind the pause menu and while an instant replay plays; they watch the live match only,
    // never the replayed one.
    // (Also while a goal, card or half-time word is up: coach.css hides the tip then, so it must not age or be replaced unseen.)
    const wordUp = !!root.querySelector('.hud-word[data-tone]:not([hidden]), .hud-word.recap:not([hidden])');
    coach?.setPaused(paused || !!replay || wordUp);
    if (!replay) coach?.update(s, paused || wordUp ? 0 : elapsed * 1000);

    setText(sbH, String(s.score[0]));
    setText(sbA, String(s.score[1]));
    setText(sbMin, `${matchMinute(s)}'`);
    setText(sbPhase, s.phase === 'halftime' ? 'Half-time' : s.phase === 'fulltime' ? 'Full-time' : s.half === 1 ? `${o.label} · 1st half` : `${o.label} · 2nd half`);

    // Referee's calls: offside, fouls, cards, penalties, set pieces, as big HUD words (goals have their own below).
    while (lastEvent < s.events.length) {
      const e = s.events[lastEvent++];
      const w = refereeWord(s, e);
      if (w?.live) hud.tag(w.word, 1800, w.sub);
      else if (w) banner(w.word, 1500, w.sub, w.tone);
      const call = refereeCall(s, e);
      if (call) announce(call);
    }
    if (s.goals.length > lastGoals) {
      const ev = s.goals[s.goals.length - 1];
      lastGoals = s.goals.length;
      const mo = goalMoment(s.goals, s.goals.length - 1, { derby, dist: goalDist });
      // A goal the human's side let in: a small, quiet banner and a dim dark flash (fx.ts drops the confetti too).
      const conceded = isConceded(s, ev);
      if (conceded) {
        banner(`Goal · ${s.teams[ev.team].name}`, 1800, `${ev.scorer} ${ev.minute}'`);
        root.querySelector<HTMLElement>('#banner')?.classList.add('conceded');
      } else banner(mo?.word ?? 'Goal!', mo ? 2400 : 2000, `${ev.scorer} ${ev.minute}'`, s.teams[ev.team].primary);
      // A quick white flash over the pitch as the net moves (CSS drops it under reduced motion).
      wrapEl.classList.remove('goal-flash', 'conceded');
      void wrapEl.offsetWidth;
      wrapEl.classList.add('goal-flash');
      if (conceded) wrapEl.classList.add('conceded');
      // The scorer's number pops (the sides' own score cells, not the HUD's text writes below).
      const cell = ev.team === 0 ? sbH : sbA;
      cell.classList.remove('bump');
      void cell.offsetWidth;
      cell.classList.add('bump');
      announce(`${mo ? `${mo.word} ` : ''}Goal for ${s.teams[ev.team].name}. ${ev.scorer}, minute ${ev.minute}. ${scoreLine()}`);
    }
    if (s.phase === 'halftime' && !shownHalftime) {
      shownHalftime = true;
      banner('Half time', 2600, recap(s.humans[0] && s.humans[1] ? 'Player 2 kicks off: Enter' : undefined));
      announce(`Half-time. ${scoreLine()}`);
    }
    if (bannerUntil && now > bannerUntil) {
      bannerUntil = 0;
    }
    if (s.phase === 'fulltime') {
      ending = true;
      // Law 3: abandoned, the awarded result stands.
      if (s.abandoned) {
        banner('Abandoned', 99999, `${s.teams[s.abandoned.team].name} down to six players`);
        announce(`Full-time. ${scoreLine()}`);
      } else {
        const ft = fullTimeMoment(s.score, homeTeam(s), { final: o.label === 'Cup final', derby });
        banner(ft.word, 99999, recap(`${ft.clean ? 'Clean sheet\n' : ''}Tap or press Space for the result`), ft.word === 'Full time' ? undefined : s.teams[homeTeam(s)].primary);
        announce(`${ft.word === 'Full time' ? 'Full-time.' : `Full-time. ${ft.word}`} ${scoreLine()}${ft.clean ? ' Clean sheet.' : ''}`);
      }
      // A beat for the whistle and the score before the result dialog; a tap, click or Space/Enter/Esc moves on.
      const timer = window.setTimeout(() => finish(false), 2000);
      const t0 = performance.now();
      const skipEnd = (e: Event) => {
        if (performance.now() - t0 < REPLAY_SKIP_AFTER_MS || (e instanceof KeyboardEvent && !['Escape', ' ', 'Enter'].includes(e.key))) return;
        clearTimeout(timer);
        finish(false);
      };
      wrapEl.addEventListener('pointerdown', skipEnd);
      window.addEventListener('keydown', skipEnd);
      endSkip = () => {
        wrapEl.removeEventListener('pointerdown', skipEnd);
        window.removeEventListener('keydown', skipEnd);
        clearTimeout(timer);
      };
      cancelAnimationFrame(raf);
    }
  }
  raf = requestAnimationFrame(frame);
  canvas.focus({ preventScroll: true });
  announce(`${o.label} match. ${home.name} against ${away.name}. Esc pauses.`);

  // The browser's Back (and Android's Back gesture) during a live match opens the pause menu instead of leaving the page
  // and losing the match: the match owns one history entry, put back after each Back press, and removes it when it ends.
  let guardingBack = false;
  const onPop = () => {
    if (done) return;
    try { history.pushState({ derbyMatch: true }, ''); } catch { /* sandboxed viewer: no history to guard */ }
    setPaused(true);
  };
  try {
    history.pushState({ derbyMatch: true }, '');
    guardingBack = true;
    window.addEventListener('popstate', onPop);
  } catch { /* sandboxed viewer */ }

  function dispose() {
    gfx.dispose();
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
    document.removeEventListener('keydown', onTacticKey);
    document.removeEventListener('keydown', onScoreKey);
    window.removeEventListener('keydown', onReplayKey, true);
    window.removeEventListener('keydown', onKeyHint);
    wrapEl.removeEventListener('pointermove', onMove);
    wrapEl.removeEventListener('pointerleave', onOut);
    endSkip();
    if (guardingBack) {
      window.removeEventListener('popstate', onPop);
      guardingBack = false;
      // Take the match's own entry back off, so the player's Back button goes where it went before the match.
      try { if ((history.state as { derbyMatch?: boolean } | null)?.derbyMatch) history.back(); } catch { /* no history */ }
    }
    replay?.skip.remove();
    replay = null;
  }
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    dispose();
  };
}
