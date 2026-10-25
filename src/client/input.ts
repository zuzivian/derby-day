// Mouse, keyboard and touch, folded into one HumanInput per sim tick.
//
// Mouse (the main scheme, see src/sim/human.ts for what the sim does with it).
// Your player runs toward the pointer, and the further away the pointer is the
// faster: a walk close in, a full sprint from 12 m out. No sprint key.
//   With the ball
//     Left click           ground pass: to the teammate at or toward the pointer, else to the point.
//                          Any press shorter than CLICK_MS (300 ms; 360 ms for touch and pen) is a
//                          click, so a click is always a ground pass, never a lofted ball.
//     Left press and hold  lofted ball that lands at the pointer; the charge shows from CLICK_MS and is
//                          full at CLICK_MS + LOFT_RAMP_MS (900 ms in all); the longer, the higher and further
//     Right click          shot toward the pointer; hold right for more power, release to strike
//     (free kick)          the shot goes where right went down; drag sideways while holding to curl it
//                          that way (CURL_DRAG_M, about 4 m of pitch, for full bend; see curlFrom)
//     (corner, free kick,  hold left: a ball that lands where left went down at any range, driven for a
//      goal kick)          short hold and floated for a long one; drag sideways while holding to swing it
//     (keeper)             left click rolls it out, left hold throws or kicks it high, right click punts
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
// A click aims where the button went down (if the pointer moved less than AIM_DRIFT_PX before it came up),
// not where it is when it comes up. The run target is the pointer through a One Euro filter (calm when still,
// no lag when it moves fast); kicks use the raw point. `moved` tells the sim the pointer really moved (not
// just the camera sliding the pitch under it), which ends the hold after an automatic change of player.
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
  /**
   * A press on a player's body picks him (his feet, world metres), or null: the 3D view, where a head is
   * metres up-screen of the feet. `who`: the human's team-mates (never the man he steers) or opponents.
   */
  pickPlayer?(cssX: number, cssY: number, who: 'mates' | 'opponents'): Vec | null;
  /** Keyboard direction in screen terms (x right, y down) to world terms; identity when absent (top-down view). */
  screenDir?(d: Vec): Vec;
  /**
   * A counter the renderer bumps when the view jumps or is being re-framed on its own (a cut, a
   * replay ending, a zoom, the long view coming or going). While it changes, a still pointer's world
   * point is taken again from under it; otherwise it stays on its grass (see InputController.client).
   */
  cuts?(): number;
}

/**
 * Does the focused control use this key itself, so the game should leave it alone? Text fields keep
 * every key; radios, sliders and selects keep Space, Enter and the arrows; buttons, checkboxes and
 * links keep only Space and Enter. Everything else (WASD, the arrows on a button, the shoot and
 * switch keys) still reaches the game, so a keyboard player who Tabs onto a HUD button keeps moving.
 */
export function controlKeepsKey(t: EventTarget | null, canvas: unknown, key: string): boolean {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null;
  if (!el || el === canvas || !el.tagName) return false;
  const tag = el.tagName;
  const type = (el.type ?? '').toLowerCase();
  const role = el.getAttribute?.('role') ?? '';
  if (el.isContentEditable || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test(type)) return true;
  const press = key === ' ' || key === 'Enter';
  const arrow = key.startsWith('Arrow');
  if (tag === 'SELECT' || (tag === 'INPUT' && (type === 'radio' || type === 'range')) || role === 'radio' || role === 'slider') return press || arrow;
  if (/^(BUTTON|INPUT|A|SUMMARY)$/.test(tag) || role === 'button' || role === 'checkbox' || role === 'link' || role === 'switch') return press;
  return false;
}

/**
 * The world point for a pointer event, keeping the latched point when the pointer hasn't moved on
 * screen since it was taken (a click with a still mouse goes where the ring and wedge show, even if
 * the camera has panned since). Shared by InputController and the hot-seat HotseatInput.
 */
export function latchedPoint(prev: Vec | null, client: { x: number; y: number } | null, e: { clientX: number; clientY: number }, project: () => Vec): Vec {
  if (prev && client && Math.abs(client.x - e.clientX) < 0.5 && Math.abs(client.y - e.clientY) < 0.5) return prev;
  return project();
}

/**
 * A left press shorter than this is a click (pass); longer is a loft being charged. Research
 * (feedback/research-mouse-and-pace.md section 1): a press under about 220-250 ms is a normal
 * click; slow clicks and trackpad taps run longer, so 300 ms leaves a margin and a test
 * clicks for 60 to 260 ms and always gets a ground pass.
 */
