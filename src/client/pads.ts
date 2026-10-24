// Hot-seat input: two players on one keyboard, plus the mouse for player 1.
// Keys are matched by KeyboardEvent.code (physical position), so Left and
// Right Shift are different keys and layouts other than QWERTY keep the same
// shape. Bindings (also listed in versus.ts and the README):
//
//   Player 1 (home):  W A S D move · Space pass (tackle without the ball) · hold F, release: shoot
//                     hold C, release: lofted ball · E switch · Left Shift sprint
//                     Mouse too, once moved over the pitch (the same scheme as a normal match):
//                     run to the pointer (further = faster), left click pass, hold left loft,
//                     right click or hold right shoot; without the ball left click picks a
//                     player and right click tackles. Pressing W A S D hands player 1 back to the keys.
//   Player 2 (away):  arrow keys move · Enter or / pass (tackle without the ball) · hold . (period), release: shoot
//                     hold M, release: lofted ball · , (comma) switch · Right Shift sprint
//   Either:           Esc or P pause

import type { HumanInput, TeamInputs } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import { CLICK_MS, focusIsControl, latchedPoint, leftRelease, loftPower, MOVE_PX, shotPower, SHOT_FULL_MS, type WorldPicker } from './input.ts';

export interface PadKeys {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  pass: string[];
  shoot: string[];
  loft: string[];
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
  loft: ['KeyC'],
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
  loft: ['KeyM'],
  switch: ['Comma'],
  sprint: ['ShiftRight'],
};

/** Human-readable bindings, for the setup screen and the hint under the pitch. */
export const BINDINGS: { action: string; p1: string; p2: string }[] = [
  { action: 'Move', p1: 'W A S D (or the mouse: further out = faster)', p2: 'Arrow keys' },
  { action: 'Pass / tackle', p1: 'Space (or left click / right click)', p2: 'Enter or /' },
  { action: 'Loft', p1: 'Hold C, release (or hold left button)', p2: 'Hold M, release' },
  { action: 'Shoot', p1: 'Hold F, release (or right button)', p2: 'Hold . (period), release' },
  { action: 'Switch player', p1: 'E (or left click a player)', p2: ', (comma)' },
  { action: 'Sprint', p1: 'Left Shift (the mouse sprints by distance)', p2: 'Right Shift' },
  { action: 'Pause', p1: 'Esc or P', p2: 'Esc or P' },
];

class Pad {
  held = new Set<string>();
  pass = false;
  tackle = false;
  select = false;
  switchReq = false;
  shoot: number | null = null;
  loft: number | null = null;
  /** F / right button / mouse-left press times, while down with the ball. */
  shotStart: number | null = null;
  loftStart: number | null = null;
  /** The loft in progress began on the mouse's left button, so a quick click is a pass. */
  loftIsClick = false;
  constructor(readonly keys: PadKeys) {}

  /** Drop everything queued or held (pause, resume, replays). */
  reset(): void {
    this.held.clear();
    this.pass = this.tackle = this.select = this.switchReq = false;
    this.shoot = this.loft = null;
    this.shotStart = this.loftStart = null;
    this.loftIsClick = false;
  }

  has(list: string[]): boolean {
    return list.some((k) => this.held.has(k));
  }

  /** 0..1 progress of the shot or loft in progress, for the charge bar. */
  charge(): number {
    const now = performance.now();
    if (this.shotStart !== null) return Math.min(1, Math.max(0.04, (now - this.shotStart) / SHOT_FULL_MS));
    if (this.loftStart !== null && (!this.loftIsClick || now - this.loftStart >= CLICK_MS)) return Math.min(1, Math.max(0.04, loftPower(now - this.loftStart)));
    return 0;
  }

  releaseShot(): void {
    if (this.shotStart === null) return;
    this.shoot = shotPower(performance.now() - this.shotStart);
    this.shotStart = null;
  }

  releaseLoft(): void {
    if (this.loftStart === null) return;
    const held = performance.now() - this.loftStart;
    this.loftStart = null;
    if (this.loftIsClick) {
      // The mouse's left button: a click (anything under CLICK_MS) is always a ground pass.
      const r = leftRelease(held);
      if ('pass' in r) this.pass = true;
      else this.loft = r.loft;
    } else this.loft = loftPower(held);
    this.loftIsClick = false;
  }
}

