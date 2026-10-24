// Match cameras. Broadcast: elevated, from the long side, follows the ball
// with look-ahead and widens a little when the ball is in the air. End: from
// behind the goal you attack. Goal celebrations (and replays) use a lower,
// closer framing. Everything is spring-smoothed with capped speed; no shake,
// no roll, and the yaw never changes within a mode, so nothing spins.

import { BIG_PITCH, HALF_H, HALF_W, clamp01, lerp } from './space.ts';
import { PerspectiveCamera, Vector3 } from './three.ts';

export type CameraMode = 'broadcast' | 'end';

export interface CameraFocus {
  /** Scene x/z of the ball (or what to look at). */
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Ball height, m. */
  air: number;
  /** Who has the ball, -1/0/1 attack direction along x if known. */
  attack: number;
  phase: string;
  /** Low close framing on this point (goal celebration). */
  close: { x: number; z: number } | null;
  /** The human's attack direction, for the end camera. */
  humanDir: 1 | -1;
}

/** Critically damped spring toward a target, Unity-style SmoothDamp. */
class Spring {
  v = 0;
  constructor(public x: number) {}
  step(target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
    const st = Math.max(0.0001, smoothTime);
    const omega = 2 / st;
    const k = omega * dt;
    const exp = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    let change = this.x - target;
    const maxChange = maxSpeed * st;
    change = Math.max(-maxChange, Math.min(maxChange, change));
    const t = this.x - change;
    const temp = (this.v + omega * change) * dt;
    this.v = (this.v - omega * temp) * exp;
    let out = t + (change + temp) * exp;
    if (target - this.x > 0 === out > target) {
      out = target;
      this.v = (out - target) / dt;
    }
    this.x = out;
    return out;
  }
  snap(x: number) {
    this.x = x;
    this.v = 0;
  }
}

const VFOV = 28;

export class MatchCamera {
  readonly camera = new PerspectiveCamera(VFOV, 16 / 10, 0.5, 2000);
  mode: CameraMode = 'broadcast';
  /** Replays: a lower, closer broadcast framing. */
  cinematic = false;
  private tx = new Spring(0);
  private tz = new Spring(0);
  private width = new Spring(30);
  private elev = new Spring(40);
  private leadX = new Spring(0);
  private leadZ = new Spring(0);
  private snapped = false;
  readonly target = new Vector3();
  /** Tooling only: frame this point instead of following play. */
  override: { x: number; z: number; width: number; elev: number } | null = null;

  snap(): void {
    this.snapped = false;
  }

  update(dt: number, f: CameraFocus, aspect: number, cssWidth: number, reduced: boolean): void {
    const cam = this.camera;
    cam.aspect = aspect;
    const narrow = cssWidth < 560 ? 0.86 : 1;
    const slow = reduced ? 1.6 : 1;

    // Where to look: the ball plus where it's heading (or where the carrier's team attacks).
    const lead = 0.5;
    let lx = Math.max(-7, Math.min(7, f.vx * lead)) + f.attack * 2.5;
    let lz = Math.max(-5, Math.min(5, f.vz * lead));
    if (reduced) {
      lx *= 0.6;
      lz *= 0.6;
    }
    let width: number;
    let elev: number;
    let tx: number;
    let tz: number;
    const close = f.close && !reduced;
    if (this.mode === 'broadcast') {
      const base = (BIG_PITCH ? 36 : 30) * narrow;
      const air = clamp01((f.air - 1) / 3);
      const kick = f.phase === 'kickoff' ? 0.12 : 0;
      width = base * (1 + (reduced ? 0.5 : 1) * (0.18 * air + kick));
      elev = this.cinematic ? 24 : 37;
      if (this.cinematic) width *= 0.82;
      tx = f.x + this.leadX.x;
      tz = f.z * 0.8 + this.leadZ.x - 2.5;
      const edge = HALF_W - width * 0.32;
      tx = Math.max(-edge, Math.min(edge, tx));
      tz = Math.max(-HALF_H + 2, Math.min(HALF_H - 3, tz));
    } else {
      const d = f.humanDir;
      width = (BIG_PITCH ? 30 : 26) * narrow * (1 + 0.12 * clamp01((f.air - 1) / 3));
      elev = 30;
      tx = f.x + d * 7 + this.leadX.x * 0.5;
      tz = f.z * 0.9 + this.leadZ.x * 0.5;
      tx = Math.max(-HALF_W + 4, Math.min(HALF_W - 4, tx));
      tz = Math.max(-HALF_H + 3, Math.min(HALF_H - 3, tz));
    }
    if (close && f.close) {
      width = 13;
      elev = 15;
      tx = f.close.x;
      tz = f.close.z;
    }
    const o = this.override;
    if (o) {
      width = o.width;
      elev = o.elev;
      tx = o.x;
      tz = o.z;
    }

    if (!this.snapped) {
      this.snapped = true;
      this.leadX.snap(lx);
      this.leadZ.snap(lz);
      this.tx.snap(tx);
      this.tz.snap(tz);
      this.width.snap(width);
      this.elev.snap(elev);
    } else {
      this.leadX.step(lx, 0.9 * slow, dt, 12);
      this.leadZ.step(lz, 0.9 * slow, dt, 12);
      // Pan follows briskly but with a capped speed; zoom and tilt change slowly.
      this.tx.step(tx, 0.42 * slow, dt, 32);
      this.tz.step(tz, 0.6 * slow, dt, 22);
      this.width.step(width, (close ? 1.1 : 0.9) * slow, dt, 30);
      this.elev.step(elev, 1.1 * slow, dt, 30);
    }

    const vfov = (VFOV * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const dist = this.width.x / 2 / Math.tan(hfov / 2);
    const e = (this.elev.x * Math.PI) / 180;
    this.target.set(this.tx.x, 0, this.tz.x);
    if (this.mode === 'broadcast') {
      cam.position.set(this.tx.x, Math.sin(e) * dist, this.tz.x + Math.cos(e) * dist);
    } else {
      const d = f.humanDir;
      cam.position.set(this.tx.x - d * Math.cos(e) * dist, Math.sin(e) * dist, this.tz.x);
    }
    cam.near = Math.max(0.5, dist * 0.05);
    cam.far = 2400;
    cam.lookAt(this.target.x, lerp(0, 0.6, 0), this.target.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Keyboard direction in screen terms (x right, y down) to world terms, for this camera. */
  screenDir(d: { x: number; y: number }, humanDir: 1 | -1): { x: number; y: number } {
    if (this.mode === 'broadcast') return d;
    // Looking along +x·humanDir: screen right is +y·humanDir, screen up is +x·humanDir.
    return { x: -d.y * humanDir, y: d.x * humanDir };
  }
}
