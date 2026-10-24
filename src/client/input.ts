// Mouse, keyboard and touch, folded into one HumanInput per sim tick.
//
// Mouse (the main scheme, see src/sim/human.ts for what the sim does with it).
// Your player runs toward the pointer, and the further away the pointer is the
// faster: a walk close in, a full sprint from 12 m out. No sprint key.
//   With the ball
//     Left click           ground pass that rolls to the pointer
//     Left press and hold  lofted ball that lands at the pointer; the longer the hold, the higher and further
//     Right click          shot toward the pointer; hold right for more power, release to strike
//   Without the ball
//     Left click           switch to the teammate under the pointer, else the nearest one in that direction
//     Right click          tackle toward the pointer: standing when it is near, a slide when it is far
// Keyboard (secondary): WASD/arrows run, Space pass (tackle without the ball), hold F shoot,
// hold C loft, E switch, Shift sprint. Pressing a movement key hands you to the keys; moving
// the mouse hands you back.
// Touch: drag to run toward your finger; Pass button: tap to pass, hold to loft (without the ball it
// picks a player toward your finger); Shoot button: shoot (without the ball, tackle). Tapping a
// player on the pitch without the ball picks him.
//
// This file reaches a renderer only through toWorld (see WorldPicker). What a renderer needs to draw
// aim feedback is public: `cursor` (pointer in world metres, null until it has moved), `mode`
// ('mouse' | 'keys'), `armed()` (which kick is charging, 'loft' | 'shot' | null, and the power it
// would go with), `charge()` (0..1 progress for a bar) and `switchCandidate()` (who a left click
// would switch to when you do not have the ball).