export class HotseatInput {
  /** Player 1's pointer in world metres, while player 1 is on the mouse. */
  cursor: Vec | null = null;
  /** Player 1 steers with the mouse (moved it over the pitch) rather than W A S D. */
  mouse = false;
  private pads: [Pad, Pad] = [new Pad(P1_KEYS), new Pad(P2_KEYS)];
  private cleanup: (() => void)[] = [];
  /**
   * Last pointer position, client pixels. As in InputController, the world point is taken when the
   * mouse moves and kept while it is still (and again when the renderer reports a cut).
   */
  private client: { x: number; y: number } | null = null;
  private cutSeen = -1;
  /** Player 1's on-screen pointer travel since the last tick (HumanInput.moved). */
  private travel = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private picker: WorldPicker,
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
      // A focused button or checkbox (the pause menu) keeps its own keys.
      if (focusIsControl(e.target, canvas)) return;
      for (const team of [0, 1] as const) {
        const pad = this.pads[team];
        if (!all(pad).includes(e.code)) continue;
        e.preventDefault(); // arrows, Space, "/" (quick find) and Enter must not scroll or click
        if (e.repeat) return;
        pad.held.add(e.code);
        if (team === 0 && [...P1_KEYS.up, ...P1_KEYS.down, ...P1_KEYS.left, ...P1_KEYS.right].includes(e.code)) this.mouse = false;
        if (pad.keys.pass.includes(e.code)) {
          if (this.hasBall(team)) pad.pass = true;
          else pad.tackle = true;
        }
        if (pad.keys.switch.includes(e.code)) pad.switchReq = true;
        if (pad.keys.shoot.includes(e.code) && pad.shotStart === null && this.hasBall(team)) pad.shotStart = performance.now();
        if (pad.keys.loft.includes(e.code) && pad.loftStart === null && this.hasBall(team)) {
          pad.loftStart = performance.now();
          pad.loftIsClick = false;
        }
        return;
      }
    });
    on(window, 'keyup', (e) => {
      for (const pad of this.pads) {
        if (!pad.held.delete(e.code)) continue;
        if (pad.keys.shoot.includes(e.code)) pad.releaseShot();
        if (pad.keys.loft.includes(e.code) && !pad.loftIsClick) pad.releaseLoft();
      }
    });
    on(window, 'blur', () => {
      for (const pad of this.pads) {
        pad.held.clear();
        pad.shotStart = pad.loftStart = null;
      }
    });

    // Player 1's mouse: the same scheme as a normal match.
    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const w = latchedPoint(this.cursor, this.client, e, () => picker.toWorld(e.clientX - r.left, e.clientY - r.top));
      this.client = { x: e.clientX, y: e.clientY };
      return w;
    };
    on(canvas, 'pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = true;
      if (this.client) this.travel += Math.hypot(e.clientX - this.client.x, e.clientY - this.client.y);
      this.cursor = toWorld(e);
    });
    on(canvas, 'pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = true;
      this.cursor = toWorld(e);
      if (e.button === 0) {
        if (this.hasBall(0)) {
          p1.loftStart = performance.now();
          p1.loftIsClick = true;
        } else p1.select = true;
      }
      if (e.button === 2) {
        if (this.hasBall(0)) p1.shotStart = performance.now();
        else p1.tackle = true;
      }
    });
    on(window, 'pointerup', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (e.button === 0 && p1.loftIsClick) p1.releaseLoft();
      if (e.button === 2) p1.releaseShot();
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
  }

  /** Forget both players' queued kicks, charges and held keys (pause, resume, replays). */
  reset(): void {
    for (const p of this.pads) p.reset();
  }

  /** Charge progress (shot or loft) per player, 0..1. */
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
    const cuts = this.picker.cuts?.() ?? 0;
    if (team === 0 && cuts !== this.cutSeen) {
      this.cutSeen = cuts;
      if (this.mouse && this.client) {
        const r = this.canvas.getBoundingClientRect();
        this.cursor = this.picker.toWorld(this.client.x - r.left, this.client.y - r.top);
      }
    }
    const pointer = team === 0 && this.mouse && this.cursor;
    if (pointer) {
      input.cursor = this.cursor!;
      if (this.travel >= MOVE_PX) input.moved = true;
      this.travel = 0;
    } else input.dir = { x: (p.has(k.right) ? 1 : 0) - (p.has(k.left) ? 1 : 0), y: (p.has(k.down) ? 1 : 0) - (p.has(k.up) ? 1 : 0) };
    if (p.pass) input.pass = true;
    if (p.loft !== null) input.loft = p.loft;
    if (p.shoot !== null) input.shoot = p.shoot;
    if (p.tackle) input.tackle = true;
    if (p.select && pointer) input.select = true;
    if (p.has(k.sprint)) input.sprint = true;
    if (p.switchReq) input.switchPlayer = true;
    p.pass = p.tackle = p.select = p.switchReq = false;
    p.shoot = p.loft = null;
    if (!this.hasBall(team)) p.shotStart = p.loftStart = null;
    return input;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