export const CLICK_MS = 300;
/** Touch screens and pens: taps are slower still. */
export const TOUCH_CLICK_MS = 360;
/** How long past the click threshold it takes to charge a loft to full (full at about 900 ms; research: 700-900 ms). */
export const LOFT_RAMP_MS = 600;
/** A click aims where the button went down unless the pointer moved further than this before release (research: ignore drift up to about 8 px). */
export const AIM_DRIFT_PX = 8;
/** On-screen pointer travel in one tick that counts as really moving it. */
export const MOVE_PX = 2;
/** A press without the ball this soon after your own kick is the second half of a double click: ignored. */
export const DOUBLE_CLICK_MS = 300;
/** A quick right click is a shot at this power; holding builds it to 1 over SHOT_FULL_MS. */
export const SHOT_MIN = 0.55;
export const SHOT_FULL_MS = 800;

/** Hold time to loft power, 0..1. A hold at the click threshold is the lowest, flattest loft. */
export const loftPower = (heldMs: number, clickMs = CLICK_MS): number => Math.min(1, Math.max(0, (heldMs - clickMs) / LOFT_RAMP_MS));

/** What a left release with the ball does: a ground pass for anything shorter than the click threshold, else a loft with this power. */
export function leftRelease(heldMs: number, pointerType = 'mouse'): { pass: true } | { loft: number } {
  const click = pointerType === 'mouse' ? CLICK_MS : TOUCH_CLICK_MS;
  return heldMs < click ? { pass: true } : { loft: loftPower(heldMs, click) };
}

/**
 * One Euro filter (Casiez et al.): a low-pass whose cutoff rises with speed, so a still
 * pointer is calm and a fast one has no lag. Research: beta 0 first, lower min_cutoff until
 * calm, then raise beta until fast moves feel lag-free. Pure, for tests.
 */
export class OneEuro {
  private x: Vec | null = null;
  private dx: Vec = { x: 0, y: 0 };
  constructor(
    private minCutoff = 4,
    private beta = 0.15,
    private dCutoff = 1,
  ) {}
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset(): void {
    this.x = null;
    this.dx = { x: 0, y: 0 };
  }
  filter(v: Vec, dt: number): Vec {
    if (!this.x) {
      this.x = { ...v };
      return { ...v };
    }
    const raw = { x: (v.x - this.x.x) / dt, y: (v.y - this.x.y) / dt };
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx = { x: this.dx.x + ad * (raw.x - this.dx.x), y: this.dx.y + ad * (raw.y - this.dx.y) };
    const a = OneEuro.alpha(this.minCutoff + this.beta * Math.hypot(this.dx.x, this.dx.y), dt);
    this.x = { x: this.x.x + a * (v.x - this.x.x), y: this.x.y + a * (v.y - this.x.y) };
    return { ...this.x };
  }
}
/** Hold time to shot power: SHOT_MIN for a click, 1 after SHOT_FULL_MS. */
export const shotPower = (heldMs: number): number => SHOT_MIN + (1 - SHOT_MIN) * Math.min(1, Math.max(0, heldMs / SHOT_FULL_MS));

/** The kick being charged right now, for the renderer's aim feedback. */
export interface Armed {
  kind: 'loft' | 'shot' | null;
  /** The power the kick would go with if released now: loft hold 0..1, or shot power SHOT_MIN..1. */
  power: number;
  /** A shot or a lofted ball by the taker over a free kick or a corner: it goes to `at` (where the button went down), bent by `curl` (curlFrom). */
  at?: Vec;
  curl?: number;
}

/** World metres the pointer is dragged sideways, while the button is held, for full curl on a set-piece shot. */
export const CURL_DRAG_M = 4;
/** A drag shorter than this (m) is a wobble, not curl. */
const CURL_DEAD_M = 0.4;

/**
 * The bend on a set-piece shot from the ball at `ball` to the point the button went down (`at`), with the pointer
 * now at `cursor`: how far it has been dragged across the line of the shot, -1..1. Dragged to the kicker's left it
 * bends left (positive, HumanInput.curl), to his right it bends right.
 */
export function curlFrom(ball: Vec, at: Vec, cursor: Vec): number {
  const dx = at.x - ball.x;
  const dy = at.y - ball.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return 0;
  const across = ((cursor.x - at.x) * -dy + (cursor.y - at.y) * dx) / l;
  if (Math.abs(across) < CURL_DEAD_M) return 0;
  return Math.max(-1, Math.min(1, (across - Math.sign(across) * CURL_DEAD_M) / (CURL_DRAG_M - CURL_DEAD_M)));
}

