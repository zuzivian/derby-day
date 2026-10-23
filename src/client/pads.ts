// Hot-seat input: two players on one keyboard, plus the mouse for player 1.
// Keys are matched by KeyboardEvent.code (physical position), so Left and
// Right Shift are different keys and layouts other than QWERTY keep the same
// shape. Bindings (also listed in versus.ts and the README):
//
//   Player 1 (home):  W A S D move · Space pass/tackle · hold F, release: shoot
//                     E switch · Left Shift sprint
//                     Mouse too, once moved over the pitch: run to the pointer,
//                     left click pass/tackle, hold right shoot, right click switch.
//                     Pressing W A S D hands player 1 back to the keys.
//   Player 2 (away):  arrow keys move · Enter or / pass/tackle · hold . (period), release: shoot
//                     , (comma) switch · Right Shift sprint
//   Either:           Esc or P pause

import type { HumanInput, TeamInputs } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import type { PitchRenderer } from './render.ts';

export interface PadKeys {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  pass: string[];
  shoot: string[];
  switch: string[];
  sprint: string[];
}

export const P1_KEYS: PadKeys = {
  up: ['KeyW'],
  down: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  pass: ['Space'],
  shoot: ['KeyF'],
  switch: ['KeyE'],
  sprint: ['ShiftLeft'],
};

export const P2_KEYS: PadKeys = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  pass: ['Enter', 'NumpadEnter', 'Slash'],
  shoot: ['Period'],
  switch: ['Comma'],
  sprint: ['ShiftRight'],
};

/** Human-readable bindings, for the setup screen and the hint under the pitch. */
export const BINDINGS: { action: string; p1: string; p2: string }[] = [
  { action: 'Move', p1: 'W A S D (or the mouse)', p2: 'Arrow keys' },
  { action: 'Pass / tackle', p1: 'Space (or left click)', p2: 'Enter or /' },
  { action: 'Shoot', p1: 'Hold F, release (or hold right button)', p2: 'Hold . (period), release' },
  { action: 'Switch player', p1: 'E (or right click)', p2: ', (comma)' },
  { action: 'Sprint', p1: 'Left Shift', p2: 'Right Shift' },
  { action: 'Pause', p1: 'Esc or P', p2: 'Esc or P' },
];

const FULL_CHARGE_MS = 900;

class Pad {
  held = new Set<string>();
  pass = false;
  switchReq = false;
  shoot: number | null = null;
  chargeStart: number | null = null;
  constructor(readonly keys: PadKeys) {}

  has(list: string[]): boolean {
    return list.some((k) => this.held.has(k));
  }

  charge(): number {
    if (this.chargeStart === null) return 0;
    return Math.min(1, Math.max(0.15, (performance.now() - this.chargeStart) / FULL_CHARGE_MS));
  }

  release(): void {
    if (this.chargeStart === null) return;
    this.shoot = this.charge();
    this.chargeStart = null;
  }
}

export class HotseatInput {
  /** Player 1's pointer in world metres, while player 1 is on the mouse. */
  cursor: Vec | null = null;
  /** Player 1 steers with the mouse (moved it over the pitch) rather than W A S D. */
  mouse = false;
  private pads: [Pad, Pad] = [new Pad(P1_KEYS), new Pad(P2_KEYS)];
  private cleanup: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    renderer: PitchRenderer,
    private hasBall: (team: 0 | 1) => boolean,
    onPause: () => void,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
    };
    const all = (p: Pad) => Object.values(p.keys).flat() as string[];
    const p1 = this.pads[0];

    on(window, 'keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (!e.repeat) onPause();
        return;
      }
      for (const team of [0, 1] as const) {
        const pad = this.pads[team];
        if (!all(pad).includes(e.code)) continue;
        e.preventDefault(); // arrows, Space, "/" (quick find) and Enter must not scroll or click
        if (e.repeat) return;
        pad.held.add(e.code);
        if (team === 0 && [...P1_KEYS.up, ...P1_KEYS.down, ...P1_KEYS.left, ...P1_KEYS.right].includes(e.code)) this.mouse = false;
        if (pad.keys.pass.includes(e.code)) pad.pass = true;
        if (pad.keys.switch.includes(e.code)) pad.switchReq = true;
        if (pad.keys.shoot.includes(e.code) && pad.chargeStart === null) {
          if (this.hasBall(team)) pad.chargeStart = performance.now();
        }
        return;
      }
    });
    on(window, 'keyup', (e) => {
      for (const pad of this.pads) {
        if (!pad.held.delete(e.code)) continue;
        if (pad.keys.shoot.includes(e.code)) pad.release();
      }
    });
    on(window, 'blur', () => {
      for (const pad of this.pads) {
        pad.held.clear();
        pad.chargeStart = null;
      }
    });

    // Player 1's mouse.
    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return renderer.toWorld(e.clientX - r.left, e.clientY - r.top);
    };
    on(canvas, 'pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = true;
      this.cursor = toWorld(e);
    });
    on(canvas, 'pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = true;
      this.cursor = toWorld(e);
      if (e.button === 0) p1.pass = true;
      if (e.button === 2) {
        if (this.hasBall(0)) p1.chargeStart = performance.now();
        else p1.switchReq = true;
      }
    });
    on(window, 'pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button === 2) p1.release();
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
  }

  /** Shot charge per player, 0..1. */
  charges(): [number, number] {
    return [this.pads[0].charge(), this.pads[1].charge()];
  }

  /** Called once per sim tick: [player 1 (home), player 2 (away)]. One-shot actions are consumed. */
  take(): TeamInputs {
    return [this.takePad(0), this.takePad(1)];
  }

  private takePad(team: 0 | 1): HumanInput {
    const p = this.pads[team];
    const k = p.keys;
    const input: HumanInput = {};
    if (team === 0 && this.mouse && this.cursor) input.cursor = this.cursor;
    else input.dir = { x: (p.has(k.right) ? 1 : 0) - (p.has(k.left) ? 1 : 0), y: (p.has(k.down) ? 1 : 0) - (p.has(k.up) ? 1 : 0) };
    if (p.pass) input.pass = true;
    if (p.shoot !== null) input.shoot = p.shoot;
    if (p.has(k.sprint)) input.sprint = true;
    if (p.switchReq) input.switchPlayer = true;
    p.pass = false;
    p.shoot = null;
    p.switchReq = false;
    if (p.chargeStart !== null && !this.hasBall(team)) p.chargeStart = null;
    return input;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
