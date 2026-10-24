// Match cameras. Broadcast: elevated, from the long side, wide enough to see
// passing options (about 50 m of pitch across at the default zoom), following
// the ball through a dead zone so a slow dribble does not slide the pitch
// under a still pointer. End: from behind the goal you attack. A long view
// (goal kicks, the human's keeper holding the ball) pulls up and out to show
// most of the pitch. Goal celebrations use a lower, closer framing, and
// instant replays have their own shots (low side, behind the goal).
// Everything is spring-smoothed with capped speed; no shake, no roll, and the
// yaw never changes within a mode, so nothing spins.

import { BIG_PITCH, HALF_H, HALF_W, clamp01, lerp } from './space.ts';
import { PerspectiveCamera, Plane, Raycaster, Vector3, type Vector2 } from './three.ts';

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
  /**
   * Elevated long view (goal kicks, own-half free kicks, the keeper's ball): these scene points must
   * all be in shot, the ball among them (fitLong).
   */
  long?: { points: { x: number; z: number }[] } | null;
  /** An instant-replay shot: 'low' from the side near pitch level, 'goal' from behind the goal at scene x = goalX. */
  replay?: { kind: 'low' | 'goal'; goalX: number } | null;
}

/**
 * Broadcast framing at zoom 1: metres across the frame at the camera's target. Research brief §5
 * ("frame at least 60 m along the play axis") and the owner's "too zoomed in" ask. With the ball
 * below the frame centre this is about 48 m across at the ball on a desktop window (it was 19 m),
 * more toward the far touchline; zoom takes it from about 29 m to 69 m.
 */
export const BROADCAST_WIDTH = 56;
/** Camera tilt for the broadcast view, degrees down. Higher than before (27) so a wider frame keeps the far side readable. */
export const BROADCAST_ELEV = 33;
/** Zoom limits (a multiplier on the framing width) and the step per wheel notch or +/- key. */
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.45;
export const ZOOM_STEP = 1.12;
/** The end camera's long view is at least this wide. */
export const LONG_MIN = 70;
/** Long view tilt, degrees down: steeper than the broadcast view, so a wide frame keeps its depth. */
export const LONG_ELEV = 46;

/** A fairly wide lens for visible perspective: the far side recedes, the near side looms. */
const VFOV = 40;

/** The long view keeps every point it must show at least this far inside the frame (NDC, 0.88 = 12% in). */
export const LONG_MARGIN = 0.88;

const fitCam = new PerspectiveCamera(VFOV, 1, 0.5, 2000);
const fitV = new Vector3();
const fitRay = new Raycaster();
const fitGround = new Plane(new Vector3(0, 1, 0), 0);

/** Place a camera the way MatchCamera.update does for the broadcast view. */
function placeBroadcast(cam: PerspectiveCamera, x: number, z: number, width: number, elevDeg: number, aspect: number): void {
  cam.aspect = aspect;
  cam.fov = VFOV;
  const vfov = (VFOV * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = width / 2 / Math.tan(hfov / 2);
  const e = (elevDeg * Math.PI) / 180;
  cam.position.set(x, Math.sin(e) * dist, z + Math.cos(e) * dist);
  cam.lookAt(x, 0, z);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/**
 * The smallest broadcast frame, at this tilt and aspect, that shows every point at least
 * LONG_MARGIN inside its edges. Returns the camera's target and width. Points are scene x/z on the
 * ground. Used for the long view: the ball, the taker and his teammates up to past halfway.
 */
export function fitLong(points: { x: number; z: number }[], aspect: number, elevDeg = LONG_ELEV, margin = LONG_MARGIN): { x: number; z: number; width: number } {
  let x = points.reduce((a, p) => a + p.x, 0) / points.length;
  let z = points.reduce((a, p) => a + p.z, 0) / points.length;
  let width = 40;
  for (let k = 0; k < 60; k++) {
    // Re-centre on the points' projected box a few times, then check they fit.
    let box = { x0: 0, x1: 0, y0: 0, y1: 0 };
    for (let it = 0; it < 4; it++) {
      placeBroadcast(fitCam, x, z, width, elevDeg, aspect);
      box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const p of points) {
        fitV.set(p.x, 0, p.z).project(fitCam);
        box.x0 = Math.min(box.x0, fitV.x);
        box.x1 = Math.max(box.x1, fitV.x);
        box.y0 = Math.min(box.y0, fitV.y);
        box.y1 = Math.max(box.y1, fitV.y);
      }
      // Move the target by the ground offset between the screen centre and the box centre.
      fitRay.setFromCamera({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } as Vector2, fitCam);
      if (!fitRay.ray.intersectPlane(fitGround, fitV)) break;
      x = fitV.x;
      z = fitV.z;
    }
    if (box.x0 >= -margin && box.x1 <= margin && box.y0 >= -margin && box.y1 <= margin) break;
    width *= 1.04;
  }
  return { x, z, width };
}

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) : 1);

