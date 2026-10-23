// Mouse, keyboard and touch, folded into one HumanInput per sim tick.
//
// Mouse (primary): your player runs toward the pointer.
//   Left click   pass toward the pointer (or tackle, without the ball)
//   Ctrl/Cmd + left click   through ball: into space ahead of the receiver
//   Right hold   charge a shot, release to strike at the pointer
//   Ctrl/Cmd + right hold   same, but a chip (lofted, lands at the pointer)
//   Right click  switch player, when you don't have the ball
//   Shift or hold middle button   sprint
// Keyboard: WASD / arrows move, Space pass or tackle, R through ball, F hold to
// shoot, C hold to chip, Shift sprint, E switch.

import type { HumanInput } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import type { PitchRenderer } from './render.ts';

const FULL_CHARGE_MS = 900;

export class InputController {
  cursor: Vec | null = null;
  mode: 'mouse' | 'keys' = 'mouse';
  private keys = new Set<string>();
  private pass = false;
  private switchReq = false;
  private shoot: number | null = null;
  private chip = false;
  private through = false;
  private chargeStart: number | null = null;
  /** The charge in progress will be a chip (modifier held at press, or the C key). */
  private chipCharge = false;
  private middle = false;
  /** Ctrl or Cmd is down right now. */
  private mod = false;
  private cleanup: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    renderer: PitchRenderer,
    private hasBall: () => boolean,
    private onPause: () => void,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };

    on(canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
    on(canvas, 'pointermove', (e) => {
      this.mod = e.ctrlKey || e.metaKey;
      if (e.pointerType === 'mouse') this.mode = 'mouse';
      const r = canvas.getBoundingClientRect();
      this.cursor = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
    });
    on(canvas, 'pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      this.cursor = renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
      if (e.pointerType !== 'mouse') return; // touch steers; the on-screen buttons act
      this.mode = 'mouse';
      this.mod = e.ctrlKey || e.metaKey;
      if (e.button === 0) {
        this.pass = true;
        this.through = this.mod;
      }
      if (e.button === 1) this.middle = true;
      if (e.button === 2) {
        if (this.hasBall()) {
          this.chargeStart = performance.now();
          this.chipCharge = this.mod;
        } else this.switchReq = true;
      }
    });
    on(window, 'pointerup', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mod = e.ctrlKey || e.metaKey;
      if (e.button === 1) this.middle = false;
      if (e.button === 2) this.releaseShot();
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());

    on(window, 'keydown', (e) => {
      const k = e.key.toLowerCase();
      this.mod = e.ctrlKey || e.metaKey;
      if (k === 'escape' || k === 'p') {
        // Ignore auto-repeat, or holding the key flickers pause on and off.
        if (!e.repeat) this.onPause();
        return;
      }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (e.repeat) return;
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) this.mode = 'keys';
      this.keys.add(k);
      if (k === ' ') this.pass = true;
      if (k === 'r') {
        this.pass = true;
        this.through = true;
      }
      if (k === 'e' || k === 'q') this.switchReq = true;
      if ((k === 'f' || k === 'c') && this.hasBall() && this.chargeStart === null) {
        this.chargeStart = performance.now();
        this.chipCharge = k === 'c';
      }
    });
    on(window, 'keyup', (e) => {
      const k = e.key.toLowerCase();
      this.mod = e.ctrlKey || e.metaKey;
      this.keys.delete(k);
      if (k === 'f' || k === 'c') this.releaseShot();
    });
    on(window, 'blur', () => {
      this.keys.clear();
      this.chargeStart = null;
      this.middle = false;
      this.mod = false;
    });
  }

  /** On-screen buttons for touch screens. */
  bindTouchButtons(passBtn: HTMLElement, shootBtn: HTMLElement): void {
    const pass = (e: Event) => {
      e.preventDefault();
      this.pass = true;
    };
    const startShot = (e: Event) => {
      e.preventDefault();
      if (this.hasBall()) this.chargeStart = performance.now();
      else this.switchReq = true;
    };
    const endShot = (e: Event) => {
      e.preventDefault();
      this.releaseShot();
    };
    passBtn.addEventListener('pointerdown', pass);
    shootBtn.addEventListener('pointerdown', startShot);
    shootBtn.addEventListener('pointerup', endShot);
    shootBtn.addEventListener('pointercancel', endShot);
  }

  private releaseShot(): void {
    if (this.chargeStart === null) return;
    this.shoot = this.charge();
    this.chip = this.chipCharge || this.mod;
    this.chargeStart = null;
    this.chipCharge = false;
  }

  /** Holding sprint right now (Shift or middle button). */
  sprinting(): boolean {
    return this.keys.has('shift') || this.middle;
  }

  /** What the next kick would be, for the renderer's previews. */
  armed(): { through: boolean; chip: boolean } {
    return { through: this.mod, chip: this.chargeStart !== null && (this.chipCharge || this.mod) };
  }

  /** 0..1 while a shot is being charged, else 0. */
  charge(): number {
    if (this.chargeStart === null) return 0;
    return Math.min(1, Math.max(0.15, (performance.now() - this.chargeStart) / FULL_CHARGE_MS));
  }

  /** Called once per sim tick. One-shot actions are consumed here. */
  take(): HumanInput {
    const input: HumanInput = {};
    if (this.mode === 'mouse' && this.cursor) input.cursor = this.cursor;
    else {
      const k = this.keys;
      input.dir = {
        x: (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0),
        y: (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0),
      };
    }
    if (this.pass) input.pass = true;
    if (this.pass && this.through) input.through = true;
    if (this.shoot !== null) input.shoot = this.shoot;
    if (this.shoot !== null && this.chip) input.chip = true;
    if (this.sprinting()) input.sprint = true;
    if (this.switchReq) input.switchPlayer = true;
    this.pass = false;
    this.through = false;
    this.chip = false;
    this.shoot = null;
    this.switchReq = false;
    if (this.chargeStart !== null && !this.hasBall()) this.chargeStart = null;
    return input;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
