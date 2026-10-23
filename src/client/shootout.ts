// Live penalty shootout: a front-on view of the goal on a canvas, a kick
// scoreboard, and the controls. Rules and resolution live in
// src/meta/shootout.ts; this file draws, reads input and keeps the timeline.
//
// Taking a kick: aim with the pointer (or the arrow keys), hold the left button
// (or Space) to build power, release to strike. Keeping: the CPU taker runs up
// with a tell; click left, centre or right of the goal (or arrow keys + Space,
// or the buttons) to dive before he strikes. Everything is reachable without a
// mouse and every result is announced in an aria-live region.

import {
  KICKS_PER_SIDE,
  MAX_POWER,
  SKY_START,
  SWEET_HI,
  SWEET_LO,
  createShootout,
  describeKick,
  diveFromX,
  finalScore,
  forfeitShootout,
  marks,
  planKick,
  playKick,
  type Aim,
  type Dive,
  type KickOutcome,
  type PenaltySide,
  type PlayedKick,
  type Shootout,
} from '../meta/shootout.ts';
import type { CrestPattern } from '../meta/names.ts';
import { crestSvg } from './crest.ts';

export interface ShootoutClub {
  name: string;
  short: string;
  primary: string;
  secondary: string;
  crest: CrestPattern;
}

export interface ShootoutResult {
  /** Penalties scored by you / by them. The winner is always ahead (a forfeit is shown as a one-kick loss). */
  you: number;
  opp: number;
  forfeited: boolean;
}

export interface ShootoutViewOptions {
  seed: number;
  /** Your side takes side 0; the CPU is side 1. */
  you: PenaltySide;
  opp: PenaltySide;
  youClub: ShootoutClub;
  oppClub: ShootoutClub;
  /** e.g. "Cup quarter-final". */
  label: string;
  onEnd: (r: ShootoutResult) => void;
}

const esc = (t: string | number): string =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

// Timeline, in ms.
const CHARGE_MS = 1500; // time for the meter to travel 0 -> 1.15
const POWER_CAP = 1.15; // the meter's end; reaching it strikes (and skies) automatically
const KEEPER_WINDOW_MS = 3800;
const KEEPER_WINDOW_REDUCED_MS = 7000;
const RUNUP_MS = 1500;
const WINDUP_MS = 240;
const FLIGHT_MS = 520;
const RESULT_MS = 1600;
const SKIP_AFTER_MS = 450;
const QUICK_POWER = 0.62;
const KEEPER_KITS = ['#f2c230', '#3fb7c9'];

type Phase = 'intro' | 'aim' | 'charge' | 'telegraph' | 'flight' | 'result' | 'done';

const DIVE_NAME: Record<number, string> = { [-1]: 'left', 0: 'centre', 1: 'right' };

const pct = (a: number, b: number) => `left:${(a * 100).toFixed(1)}%;width:${((b - a) * 100).toFixed(1)}%`;
/** The power meter's coloured zones: green sweet spot, amber risky, red (skied). */
function meterZones(): string {
  return `<span class="so-zone so-zone-sweet" style="${pct(SWEET_LO / POWER_CAP, SWEET_HI / POWER_CAP)}"></span>`
    + `<span class="so-zone so-zone-risky" style="${pct(SWEET_HI / POWER_CAP, MAX_POWER / POWER_CAP)}"></span>`
    + `<span class="so-zone so-zone-sky" style="${pct(MAX_POWER / POWER_CAP, 1)}"></span>`;
}

const OUTCOME_BANNER: Record<KickOutcome, string> = {
  goal: 'Goal!',
  saved: 'Saved!',
  post: 'Off the woodwork!',
  wide: 'Wide!',
  over: 'Over the bar!',
};