/**
 * Dead zone: the camera's anchor only moves when the focus leaves a box this fraction of the frame
 * width around it (half-extents along and across). Inside it the camera holds still, so a still
 * pointer stays on the same patch of grass (research brief §2 on stale pointers).
 */
const DEAD_X = 0.09;
const DEAD_Z = 0.05;

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
  private anchorX = 0;
  private anchorZ = 0;
  /** Replay shots: where the camera sits and looks, smoothed. */
  private eye = new Vector3();
  private look = new Vector3();
  readonly target = new Vector3();
  /** The player's zoom: a multiplier on the framing width (ZOOM_MIN..ZOOM_MAX). */
  zoom = 1;
  /** Tooling only: frame this point instead of following play. */
  override: { x: number; z: number; width: number; elev: number } | null = null;

  snap(): void {
    this.snapped = false;
    this.replayKind = null;
  }

  update(dt: number, f: CameraFocus, aspect: number, cssWidth: number, reduced: boolean): void {
    const cam = this.camera;
    cam.aspect = aspect;
    // Phones: a little closer in, and a little closer again in a portrait (taller than wide) view,
    // which shows more depth instead: about 45 m across at the ball at zoom 1 on a 390 px portrait
    // phone (pinch or the on-screen buttons zoom in for bigger players).
    const narrow = (cssWidth < 560 ? 0.93 : 1) * (aspect < 1 ? 0.93 : 1);
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
      // Elevated, from the long side, like Power Soccer, but wide: BROADCAST_WIDTH across at zoom 1,
      // the far boards and stand across the top of the frame. Long balls (in the air, or hit hard)
      // widen it a little more.
      const base = (BIG_PITCH ? BROADCAST_WIDTH : 26) * narrow * this.zoom;
      const air = clamp01((f.air - 0.8) / 3);
      const long = clamp01((Math.hypot(f.vx, f.vz) - 16) / 10);
      const kick = f.phase === 'kickoff' ? 0.1 : 0;
      width = base * (1 + (reduced ? 0.5 : 1) * (0.14 * Math.max(air, long * 0.7) + kick));
      // Taller-than-wide screens (phones upright) look more steeply down, so the extra height shows
      // pitch rather than sky and stand: 33° at 1:1 and wider, about 45° at 3:5.
      elev = this.cinematic ? 20 : BROADCAST_ELEV + Math.max(0, Math.min(14, (1 - aspect) * 30));
      if (this.cinematic) width *= 0.85;
      // Dead zone: follow the focus only once it leaves a box round the anchor.
      const fx = f.x + this.leadX.x;
      const fz = f.z + this.leadZ.x;
      const dzx = width * DEAD_X;
      const dzz = width * DEAD_Z;
      if (!this.snapped) {
        this.anchorX = fx;
        this.anchorZ = fz;
      }
      this.anchorX = Math.max(fx - dzx, Math.min(fx + dzx, this.anchorX));
      this.anchorZ = Math.max(fz - dzz, Math.min(fz + dzz, this.anchorZ));
      tx = this.anchorX;
      // Biased toward the far side so the far stand stays in the top of the frame; near the near
      // touchline the target follows far enough that the ball stays in the bottom of the frame.
      // A wider frame needs less bias: the far side is already in shot.
      const bias = width * 0.16;
      tz = this.anchorZ * 0.8 - bias + 0.35 * Math.max(0, this.anchorZ);
      // Keep the goal near the edge of frame at most, and the far touchline in the top fifth or so.
      const edge = Math.max(0, HALF_W - width * 0.3);
      tx = Math.max(-edge, Math.min(edge, tx));
      tz = Math.max(-HALF_H + 4, Math.min(HALF_H - 6, tz));
    } else {
      const d = f.humanDir;
      width = (BIG_PITCH ? 34 : 26) * narrow * this.zoom * (1 + 0.15 * clamp01((f.air - 1) / 3));
      // Steeper and with less look-ahead than before (30°, 9 m): the man on the ball sits about two
      // thirds of the way down the frame, with room behind him for a back pass.
      elev = 37;
      tx = f.x + d * 4 + this.leadX.x * 0.4;
      tz = f.z * 0.9 + this.leadZ.x * 0.5;
      tx = Math.max(-HALF_W + 4, Math.min(HALF_W - 4, tx));
      tz = Math.max(-HALF_H + 3, Math.min(HALF_H - 3, tz));
    }
    const lv = f.long;
    if (lv && !close && lv.points.length) {
      // Long view: up and out, framed so the ball, the taker and his teammates up to past halfway
      // are all in shot (fitLong), whatever the spot. The end camera keeps its own framing, wider.
      if (this.mode === 'broadcast') {
        elev = LONG_ELEV;
        const fit = this.longFit(lv.points, aspect);
        width = fit.width;
        tx = fit.x;
        tz = fit.z;
      } else {
        elev = 40;
        width = Math.max(width, LONG_MIN);
        tx = lv.points[0].x + f.humanDir * 12;
        tz = lv.points[0].z * 0.6;
      }
      this.anchorX = f.x;
      this.anchorZ = f.z;
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

    this.replayKind = null;
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
      // The long view eases out in about a second (research brief §5), quicker than other zooms.
      this.width.step(width, (close ? 1.1 : lv ? 0.5 : 0.9) * slow, dt, lv ? 70 : 30);
      this.elev.step(elev, (lv ? 0.6 : 1.1) * slow, dt, 30);
    }

    if (f.replay) {
      this.replayShot(dt, f, f.replay, slow);
      return;
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
    cam.fov = VFOV;
    cam.near = Math.max(0.5, dist * 0.05);
    cam.far = 2400;
    cam.lookAt(this.target.x, lerp(0, 0.6, 0), this.target.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /**
   * Instant-replay shots. 'low': the long side near pitch level, close on the ball. 'goal': behind
   * the goal at scene x = goalX, a little above the bar, looking out at the ball.
   */
  private replayShot(dt: number, f: CameraFocus, r: { kind: 'low' | 'goal'; goalX: number }, slow: number): void {
    const cam = this.camera;
    const ex = r.kind === 'goal' ? r.goalX + Math.sign(r.goalX || 1) * 9 : f.x - f.vx * 0.15;
    const ey = r.kind === 'goal' ? 5.5 : 7;
    const ez = r.kind === 'goal' ? f.z * 0.35 : Math.min(HALF_H + 14, f.z + 24);
    const lx = f.x;
    const ly = Math.min(2, f.air * 0.5) + 0.6;
    const lz = f.z;
    if (this.replayKind !== r.kind) {
      // A cut: the first frame of a shot (or a change of angle) jumps straight to it.
      this.replayKind = r.kind;
      this.eye.set(ex, ey, ez);
      this.look.set(lx, ly, lz);
    } else {
      const k = 1 - Math.exp((-dt * 5) / slow);
      const kl = 1 - Math.exp((-dt * 9) / slow);
      this.eye.x += (ex - this.eye.x) * k;
      this.eye.y += (ey - this.eye.y) * k;
      this.eye.z += (ez - this.eye.z) * k;
      this.look.x += (lx - this.look.x) * kl;
      this.look.y += (ly - this.look.y) * kl;
      this.look.z += (lz - this.look.z) * kl;
    }
    this.target.set(this.look.x, 0, this.look.z);
    cam.fov = r.kind === 'goal' ? 46 : 34;
    cam.position.copy(this.eye);
    cam.near = 0.5;
    cam.far = 2400;
    cam.lookAt(this.look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // The next broadcast frame starts from scratch rather than springing from the replay's framing.
    this.snapped = false;
  }

  private fitKey = '';
  private fit = { x: 0, z: 0, width: 60 };

  /** fitLong, cached while the points and the aspect stay the same (a set piece being lined up). */
  private longFit(points: { x: number; z: number }[], aspect: number): { x: number; z: number; width: number } {
    const key = `${aspect.toFixed(3)}|${points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(';')}`;
    if (key !== this.fitKey) {
      this.fitKey = key;
      this.fit = fitLong(points, aspect);
    }
    return this.fit;
  }

  /** The replay shot on screen last frame, or null: a different one (or none) is a cut. */
  private replayKind: 'low' | 'goal' | null = null;

  /** Keyboard direction in screen terms (x right, y down) to world terms, for this camera. */
  screenDir(d: { x: number; y: number }, humanDir: 1 | -1): { x: number; y: number } {
    if (this.mode === 'broadcast') return d;
    // Looking along +x·humanDir: screen right is +y·humanDir, screen up is +x·humanDir.
    return { x: -d.y * humanDir, y: d.x * humanDir };
  }
}