/** The ball's spot while `team`'s steered man is over a free kick, a corner or a goal kick he takes (InputController.setPiece), else null. */
export function setPieceSpot(s: MatchState, team: 0 | 1): Vec | null {
  const r = s.restart;
  return r && (r.kind === 'freekick' || r.kind === 'corner' || r.kind === 'goalkick') && r.team === team && r.stage !== 'whistle' && s.controlled[team] === r.taker ? r.spot : null;
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
  private curl = 0;
  private loft: number | null = null;
  /** Left button (or the Pass button) down with the ball: when, or null. */
  private leftStart: number | null = null;
  /** When our last mouse kick was released (performance.now), for DOUBLE_CLICK_MS. */
  private lastKickAt = -Infinity;
  /** Where that press was (world and client pixels) and with what, for aim-at-press and the click threshold. */
  private press: { world: Vec | null; x: number; y: number; type: string } | null = null;
  /** The aim of the kick or select being sent this tick. */
  private aim: Vec | null = null;
  /** On-screen pointer travel since the last tick, CSS pixels. */
  private travel = 0;
  private smooth = new OneEuro();
  /** Right button, Shoot button or F down with the ball. */
  private shotStart: number | null = null;
  /** C down with the ball: a loft with no tap-to-pass (unlike the left button). */
  private loftKeyStart: number | null = null;
  private touchTap: { t: number; x: number; y: number; id: number } | null = null;
  private cleanup: (() => void)[] = [];
  /**
   * Last pointer position, client pixels. The world point under it (`cursor`) is taken when the
   * pointer moves and then kept: a still mouse stays on the same grass while the 3D camera pans.
   * (Re-projecting it every tick made the target run ahead of a player chasing it, as the camera
   * followed him: with the mouse still he never arrived, and could dribble out of play.)
   */
  private client: { x: number; y: number } | null = null;
  /** Touch pointers down on the pitch. Only the first one steers; two at once is a pinch (renderer.ts), which doesn't. */
  private touches = new Set<number>();
  private steerTouch: number | null = null;
  private rect: () => { left: number; top: number } = () => ({ left: 0, top: 0 });
  private cutSeen = -1;

  constructor(
    canvas: HTMLCanvasElement,
    private picker: WorldPicker,
    private hasBall: () => boolean,
    private onPause: () => void,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      // A mouse press where the pointer already is keeps the latched point; anything else projects anew.
      const project = () => picker.toWorld(e.clientX - r.left, e.clientY - r.top);
      const w = e.pointerType === 'mouse' ? latchedPoint(this.cursor, this.client, e, project) : project();
      this.client = { x: e.clientX, y: e.clientY };
      return w;
    };
    this.rect = () => canvas.getBoundingClientRect();

    on(canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
    // A touch that isn't the steering finger, or any touch while two are down (a pinch), moves nothing.
    const steers = (e: PointerEvent) => e.pointerType === 'mouse' || (e.pointerId === this.steerTouch && this.touches.size < 2);
    on(canvas, 'pointermove', (e) => {
      if (!steers(e)) return;
      this.mode = 'mouse';
      if (this.client) this.travel += Math.hypot(e.clientX - this.client.x, e.clientY - this.client.y);
      this.cursor = toWorld(e);
    });
    on(canvas, 'pointerdown', (e) => {
      if (e.pointerType !== 'mouse') {
        // A primary touch is a fresh gesture: any id left over from a lost pointerup is stale.
        if (e.isPrimary) {
          this.touches.clear();
          this.steerTouch = null;
        }
        this.touches.add(e.pointerId);
        if (this.touches.size === 1) this.steerTouch = e.pointerId;
        if (!steers(e)) {
          this.touchTap = null; // a second finger: a pinch, not a tap
          return;
        }
      }
      this.cursor = toWorld(e);
      if (e.pointerType !== 'mouse') {
        // Touching the pitch hands you to the pointer scheme, even if the keys were chosen.
        this.mode = 'mouse';
        // Touch steers by dragging; a quick tap with no ball picks a player (checked on release).
        this.touchTap = { t: performance.now(), x: e.clientX, y: e.clientY, id: e.pointerId };
        this.travel += MOVE_PX;
        return;
      }
      this.mode = 'mouse';
      this.press = { world: this.cursor, x: e.clientX, y: e.clientY, type: e.pointerType };
      // A press on a player's body (not only his feet) picks him: a team-mate for a pass or a switch,
      // an opponent for a tackle. Only the press: the steering cursor stays on the grass.
      const who = e.button === 0 ? 'mates' : e.button === 2 && !this.hasBall() ? 'opponents' : null;
      const r = canvas.getBoundingClientRect();
      const body = who ? picker.pickPlayer?.(e.clientX - r.left, e.clientY - r.top, who) : null;
      if (body) this.press.world = body;
      if (e.button === 0) this.pressLeft();
      if (e.button === 2) this.pressRight();
    });
    const touchUp = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (e.pointerId === this.steerTouch) this.steerTouch = null;
    };
    on(window, 'pointercancel', (e) => {
      if (e.pointerType !== 'mouse') touchUp(e);
    });
    on(window, 'pointerup', (e) => {
      if (e.pointerType !== 'mouse') {
        const steering = e.pointerId === this.steerTouch && this.touches.size < 2;
        touchUp(e);
        if (!steering) return;
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
      // A focused control (the pause menu, the HUD) takes the keys it uses: Space presses a button
      // rather than passing, but WASD still moves. Nothing is queued for the game while it is paused.
      if (this.paused() || controlKeepsKey(e.target, canvas, e.key)) return;
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
        this.aim = this.cursor;
      }
    });
    const forgetTouches = () => {
      this.touches.clear();
      this.steerTouch = null;
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', forgetTouches);
      this.cleanup.push(() => document.removeEventListener('visibilitychange', forgetTouches));
    }
    on(window, 'blur', () => {
      forgetTouches();
      this.keys.clear();
      this.leftStart = this.shotStart = this.loftKeyStart = null;
    });
  }

  private pressLeft(): void {
    if (this.hasBall()) this.leftStart = performance.now();
    else if (performance.now() - this.lastKickAt < DOUBLE_CLICK_MS) return;
    else {
      this.select = true;
      this.aim = this.press?.world ?? this.cursor;
    }
  }

  private pressRight(): void {
    if (this.hasBall()) this.shotStart = performance.now();
    else if (performance.now() - this.lastKickAt < DOUBLE_CLICK_MS) return;
    else {
      this.tackle = true;
      this.aim = this.press?.world ?? this.cursor;
    }
  }

  /** The point a kick released now goes to: where the button went down, unless the pointer has wandered since. */
  private releaseAim(): Vec | null {
    const p = this.press;
    if (p?.world && this.client && Math.hypot(this.client.x - p.x, this.client.y - p.y) <= AIM_DRIFT_PX) return p.world;
    return this.cursor;
  }

  /** Left button up: a quick click is a pass, a hold is a loft. */
  private releaseLeft(): void {
    if (this.leftStart === null) return;
    const held = performance.now() - this.leftStart;
    this.leftStart = null;
    this.lastKickAt = performance.now();
    const r = leftRelease(held, this.press?.type ?? 'mouse');
    if ('pass' in r) {
      this.pass = true;
      this.aim = this.releaseAim();
    } else {
      this.loft = r.loft;
      const bend = this.setPieceBend();
      this.aim = bend ? bend.at : this.cursor;
      this.curl = bend ? bend.curl : 0;
    }
  }

  private releaseShot(): void {
    if (this.shotStart === null) return;
    this.shoot = shotPower(performance.now() - this.shotStart);
    this.shotStart = null;
    this.lastKickAt = performance.now();
    const bend = this.setPieceBend();
    this.aim = bend ? bend.at : this.cursor;
    this.curl = bend ? bend.curl : 0;
  }

  /**
   * Over a free kick or a corner with the mouse, a shot or a lofted ball goes where the button went down and a drag
   * across its line while held bends it (curlFrom). Anywhere else it goes where the button comes up, as it always has.
   */
  private setPieceBend(): { at: Vec; curl: number } | null {
    const ball = this.setPiece();
    const at = this.press?.type === 'mouse' ? this.press.world : null;
    if (!ball || !at || !this.cursor || this.mode !== 'mouse') return null;
    return { at, curl: curlFrom(ball, at, this.cursor) };
  }

  /** The ball's spot while the human's man is over a free kick or a corner (set by the match view), else null. */
  setPiece: () => Vec | null = () => null;

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
    passBtn.addEventListener('pointerdown', down(() => {
      this.press = { world: null, x: 0, y: 0, type: 'touch' };
      this.pressLeft();
    }));
    passBtn.addEventListener('pointerup', end(() => this.releaseLeft()));
    passBtn.addEventListener('pointercancel', end(() => this.releaseLeft()));
    shootBtn.addEventListener('pointerdown', down(() => this.pressRight()));
    shootBtn.addEventListener('pointerup', end(() => this.releaseShot()));
    shootBtn.addEventListener('pointercancel', end(() => this.releaseShot()));
  }

  /** The kick being charged, for the renderer: a loft (left held past a click, or C) or a shot (right, Shoot or F). */
  armed(): Armed {
    const now = performance.now();
    if (this.shotStart !== null) {
      const bend = this.setPieceBend();
      return bend ? { kind: 'shot', power: shotPower(now - this.shotStart), at: bend.at, curl: bend.curl } : { kind: 'shot', power: shotPower(now - this.shotStart) };
    }
    if (this.loftKeyStart !== null) return { kind: 'loft', power: loftPower(now - this.loftKeyStart) };
    if (this.leftStart !== null && now - this.leftStart >= this.clickMs()) {
      const power = loftPower(now - this.leftStart, this.clickMs());
      const bend = this.setPieceBend();
      return bend ? { kind: 'loft', power, at: bend.at, curl: bend.curl } : { kind: 'loft', power };
    }
    return { kind: null, power: 0 };
  }

  /** 0..1 charge progress for a bar: how far the shot or loft in `armed()` is from full. 0 when nothing is charging. */
  charge(): number {
    const now = performance.now();
    if (this.shotStart !== null) return Math.min(1, Math.max(0.04, (now - this.shotStart) / SHOT_FULL_MS));
    if (this.loftKeyStart !== null) return Math.min(1, Math.max(0.04, loftPower(now - this.loftKeyStart)));
    if (this.leftStart !== null && now - this.leftStart >= this.clickMs()) return Math.min(1, Math.max(0.04, loftPower(now - this.leftStart, this.clickMs())));
    return 0;
  }

  private clickMs(): number {
    return (this.press?.type ?? 'mouse') === 'mouse' ? CLICK_MS : TOUCH_CLICK_MS;
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

  /** The match is paused (set by the match view): game keys are ignored, not queued for later. */
  paused: () => boolean = () => false;

  /**
   * Forget every queued kick, tackle, switch and charge, and any held key: called on pause, on resume
   * and around an instant replay, so nothing pressed then fires when play goes on.
   */
  reset(): void {
    this.pass = this.tackle = this.select = this.switchReq = false;
    this.loft = this.shoot = null;
    this.leftStart = this.shotStart = this.loftKeyStart = null;
    this.press = null;
    this.aim = null;
    this.keys.clear();
  }

  /** A one-shot action is waiting for the next tick (take() consumes it): the match loop runs that tick now. */
  waiting(): boolean {
    return this.pass || this.tackle || this.select || this.switchReq || this.loft !== null || this.shoot !== null;
  }

  /** Called once per sim tick. One-shot actions are consumed here. */
  take(): HumanInput {
    const input: HumanInput = {};
    // The view was cut or re-framed: take the still pointer's point again, from where it now lies.
    const cuts = this.picker.cuts?.() ?? 0;
    if (cuts !== this.cutSeen) {
      this.cutSeen = cuts;
      if (this.client && this.mode === 'mouse') {
        const r = this.rect();
        this.cursor = this.picker.toWorld(this.client.x - r.left, this.client.y - r.top);
      }
    }
    const pointer = this.mode === 'mouse' && this.cursor;
    if (pointer) {
      input.cursor = this.smooth.filter(this.cursor!, 1 / 60);
      if (this.travel >= MOVE_PX) input.moved = true;
    } else {
      this.smooth.reset();
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
    if ((this.shoot !== null || this.loft !== null) && this.curl) input.curl = Math.round(this.curl * 100) / 100;
    if (this.tackle) input.tackle = true;
    if (this.select && pointer) input.select = true;
    if (this.keys.has('shift')) input.sprint = true;
    if (this.switchReq) input.switchPlayer = true;
    if (pointer && this.aim && (input.pass || input.loft !== undefined || input.shoot !== undefined || input.select || input.tackle)) input.aim = this.aim;
    this.pass = this.tackle = this.select = this.switchReq = false;
    this.loft = this.shoot = null;
    this.curl = 0;
    this.aim = null;
    this.travel = 0;
    // Lose the ball mid-charge and the charge is dropped.
    if (!this.hasBall()) this.leftStart = this.shotStart = this.loftKeyStart = null;
    return input;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
  }
}