export function mountShootout(root: HTMLElement, o: ShootoutViewOptions): () => void {
  const sh: Shootout = createShootout(o.seed, o.you, o.opp);
  const clubs = [o.youClub, o.oppClub];
  const sides = [o.you, o.opp];
  const reduced = reducedMotion();
  const sideLabel = (i: number) => (i === 0 ? 'You' : sides[i].name);

  root.innerHTML = `
  <section class="shootout" aria-label="Penalty shootout">
    <header class="so-board" id="so-board"></header>
    <div class="so-stage">
      <canvas id="so-canvas" role="img" aria-label="The goal, seen from the penalty spot. Aim with the mouse or the arrow keys."></canvas>
      <div class="so-banner" id="so-banner" hidden></div>
      <div class="so-meter" id="so-meter" hidden aria-hidden="true">${meterZones()}<span class="so-fill" id="so-fill"></span></div>
      <div class="so-overlay" id="so-intro">
        <div class="so-card">
          <h2>Penalty shootout</h2>
          <p>${esc(o.label)} finished level. Best of five kicks each, then sudden death.</p>
          <ul class="so-howto">
            <li><b>Taking a kick:</b> move the mouse to aim, hold the left button to build power and let go to strike. Hit it too hard and it sails over the bar; the corners are riskier. <b>Keys:</b> arrows aim, hold Space and release to strike.</li>
            <li><b>Keeping:</b> watch the taker's run-up, then click the left, middle or right of the goal to dive before he strikes. <b>Keys:</b> arrows pick a side, Space dives.</li>
          </ul>
          <button class="btn primary big" id="so-start" type="button">Start the shootout</button>
        </div>
      </div>
      <div class="so-overlay" id="so-end" hidden>
        <div class="so-card" role="group" aria-labelledby="so-end-title">
          <h2 id="so-end-title"></h2>
          <p id="so-end-text"></p>
          <button class="btn primary big" id="so-continue" type="button">Continue</button>
        </div>
      </div>
    </div>
    <div class="so-info">
      <p class="so-who" id="so-who"></p>
      <p class="so-help" id="so-help"></p>
    </div>
    <div class="so-actions">
      <div class="so-dive" id="so-dive" hidden role="group" aria-label="Dive">
        <button class="btn" type="button" data-dive="-1">Dive left</button>
        <button class="btn" type="button" data-dive="0">Stay central</button>
        <button class="btn" type="button" data-dive="1">Dive right</button>
      </div>
      <button class="btn" type="button" id="so-quick" hidden>Strike at medium power</button>
      <button class="btn ghost" type="button" id="so-leave">Leave shootout (counts as a loss)</button>
    </div>
    <p class="visually-hidden" id="so-live" role="status" aria-live="polite"></p>
  </section>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const canvas = $<HTMLCanvasElement>('so-canvas');
  const ctx = canvas.getContext('2d')!;
  const live = $('so-live');
  const section = root.querySelector<HTMLElement>('.shootout')!;
  section.dataset.phase = 'intro';

  // --- state ---------------------------------------------------------------
  let phase: Phase = 'intro';
  let raf = 0;
  let disposed = false;
  let last = performance.now();
  let W = 0;
  let H = 0;
  let dpr = 1;

  /** Where the pointer or keys have the crosshair, in goal units. */
  const aim: Aim = { x: 0, y: 0.5 };
  const keys = new Set<string>();
  let chargeStart = 0;
  let chargeBy: 'pointer' | 'key' | null = null;
  let power = 0;

  let kickStart = 0; // when the current kick's phase began
  let tellDive: Dive = 0;
  let sel: Dive | null = null; // keeper's highlighted third
  let played: PlayedKick | null = null;
  let flightStart = 0;
  let flightDelay = 0;
  let resultStart = 0;
  let bannerTimer = 0;
  let leaveTimer = 0;
  let confirmLeave = false;

  // --- scoreboard ----------------------------------------------------------
  function renderBoard() {
    const turn = sh.done ? null : planKick(sh)?.turn;
    const suddenDeath = !sh.done && sh.taken[0] >= KICKS_PER_SIDE && sh.taken[1] >= KICKS_PER_SIDE;
    const rows = [0, 1].map((i) => {
      const side = i as 0 | 1;
      const ms = marks(sh, side);
      const nextIdx = turn && turn.side === side ? sh.taken[side] : -1;
      const list = ms
        .map((m, k) => {
          const word = m === null ? 'not taken yet' : m ? 'scored' : 'missed';
          const sym = m === null ? '–' : m ? '●' : '○';
          return `<li class="so-mark ${m === null ? 'pending' : m ? 'scored' : 'missed'}"${k === nextIdx ? ' aria-current="step"' : ''}><span aria-hidden="true">${sym}</span><span class="visually-hidden">Kick ${k + 1}: ${word}</span></li>`;
        })
        .join('');
      return `<div class="so-row${turn && turn.side === side ? ' kicking' : ''}">
        ${crestSvg(clubs[i], 26)}
        <span class="so-name">${esc(clubs[i].name)}${i === 0 ? ' <span class="so-you">you</span>' : ''}</span>
        <ol class="so-marks" aria-label="${esc(sideLabel(i))} kicks">${list}</ol>
        <span class="so-total" aria-label="${sh.score[i]} scored">${sh.score[i]}</span>
      </div>`;
    });
    $('so-board').innerHTML = `${rows.join('')}${suddenDeath ? '<div class="so-sd">Sudden death</div>' : ''}`;
  }

  // --- announcements and text ----------------------------------------------
  const say = (t: string) => {
    live.textContent = '';
    // Re-setting on the next tick makes screen readers repeat identical messages.
    setTimeout(() => {
      if (!disposed) live.textContent = t;
    }, 30);
  };
  const scoreText = () => `${o.youClub.name} ${sh.score[0]}, ${o.oppClub.name} ${sh.score[1]}.`;

  function setBanner(text: string | null) {
    const b = $('so-banner');
    clearTimeout(bannerTimer);
    if (text === null) {
      b.hidden = true;
      return;
    }
    b.textContent = text;
    b.hidden = false;
  }

  function setInfo(who: string, help: string) {
    $('so-who').innerHTML = who;
    $('so-help').textContent = help;
  }

  const showQuick = (v: boolean) => ($('so-quick').hidden = !v);
  const showDive = (v: boolean) => ($('so-dive').hidden = !v);
  function showMeter(mode: 'power' | 'timer' | null) {
    const m = $('so-meter');
    m.hidden = mode === null;
    m.classList.toggle('timer', mode === 'timer');
  }
  const setFill = (frac: number) => ($('so-fill').style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`);

  // --- phases --------------------------------------------------------------
  function beginKick(now: number) {
    const plan = planKick(sh);
    if (!plan) return finishShootout();
    renderBoard();
    setBanner(null);
    played = null;
    kickStart = now;
    const { turn } = plan;
    const takerSide = turn.side;
    if (takerSide === 0) {
      phase = 'aim';
      power = 0;
      chargeBy = null;
      sel = null;
      aim.x = 0;
      aim.y = 0.5;
      showMeter(null);
      showDive(false);
      showQuick(true);
      const n = turn.round + 1;
      setInfo(`<b>Your kick</b> (${n > KICKS_PER_SIDE ? 'sudden death' : `${n} of ${KICKS_PER_SIDE}`}): ${esc(turn.taker.name)}, shooting ${Math.round(turn.taker.shooting * 100)}`, 'Aim with the mouse or arrow keys. Hold the left button or Space to build power, release to strike. Strike in the green; too hard flies over the bar.');
      say(`Your kick, ${turn.taker.name}. Facing ${turn.keeper.name} in goal. Aim, hold to build power, release to strike.`);
    } else {
      phase = 'telegraph';
      tellDive = plan.tell;
      sel = null;
      showQuick(false);
      showDive(true);
      showMeter('timer');
      const n = turn.round + 1;
      setInfo(`<b>Save it</b> (${n > KICKS_PER_SIDE ? 'sudden death' : `${n} of ${KICKS_PER_SIDE}`}): ${esc(turn.taker.name)} steps up, shooting ${Math.round(turn.taker.shooting * 100)}`, `His run-up angles ${DIVE_NAME[tellDive]}, but he may be bluffing. Click the left, middle or right of the goal to dive, or use the arrow keys and Space.`);
      say(`${turn.taker.name} steps up for ${o.oppClub.name}. His run-up angles ${DIVE_NAME[tellDive]}. Choose left, centre or right to dive.`);
    }
  }

  function startCharge(by: 'pointer' | 'key', now: number) {
    if (phase !== 'aim') return;
    phase = 'charge';
    chargeBy = by;
    chargeStart = now;
    power = 0;
    showMeter('power');
    setFill(0);
  }

  function strike(now: number, p: number) {
    if (phase !== 'aim' && phase !== 'charge') return;
    chargeBy = null;
    showMeter(null);
    showQuick(false);
    launch(now, { aim: { x: aim.x, y: aim.y }, power: p });
  }

  function dive(now: number, d: Dive) {
    if (phase !== 'telegraph') return;
    showDive(false);
    showMeter(null);
    launch(now, { dive: d });
  }

  function launch(now: number, choice: { aim?: Aim; power?: number; dive?: Dive }) {
    played = playKick(sh, choice);
    phase = 'flight';
    flightStart = now;
    flightDelay = reduced ? 0 : WINDUP_MS;
    if (reduced) showResult(now);
  }

  function showResult(now: number) {
    if (!played) return;
    phase = 'result';
    resultStart = now;
    const p = played;
    const keeperName = p.turn.keeper.name;
    const text = describeKick(p.turn.taker.name, keeperName, p.result.outcome);
    setBanner(OUTCOME_BANNER[p.result.outcome]);
    const extra = p.turn.side === 1 ? ` You dived ${DIVE_NAME[p.result.dive]}.` : '';
    setInfo(`<b>${esc(text)}.</b> ${esc(scoreText())}`, extra.trim());
    say(`${text}.${extra} ${scoreText()}`);
    renderBoard();
  }

  function afterResult(now: number) {
    if (sh.done) finishShootout();
    else beginKick(now);
  }

  function finishShootout() {
    phase = 'done';
    setBanner(null);
    showDive(false);
    showQuick(false);
    showMeter(null);
    renderBoard();
    const [a, b] = finalScore(sh);
    const won = sh.winner === 0;
    $('so-end-title').textContent = won ? `You win ${a}–${b} on penalties` : `You lose ${a}–${b} on penalties`;
    $('so-end-text').textContent = sh.coinToss
      ? 'It went to a coin toss after a very long sudden death.'
      : won
        ? `${o.youClub.name} go through.`
        : `${o.oppClub.name} go through.`;
    $('so-end').hidden = false;
    setInfo(`<b>${won ? 'Shootout won' : 'Shootout lost'}</b> ${a}–${b}`, '');
    say(`${won ? 'You win' : 'You lose'} the shootout ${a} to ${b}.`);
    $('so-continue').focus();
  }

  function end(forfeited: boolean) {
    if (disposed) return;
    const [a, b] = finalScore(sh);
    dispose();
    o.onEnd({ you: a, opp: b, forfeited });
  }

  // --- input ---------------------------------------------------------------
  const cleanup: (() => void)[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = (el: EventTarget, type: string, fn: (e: any) => void) => {
    el.addEventListener(type, fn as EventListener);
    cleanup.push(() => el.removeEventListener(type, fn as EventListener));
  };

  function pointerToAim(e: PointerEvent): Aim {
    const r = canvas.getBoundingClientRect();
    const g = goalRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    return { x: clamp((px - (g.l + g.w / 2)) / (g.w / 2), -1.45, 1.45), y: clamp((g.b - py) / g.h, 0, 1.45) };
  }

  on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
  on(canvas, 'pointermove', (e: PointerEvent) => {
    const a = pointerToAim(e);
    if (phase === 'aim' || phase === 'charge') {
      aim.x = a.x;
      aim.y = a.y;
    } else if (phase === 'telegraph') sel = diveFromX(a.x);
  });
  on(canvas, 'pointerdown', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const a = pointerToAim(e);
    const now = performance.now();
    if (phase === 'aim') {
      aim.x = a.x;
      aim.y = a.y;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      startCharge('pointer', now);
    } else if (phase === 'telegraph') {
      dive(now, diveFromX(a.x));
    } else if (phase === 'result' && now - resultStart > SKIP_AFTER_MS) afterResult(now);
  });
  on(window, 'pointerup', () => {
    if (phase === 'charge' && chargeBy === 'pointer') strike(performance.now(), power);
  });
  on(window, 'pointercancel', () => {
    if (phase === 'charge' && chargeBy === 'pointer') {
      phase = 'aim';
      chargeBy = null;
      power = 0;
      showMeter(null);
    }
  });

  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  on(window, 'keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';
    const now = performance.now();
    if (ARROWS.includes(e.key)) {
      e.preventDefault();
      if (phase === 'aim' || phase === 'charge') keys.add(e.key);
      else if (phase === 'telegraph' && !e.repeat) {
        if (e.key === 'ArrowLeft') sel = ((sel ?? 0) <= 0 ? -1 : 0) as Dive;
        else if (e.key === 'ArrowRight') sel = ((sel ?? 0) >= 0 ? 1 : 0) as Dive;
        else if (e.key === 'ArrowDown') sel = 0;
      }
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (onButton) return; // let the focused button take it
      e.preventDefault();
      if (e.repeat) return;
      if (phase === 'aim') startCharge('key', now);
      else if (phase === 'telegraph') dive(now, sel ?? 0);
      else if (phase === 'result' && now - resultStart > SKIP_AFTER_MS) afterResult(now);
    }
  });
  on(window, 'keyup', (e: KeyboardEvent) => {
    keys.delete(e.key);
    if ((e.key === ' ' || e.key === 'Spacebar') && phase === 'charge' && chargeBy === 'key') strike(performance.now(), power);
  });
  on(window, 'blur', () => keys.clear());

  on($('so-start'), 'click', () => {
    if (phase !== 'intro') return;
    $('so-intro').hidden = true;
    beginKick(performance.now());
  });
  on($('so-quick'), 'click', () => strike(performance.now(), QUICK_POWER));
  on($('so-dive'), 'click', (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dive]');
    if (b) dive(performance.now(), Number(b.dataset.dive) as Dive);
  });
  on($('so-continue'), 'click', () => end(false));
  on($('so-leave'), 'click', () => {
    const btn = $('so-leave');
    if (!confirmLeave) {
      confirmLeave = true;
      btn.textContent = 'Really leave? Click again to lose the shootout';
      btn.classList.add('danger');
      say('Leaving counts as a loss. Activate the button again to confirm.');
      leaveTimer = window.setTimeout(() => {
        confirmLeave = false;
        btn.textContent = 'Leave shootout (counts as a loss)';
        btn.classList.remove('danger');
      }, 4000);
      return;
    }
    clearTimeout(leaveTimer);
    forfeitShootout(sh, 0);
    end(true);
  });

  // --- geometry --------------------------------------------------------------
  function goalRect() {
    const w = Math.min(W * 0.66, H * 1.3);
    const h = w * 0.42;
    const l = (W - w) / 2;
    const t = H * 0.09;
    return { l, t, w, h, b: t + h, r: l + w };
  }
  const spot = () => ({ x: W / 2, y: H * 0.8 });
  const toScreen = (a: Aim) => {
    const g = goalRect();
    return { x: g.l + g.w / 2 + (a.x * g.w) / 2, y: g.b - a.y * g.h };
  };

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(200, Math.round(r.width));
    H = Math.max(150, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // --- frame loop ----------------------------------------------------------------
  function update(now: number, dt: number) {
    if (phase === 'aim' || phase === 'charge') {
      const sp = keys.has('Shift') ? 1.8 : 1;
      if (keys.has('ArrowLeft')) aim.x -= 1.1 * sp * dt;
      if (keys.has('ArrowRight')) aim.x += 1.1 * sp * dt;
      if (keys.has('ArrowUp')) aim.y += 0.9 * sp * dt;
      if (keys.has('ArrowDown')) aim.y -= 0.9 * sp * dt;
      aim.x = clamp(aim.x, -1.45, 1.45);
      aim.y = clamp(aim.y, 0, 1.45);
    }
    if (phase === 'charge') {
      power = Math.min(POWER_CAP, ((now - chargeStart) / CHARGE_MS) * POWER_CAP);
      setFill(power / POWER_CAP);
      if (power >= POWER_CAP) strike(now, power);
    } else if (phase === 'telegraph') {
      const window_ = reduced ? KEEPER_WINDOW_REDUCED_MS : KEEPER_WINDOW_MS;
      const left = 1 - (now - kickStart) / window_;
      setFill(left);
      if (left <= 0) {
        say('Too slow. You stayed in the middle.');
        dive(now, 0);
      }
    } else if (phase === 'flight') {
      if (now - flightStart >= flightDelay + (reduced ? 0 : FLIGHT_MS)) showResult(now);
    } else if (phase === 'result') {
      if (now - resultStart >= RESULT_MS) afterResult(now);
    }
  }

  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(now, dt);
    draw(now);
    if (section.dataset.phase !== phase) section.dataset.phase = phase;
  }

  // --- drawing -----------------------------------------------------------------------
  function draw(now: number) {
    const c = ctx;
    const g = goalRect();
    c.clearRect(0, 0, W, H);
    drawBackdrop(c, g);

    // Timeline for the animated parts.
    const t = phase === 'flight' || phase === 'result' ? now - flightStart : 0;
    const flightP = !played ? 0 : reduced ? 1 : clamp((t - flightDelay) / FLIGHT_MS, 0, 1);
    const diveP = !played ? 0 : reduced ? 1 : clamp((t - flightDelay * 0.4) / 260, 0, 1);

    // Keeper (side that is defending this kick)
    const turn = played?.turn ?? planKickTurn();
    const keeperSide = turn ? (turn.side === 0 ? 1 : 0) : 1;
    const keeperDive = played ? played.result.dive : 0;
    drawNet(c, g, played && played.result.scored && flightP >= 1 ? now - flightStart - flightDelay - FLIGHT_MS : -1, played ? played.result.at : null);
    drawKeeper(c, g, KEEPER_KITS[keeperSide], keeperDive, diveP, now);
    drawFrame(c, g);

    if (phase === 'telegraph') drawDiveZones(c, g);
    if (phase === 'aim' || phase === 'charge') drawCrosshair(c, g);

    // Taker figure while you keep
    if (turn && turn.side === 1 && phase !== 'intro' && phase !== 'done') drawTaker(c, now, t);

    drawBall(c, g, flightP);
  }

  function planKickTurn() {
    const p = sh.done ? null : planKick(sh);
    return p ? p.turn : null;
  }

  function drawBackdrop(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>) {
    // Night sky and stands behind the goal.
    const sky = c.createLinearGradient(0, 0, 0, g.b);
    sky.addColorStop(0, '#0d1411');
    sky.addColorStop(1, '#1b2a24');
    c.fillStyle = sky;
    c.fillRect(0, 0, W, g.b);
    // Crowd dots
    c.fillStyle = 'rgba(255,255,255,.05)';
    for (let i = 0; i < 70; i++) {
      const x = ((i * 137) % 100) / 100 * W;
      const y = g.t * 0.2 + (((i * 61) % 100) / 100) * (g.t * 0.9);
      c.fillRect(x, y, 3, 3);
    }
    // Grass with mowing stripes, getting lighter toward the viewer.
    const grass = c.createLinearGradient(0, g.b, 0, H);
    grass.addColorStop(0, '#1f5a37');
    grass.addColorStop(1, '#2f7d4a');
    c.fillStyle = grass;
    c.fillRect(0, g.b, W, H - g.b);
    c.fillStyle = 'rgba(255,255,255,.04)';
    for (let k = 0; k < 8; k += 2) {
      const y0 = g.b + ((H - g.b) * k) / 8;
      const y1 = g.b + ((H - g.b) * (k + 1)) / 8;
      c.fillRect(0, y0, W, y1 - y0);
    }
    // Goal line, six-yard box, and the spot, in rough perspective.
    const s = spot();
    c.strokeStyle = 'rgba(243,246,241,.85)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, g.b);
    c.lineTo(W, g.b);
    c.stroke();
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(243,246,241,.5)';
    c.beginPath();
    c.moveTo(g.l - g.w * 0.12, g.b);
    c.lineTo(g.l - g.w * 0.3, g.b + (s.y - g.b) * 0.55);
    c.lineTo(g.r + g.w * 0.3, g.b + (s.y - g.b) * 0.55);
    c.lineTo(g.r + g.w * 0.12, g.b);
    c.stroke();
    c.fillStyle = 'rgba(243,246,241,.9)';
    c.beginPath();
    c.ellipse(s.x, s.y + H * 0.03, 5, 2.4, 0, 0, Math.PI * 2);
    c.fill();
  }

  function drawNet(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>, ripple: number, at: Aim | null) {
    const depth = g.h * 0.28;
    // Back of the net sits a little higher and narrower.
    const bl = g.l + g.w * 0.04;
    const br = g.r - g.w * 0.04;
    const bt = g.t - depth * 0.35;
    const bb = g.b - depth * 0.55;
    c.fillStyle = 'rgba(8,14,12,.55)';
    c.beginPath();
    c.moveTo(g.l, g.t);
    c.lineTo(g.r, g.t);
    c.lineTo(br, bt);
    c.lineTo(bl, bt);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(8,14,12,.4)';
    c.fillRect(g.l, g.t, g.w, g.h);
    c.strokeStyle = 'rgba(243,246,241,.22)';
    c.lineWidth = 1;
    const cols = 22;
    const rows = 9;
    const bump = (x: number, y: number) => {
      if (ripple < 0 || !at || reduced) return 0;
      const target = toScreen(at);
      const d = Math.hypot(x - target.x, y - target.y) / (g.w * 0.18);
      return Math.exp(-d * d) * Math.exp(-ripple / 260) * Math.sin(ripple / 55) * 7;
    };
    c.beginPath();
    for (let i = 0; i <= cols; i++) {
      const x = g.l + (g.w * i) / cols;
      for (let j = 0; j <= 16; j++) {
        const y = g.t + (g.h * j) / 16;
        const px = x + bump(x, y) * 0.3;
        const py = y + bump(x, y);
        if (j === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
    }
    for (let k = 0; k <= rows; k++) {
      const y = g.t + (g.h * k) / rows;
      for (let j = 0; j <= 28; j++) {
        const x = g.l + (g.w * j) / 28;
        const px = x + bump(x, y) * 0.3;
        const py = y + bump(x, y);
        if (j === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
    }
    c.stroke();
    // Side nets
    c.strokeStyle = 'rgba(243,246,241,.14)';
    c.beginPath();
    c.moveTo(g.l, g.t);
    c.lineTo(bl, bt);
    c.lineTo(bl, bb);
    c.lineTo(g.l, g.b);
    c.moveTo(g.r, g.t);
    c.lineTo(br, bt);
    c.lineTo(br, bb);
    c.lineTo(g.r, g.b);
    c.stroke();
  }

  function drawFrame(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>) {
    const pw = Math.max(4, g.w * 0.014);
    c.strokeStyle = '#f3f6f1';
    c.lineWidth = pw;
    c.lineCap = 'square';
    c.beginPath();
    c.moveTo(g.l, g.b);
    c.lineTo(g.l, g.t);
    c.lineTo(g.r, g.t);
    c.lineTo(g.r, g.b);
    c.stroke();
    c.lineCap = 'butt';
  }

  function drawPerson(c: CanvasRenderingContext2D, x: number, feet: number, h: number, shirt: string, shorts: string, pose: { lean: number; arms: number; stride: number; gloves?: boolean }) {
    c.save();
    c.translate(x, feet);
    c.rotate(pose.lean);
    const lw = h * 0.09;
    c.lineCap = 'round';
    // legs
    c.strokeStyle = '#e8c9a8';
    c.lineWidth = lw;
    c.beginPath();
    c.moveTo(-h * 0.06, -h * 0.42);
    c.lineTo(-h * 0.07 - pose.stride * h * 0.12, 0);
    c.moveTo(h * 0.06, -h * 0.42);
    c.lineTo(h * 0.07 + pose.stride * h * 0.12, 0);
    c.stroke();
    // shorts and torso
    c.fillStyle = shorts;
    c.fillRect(-h * 0.11, -h * 0.5, h * 0.22, h * 0.12);
    c.fillStyle = shirt;
    c.beginPath();
    c.roundRect(-h * 0.14, -h * 0.82, h * 0.28, h * 0.36, h * 0.06);
    c.fill();
    // arms: radians from straight down (0.3 by the side, 1.2 out wide, 2.7 straight up)
    const ang = pose.arms;
    const reach = h * 0.34;
    c.strokeStyle = shirt;
    c.lineWidth = lw * 0.95;
    for (const s of [-1, 1]) {
      const sx = s * h * 0.15;
      const sy = -h * 0.78;
      const ex = sx + s * Math.sin(ang) * reach;
      const ey = sy + Math.cos(ang) * reach;
      c.beginPath();
      c.moveTo(sx, sy);
      c.lineTo(ex, ey);
      c.stroke();
      if (pose.gloves) {
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(ex, ey, h * 0.055, 0, Math.PI * 2);
        c.fill();
      } else {
        c.fillStyle = '#e8c9a8';
        c.beginPath();
        c.arc(ex, ey, h * 0.04, 0, Math.PI * 2);
        c.fill();
      }
    }
    // head
    c.fillStyle = '#e8c9a8';
    c.beginPath();
    c.arc(0, -h * 0.92, h * 0.1, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function drawKeeper(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>, kit: string, d: Dive, p: number, now: number) {
    const h = g.h * 0.82;
    const bob = reduced || phase === 'flight' || phase === 'result' ? 0 : Math.sin(now / 260) * 0.03;
    const e = 1 - (1 - p) * (1 - p);
    const x = g.l + g.w / 2 + d * e * g.w * 0.28;
    const lean = d * e * 1.0;
    const jump = d === 0 ? Math.sin(e * Math.PI) * h * 0.18 : Math.sin(e * Math.PI) * h * 0.1;
    const arms = p > 0 ? (d === 0 ? 1.2 + 1.5 * e : 1.4 + 1.1 * e) : 1.1 + bob * 4;
    drawPerson(c, x, g.b - jump - g.h * 0.02, h, kit, '#1b2230', { lean, arms, stride: p > 0 ? 0.8 : 0.5, gloves: true });
  }

  function drawTaker(c: CanvasRenderingContext2D, now: number, t: number) {
    const turn = played?.turn ?? planKickTurn();
    if (!turn) return;
    const s = spot();
    const club = clubs[turn.side];
    // Run-up: starts off to the tell side and low, and ends angled behind the ball.
    // Committing to a dive early brings the last step forward; the angle stays as the tell.
    const elapsed = played ? (flightStart - kickStart) + t * 4 : now - kickStart;
    const p = reduced ? 1 : clamp(elapsed / RUNUP_MS, 0, 1);
    const e = 1 - (1 - p) * (1 - p);
    const x = s.x + tellDive * W * (0.2 - 0.165 * e);
    const y = s.y + H * 0.2 - H * 0.06 * e;
    const stride = reduced ? 0.4 : Math.abs(Math.sin(now / 90)) * (1 - e) * 1.2 + 0.2;
    drawPerson(c, x, y, H * 0.3, club.primary, club.secondary, { lean: tellDive * 0.1, arms: 0.4, stride });
  }

  function drawBall(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>, flightP: number) {
    const s = spot();
    const r0 = Math.max(9, H * 0.034);
    let x = s.x;
    let y = s.y;
    let r = r0;
    if (played && phase !== 'intro') {
      const at = played.result.at;
      const target = toScreen({ x: clamp(at.x, -1.6, 1.6), y: clamp(at.y, 0, 1.7) });
      const e = flightP;
      x = s.x + (target.x - s.x) * e;
      y = s.y + (target.y - s.y) * e - Math.sin(e * Math.PI) * H * 0.05;
      r = r0 * (1 - 0.6 * e);
      // After the whistle: a save drops, the woodwork bounces out.
      if (flightP >= 1 && !reduced) {
        const after = clamp((performance.now() - flightStart - flightDelay - FLIGHT_MS) / 420, 0, 1);
        if (played.result.outcome === 'saved') y += after * g.h * 0.18;
        else if (played.result.outcome === 'post') {
          x += Math.sign(at.x || 1) * -after * g.w * 0.08;
          y += after * g.h * 0.25;
        } else if (played.result.outcome === 'goal') y += after * g.h * 0.1;
      }
    }
    // shadow
    c.fillStyle = 'rgba(0,0,0,.25)';
    c.beginPath();
    c.ellipse(x, Math.max(y, g.b) + r * 0.9, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#f7f7f2';
    c.strokeStyle = '#1b2230';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#1b2230';
    c.beginPath();
    c.arc(x, y, r * 0.38, 0, Math.PI * 2);
    c.fill();
  }

  function drawCrosshair(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>) {
    const p = toScreen(aim);
    const x = clamp(p.x, 6, W - 6);
    const y = clamp(p.y, 6, H - 6);
    const risky = Math.abs(aim.x) > 0.8 || aim.y > 0.82;
    // The target area, so corners read as risky.
    c.strokeStyle = 'rgba(255,214,10,.28)';
    c.setLineDash([6, 5]);
    c.lineWidth = 1.5;
    c.strokeRect(g.l + g.w * 0.1, g.b - g.h * 0.9, g.w * 0.8, g.h * 0.8);
    c.setLineDash([]);
    const col = phase === 'charge' ? (power >= SKY_START ? '#ff7b5f' : power >= SWEET_LO ? '#5fd08e' : '#ffd60a') : '#ffd60a';
    c.strokeStyle = col;
    c.lineWidth = 2.5;
    const rr = 14 + (phase === 'charge' ? power * 6 : 0);
    c.beginPath();
    c.arc(x, y, rr, 0, Math.PI * 2);
    c.moveTo(x - rr - 8, y);
    c.lineTo(x - rr + 7, y);
    c.moveTo(x + rr - 7, y);
    c.lineTo(x + rr + 8, y);
    c.moveTo(x, y - rr - 8);
    c.lineTo(x, y - rr + 7);
    c.moveTo(x, y + rr - 7);
    c.lineTo(x, y + rr + 8);
    c.stroke();
    if (risky) {
      c.fillStyle = col;
      c.font = `700 ${Math.max(11, H * 0.026)}px 'Barlow', system-ui, sans-serif`;
      c.textAlign = 'center';
      c.fillText('risky', x, y - rr - 12);
    }
  }

  function drawDiveZones(c: CanvasRenderingContext2D, g: ReturnType<typeof goalRect>) {
    const third = g.w / 3;
    for (let k = 0; k < 3; k++) {
      const d = (k - 1) as Dive;
      const on = sel === d;
      c.fillStyle = on ? 'rgba(255,214,10,.28)' : 'rgba(255,255,255,.05)';
      c.fillRect(g.l + third * k + 2, g.t + 2, third - 4, g.h - 2);
      c.fillStyle = on ? '#ffd60a' : 'rgba(243,246,241,.7)';
      c.font = `800 ${Math.max(12, H * 0.034)}px 'Big Shoulders Display', 'Arial Narrow', sans-serif`;
      c.textAlign = 'center';
      c.fillText(['LEFT', 'CENTRE', 'RIGHT'][k], g.l + third * (k + 0.5), g.t + g.h * 0.55);
    }
  }

  // --- go -----------------------------------------------------------------------------
  renderBoard();
  setInfo('<b>Penalty shootout</b>', 'Press Start when you are ready.');
  raf = requestAnimationFrame(frame);
  $('so-start').focus();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(bannerTimer);
    clearTimeout(leaveTimer);
    ro.disconnect();
    for (const f of cleanup) f();
  }
  return dispose;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