import { pickTeammate } from '../sim/human.ts';
import type { HumanInput, MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';

/** The one thing the input needs from whatever draws the pitch: pointer pixels to world metres. */
export interface WorldPicker {
  /** Position in CSS pixels inside the canvas (the canvas's top-left is 0,0) to world metres. */
  toWorld(cssX: number, cssY: number): Vec;
  /** Keyboard direction in screen terms (x right, y down) to world terms; identity when absent (top-down view). */
  screenDir?(d: Vec): Vec;
}

/** A left press shorter than this is a click (pass); longer is a loft being charged. */
export const TAP_MS = 200;
/** How long past TAP_MS it takes to charge a loft to full. */
export const LOFT_FULL_MS = 800;
/** A quick right click is a shot at this power; holding builds it to 1 over SHOT_FULL_MS. */
export const SHOT_MIN = 0.55;
export const SHOT_FULL_MS = 800;

/** Hold time to loft power, 0..1. A hold at the tap threshold is the lowest, flattest loft. */
export const loftPower = (heldMs: number): number => Math.min(1, Math.max(0, (heldMs - TAP_MS) / LOFT_FULL_MS));
/** Hold time to shot power: SHOT_MIN for a click, 1 after SHOT_FULL_MS. */
export const shotPower = (heldMs: number): number => SHOT_MIN + (1 - SHOT_MIN) * Math.min(1, Math.max(0, heldMs / SHOT_FULL_MS));

/** The kick being charged right now, for the renderer's aim feedback. */
export interface Armed {
  kind: 'loft' | 'shot' | null;
  /** The power the kick would go with if released now: loft hold 0..1, or shot power SHOT_MIN..1. */
  power: number;
}

/** Tap on a touch screen: at most this long and this many CSS pixels of travel. */
const TOUCH_TAP_MS = 260;
const TOUCH_TAP_PX = 14;

export class InputController {
  cursor: Vec | null = null;
  mode: 'mouse' | 'keys' = 'mouse';
  private keys = new Set<string>();
  private pass = false;
  private tackle = false;
  private select = false;
  private switchReq = false;
  private shoot: number | null = null;
  private loft: number | null = null;
  /** Left button (or the Pass button) down with the ball: when, or null. */
  private leftStart: number | null = null;
  /** Right button, Shoot button or F down with the ball. */
  private shotStart: number | null = null;
  /** C down with the ball: a loft with no tap-to-pass (unlike the left button). */
  private loftKeyStart: number | null = null;
  private touchTap: { t: number; x: number; y: number; id: number } | null = null;
  private cleanup: (() => void)[] = [];
  /** Last pointer position, client pixels. Re-projected every tick: a moving 3D camera slides the pitch under a still mouse. */
  private client: { x: number; y: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private picker: WorldPicker,
    private hasBall: () => boolean,
    private onPause: () => void,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const toWorld = (e: PointerEvent) => {
      this.client = { x: e.clientX, y: e.clientY };
      const r = canvas.getBoundingClientRect();
      return picker.toWorld(e.clientX - r.left, e.clientY - r.top);
    };

    on(canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
    on(canvas, 'pointermove', (e) => {
      if (e.pointerType === 'mouse') this.mode = 'mouse';
      this.cursor = toWorld(e);
    });
    on(canvas, 'pointerdown', (e) => {
      this.cursor = toWorld(e);
      if (e.pointerType !== 'mouse') {
        // Touch steers by dragging; a quick tap with no ball picks a player (checked on release).
        this.touchTap = { t: performance.now(), x: e.clientX, y: e.clientY, id: e.pointerId };
        return;
      }
      this.mode = 'mouse';
      if (e.button === 0) this.pressLeft();
      if (e.button === 2) this.pressRight();
    });
    on(window, 'pointerup', (e) => {
      if (e.pointerType !== 'mouse') {
        const tap = this.touchTap;
        this.touchTap = null;
        if (tap && tap.id === e.pointerId && performance.now() - tap.t < TOUCH_TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TOUCH_TAP_PX && !this.hasBall()) this.select = true;
        return;
      }
      if (e.button === 0) this.releaseLeft();
      if (e.button === 2) this.releaseShot();
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());

    on(window, 'keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'p') {
        // Ignore auto-repeat, or holding the key flickers pause on and off.
        if (!e.repeat) this.onPause();
        return;
      }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (e.repeat) return;
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) this.mode = 'keys';
      this.keys.add(k);
      if (k === ' ') {
        if (this.hasBall()) this.pass = true;
        else this.tackle = true;
      }
      if (k === 'e' || k === 'q') this.switchReq = true;
      if (k === 'f' && this.hasBall() && this.shotStart === null) this.shotStart = performance.now();
      if (k === 'c' && this.hasBall() && this.loftKeyStart === null) this.loftKeyStart = performance.now();
    });
    on(window, 'keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === 'f') this.releaseShot();
      if (k === 'c' && this.loftKeyStart !== null) {
        this.loft = loftPower(performance.now() - this.loftKeyStart);
        this.loftKeyStart = null;
      }
    });
    on(window, 'blur', () => {
      this.keys.clear();
      this.leftStart = this.shotStart = this.loftKeyStart = null;
    });
  }

  private pressLeft(): void {
    if (this.hasBall()) this.leftStart = performance.now();
    else this.select = true;
  }

  private pressRight(): void {
    if (this.hasBall()) this.shotStart = performance.now();
    else this.tackle = true;
  }

  /** Left button up: a quick click is a pass, a hold is a loft. */
  private releaseLeft(): void {
    if (this.leftStart === null) return;
    const held = performance.now() - this.leftStart;
    this.leftStart = null;
    if (held < TAP_MS) this.pass = true;
    else this.loft = loftPower(held);
  }

  private releaseShot(): void {
    if (this.shotStart === null) return;
    this.shoot = shotPower(performance.now() - this.shotStart);
    this.shotStart = null;
  }

  /** On-screen buttons for touch screens. */
  bindTouchButtons(passBtn: HTMLElement, shootBtn: HTMLElement): void {
    const down = (fn: () => void) => (e: Event) => {
      e.preventDefault();
      fn();
    };
    const end = (fn: () => void) => (e: Event) => {
      e.preventDefault();
      fn();
    };
    passBtn.addEventListener('pointerdown', down(() => this.pressLeft()));
    passBtn.addEventListener('pointerup', end(() => this.releaseLeft()));
    passBtn.addEventListener('pointercancel', end(() => this.releaseLeft()));
    shootBtn.addEventListener('pointerdown', down(() => this.pressRight()));
    shootBtn.addEventListener('pointerup', end(() => this.releaseShot()));
    shootBtn.addEventListener('pointercancel', end(() => this.releaseShot()));
  }

  /** The kick being charged, for the renderer: a loft (left held past a click, or C) or a shot (right, Shoot or F). */
  armed(): Armed {
    const now = performance.now();
    if (this.shotStart !== null) return { kind: 'shot', power: shotPower(now - this.shotStart) };
    if (this.loftKeyStart !== null) return { kind: 'loft', power: loftPower(now - this.loftKeyStart) };
    if (this.leftStart !== null && now - this.leftStart >= TAP_MS) return { kind: 'loft', power: loftPower(now - this.leftStart) };
    return { kind: null, power: 0 };
  }

  /** 0..1 charge progress for a bar: how far the shot or loft in `armed()` is from full. 0 when nothing is charging. */
  charge(): number {
    const now = performance.now();
    if (this.shotStart !== null) return Math.min(1, Math.max(0.04, (now - this.shotStart) / SHOT_FULL_MS));
    if (this.loftKeyStart !== null) return Math.min(1, Math.max(0.04, loftPower(now - this.loftKeyStart)));
    if (this.leftStart !== null && now - this.leftStart >= TAP_MS) return Math.min(1, Math.max(0.04, loftPower(now - this.leftStart)));
    return 0;
  }

  /**
   * Index of the teammate a left click would switch to right now: the one under the pointer, else the
   * nearest in its direction. -1 when you have the ball, the pointer is not in use, nobody qualifies,
   * or it is the player you already steer.
   */
  switchCandidate(s: MatchState, team: 0 | 1 = 0): number {
    if (this.mode !== 'mouse' || !this.cursor || this.hasBall() || s.controlled[team] < 0) return -1;
    const pick = pickTeammate(s, team, this.cursor);
    return pick === s.controlled[team] ? -1 : pick;
  }

  /** Called once per sim tick. One-shot actions are consumed here. */
  take(): HumanInput {
    const input: HumanInput = {};
    if (this.client && this.mode === 'mouse') {
      const r = this.canvas.getBoundingClientRect();
      this.cursor = this.picker.toWorld(this.client.x - r.left, this.client.y - r.top);
    }
    const pointer = this.mode === 'mouse' && this.cursor;
    if (pointer) input.cursor = this.cursor!;
    else {
      const k = this.keys;
      const d = {
        x: (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0),
        y: (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0),
      };
      input.dir = this.picker.screenDir ? this.picker.screenDir(d) : d;
    }
    if (this.pass) input.pass = true;
    if (this.loft !== null) input.loft = this.loft;
    if (this.shoot !== null) input.shoot = this.shoot;
    if (this.tackle) input.tackle = true;
    if (this.select && pointer) input.select = true;
    if (this.keys.has('shift')) input.sprint = true;
    if (this.switchReq) input.switchPlayer = true;
    this.pass = this.tackle = this.select = this.switchReq = false;
    this.loft = this.shoot = null;
    // Lose the ball mid-charge and the charge is dropped.
    if (!this.hasBall()) this.leftStart = this.shotStart = this.loftKeyStart = null;
    return input;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
