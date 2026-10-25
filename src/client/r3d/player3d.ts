// Procedural low-poly footballer: a small bone hierarchy of Object3Ds with
// primitive meshes hung on it, animated in code.
//
// The contract the renderer relies on is `Player3D` (an object to add to the
// scene, `update(dt, simPlayer, events, ctx)` once a frame, `dispose()`), so a
// rigged glTF character driven by an AnimationMixer could replace
// `createProceduralPlayer` later without touching the renderer: map the
// AnimEvents below to clips and the locomotion speed to a blend tree.
//
// Local space: +z is forward, +y up, +x the player's left. Feet at y = 0.

import type { MatchPlayer } from '../../sim/types.ts';
import { angleDelta, clamp01, damp, smooth, sx, sz } from './space.ts';
import { merge, type Part } from './geo.ts';
import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Skeleton,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from './three.ts';

// ---------------------------------------------------------------------------
// Public types

/** The subset of a sim player the model reads. A referee can supply the same shape. */
export type SimBody = Pick<MatchPlayer, 'pos' | 'vel' | 'facing'> & Partial<Pick<MatchPlayer, 'sprinting' | 'stun' | 'winded' | 'role'>>;

export type KickStyle = 'pass' | 'chip' | 'shot' | 'throw';

/** One-shot animation triggers, detected by the renderer from sim state changes. */
export type AnimEvent =
  | { kind: 'kick'; style: KickStyle; t0: number; dir: { x: number; y: number }; power: number }
  | { kind: 'tackle'; t0: number; failed: boolean; slide: boolean }
  | { kind: 'knockdown'; t0: number }
  | { kind: 'header'; t0: number }
  | { kind: 'dive'; t0: number; side: -1 | 1; height: number; reach: number }
  | { kind: 'catch'; t0: number; height: number }
  | { kind: 'celebrate'; t0: number; style: number }
  | { kind: 'cheer'; t0: number }
  | { kind: 'dejected'; t0: number }
  | { kind: 'card'; t0: number; color: 'yellow' | 'red' };

export interface PlayerContext {
  /** Animation clock in seconds. Follows sim time: it stops when the match or replay is paused. */
  time: number;
  /** How far the clock moved since the last update (sim seconds, 0 when paused). */
  dtSim: number;
  /** Seconds to extrapolate the sim position by its velocity, for smooth motion between ticks. */
  lead: number;
  /** 0..1: keeper crouched and set, ball threatening. */
  keeperSet: number;
  /** Holding the ball overhead for a throw-in. */
  throwHold: boolean;
  /** Keeper holding the ball in their hands. */
  holding: boolean;
  /** Dribbling: the ball is at this player's feet. */
  hasBall: boolean;
  /** Standing in a defensive wall at a free kick. */
  wall: boolean;
  reducedMotion: boolean;
}

export interface PlayerLook {
  shirt: string;
  shorts: string;
  socks: string;
  /** Number, collar and cuffs. */
  trim: string;
  skin: string;
  hair: string;
  /** 0 short, 1 buzz, 2 long, 3 shaved, 4 curly/big. */
  hairStyle: number;
  /** Boot upper (dark or neutral), sole, and the coloured flash on the side. */
  boots: string;
  bootSole: string;
  bootAccent: string;
  gloves: string | null;
  /** Long sleeves (keepers). */
  longSleeves: boolean;
  number: number | null;
  /** 0.94..1.06 overall scale. */
  height: number;
  /** -1..1: slight build variation (shoulder width, limb thickness). */
  build: number;
}

export interface Player3D {
  readonly object: Object3D;
  update(dt: number, p: SimBody, events: readonly AnimEvent[], ctx: PlayerContext): void;
  /** Midpoint of the hands in world space (for a held ball). Valid after update(). */
  handsWorld(target: Vector3): Vector3;
  /** Top of the head in world space, for overhead markers. Valid after update(). */
  headTop(target: Vector3): Vector3;
  /** True while a one-shot animation is playing. */
  busy(): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Shared resources: geometries and materials are cached and shared by every
// player built from the same PlayerKit, and disposed with it.

export class PlayerKit {
  private geos = new Map<string, BufferGeometry>();
  private mats = new Map<string, Material>();
  private textures: CanvasTexture[] = [];

  geo(key: string, make: () => BufferGeometry): BufferGeometry {
    let g = this.geos.get(key);
    if (!g) {
      g = make();
      this.geos.set(key, g);
    }
    return g;
  }

  mat(color: string, opts: { rough?: number; key?: string } = {}): Material {
    const key = `${color}|${opts.rough ?? 0.78}|${opts.key ?? ''}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color, roughness: opts.rough ?? 0.78, metalness: 0 });
      this.mats.set(key, m);
    }
    return m;
  }

  /** The one material every player's skinned mesh shares: colours live in the vertices. */
  skinnedMat(): Material {
    let m = this.mats.get('skinned');
    if (!m) {
      m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 } as Record<string, unknown>);
      this.mats.set('skinned', m);
    }
    return m;
  }

  /** Shirt number for the back: transparent texture, outlined digits. */
  numberMat(num: number, color: string, outline: string): Material {
    const key = `num|${num}|${color}|${outline}`;
    let m = this.mats.get(key);
    if (!m) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d')!;
      g.font = `800 ${num >= 10 ? 92 : 108}px 'Big Shoulders Display', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 10;
      g.strokeStyle = outline;
      g.strokeText(String(num), 64, 70);
      g.fillStyle = color;
      g.fillText(String(num), 64, 70);
      const tex = new CanvasTexture(c);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      this.textures.push(tex);
      m = new MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.mats.set(key, m);
    }
    return m;
  }

  dispose(): void {
    for (const g of this.geos.values()) g.dispose();
    for (const m of this.mats.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geos.clear();
    this.mats.clear();
    this.textures = [];
  }
}

// ---------------------------------------------------------------------------
// Pose: Euler angles per bone plus a body offset, blended as plain numbers.

const B = { pelvis: 0, spine: 1, neck: 2, head: 3, shL: 4, elL: 5, shR: 6, elR: 7, hipL: 8, knL: 9, anL: 10, hipR: 11, knR: 12, anR: 13 } as const;
type BoneName = keyof typeof B;
const NB = 14;
const BODY = NB * 3; // px, py, pz, rx, ry, rz
const POSE_LEN = BODY + 6;
const MIRROR_PAIRS: [number, number][] = [
  [B.shL, B.shR],
  [B.elL, B.elR],
  [B.hipL, B.hipR],
  [B.knL, B.knR],
  [B.anL, B.anR],
];

class Pose {
  a = new Float32Array(POSE_LEN);
  reset(): this {
    this.a.fill(0);
    return this;
  }
  set(b: BoneName, x: number, y = 0, z = 0): this {
    const i = B[b] * 3;
    this.a[i] = x;
    this.a[i + 1] = y;
    this.a[i + 2] = z;
    return this;
  }
  add(b: BoneName, x: number, y = 0, z = 0): this {
    const i = B[b] * 3;
    this.a[i] += x;
    this.a[i + 1] += y;
    this.a[i + 2] += z;
    return this;
  }
  body(px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0): this {
    const a = this.a;
    a[BODY] = px;
    a[BODY + 1] = py;
    a[BODY + 2] = pz;
    a[BODY + 3] = rx;
    a[BODY + 4] = ry;
    a[BODY + 5] = rz;
    return this;
  }
  copy(o: Pose): this {
    this.a.set(o.a);
    return this;
  }
  /** this = lerp(this, o, w) */
  blend(o: Pose, w: number): this {
    if (w <= 0) return this;
    const a = this.a;
    const b = o.a;
    if (w >= 1) {
      a.set(b);
      return this;
    }
    for (let i = 0; i < POSE_LEN; i++) a[i] += (b[i] - a[i]) * w;
    return this;
  }
  /** Swap left and right: the same move with the other foot. */
  mirror(): this {
    const a = this.a;
    for (const [l, r] of MIRROR_PAIRS) {
      for (let k = 0; k < 3; k++) {
        const t = a[l * 3 + k];
        a[l * 3 + k] = a[r * 3 + k];
        a[r * 3 + k] = t;
      }
    }
    for (let b = 0; b < NB; b++) {
      a[b * 3 + 1] = -a[b * 3 + 1];
      a[b * 3 + 2] = -a[b * 3 + 2];
    }
    a[BODY] = -a[BODY];
    a[BODY + 4] = -a[BODY + 4];
    a[BODY + 5] = -a[BODY + 5];
    return this;
  }
}

// Sign conventions, from the local frame above:
//   legs/arms: rotation.x < 0 swings the limb forward; knee rotation.x > 0 bends it (foot back);
//   elbow rotation.x < 0 bends it (hand forward); spine/head rotation.x > 0 leans forward;
//   left arm rotation.z > 0 lifts it out to the side, right arm rotation.z < 0.
//   body rotation.z > 0 rolls toward the player's right.

interface Action {
  ev: AnimEvent;
  dur: number;
  mirror: boolean;
}

const DUR: Record<AnimEvent['kind'], number> = {
  kick: 0.5,
  tackle: 0.85,
  knockdown: 0.95,
  header: 0.75,
  dive: 1.25,
  catch: 0.6,
  celebrate: 2.6,
  cheer: 2.2,
  dejected: 2.4,
  card: 2.2,
};

const ease = (t: number) => t * t * (3 - 2 * t);
/** 0 → 1 → 0 bump over [a, b]. */
const bump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI));
/** Piecewise-linear keyframes: [time, value] pairs, sorted. */
function keys(t: number, k: number[]): number {
  if (t <= k[0]) return k[1];
  for (let i = 2; i < k.length; i += 2) {
    if (t <= k[i]) {
      const u = (t - k[i - 2]) / (k[i] - k[i - 2]);
      return k[i - 1] + (k[i + 1] - k[i - 1]) * ease(u);
    }
  }
  return k[k.length - 1];
}

// ---------------------------------------------------------------------------
// Builder

export function createProceduralPlayer(kit: PlayerKit, look: PlayerLook): Player3D {
  // One skinned mesh per player: every primitive is baked into a single
  // geometry with vertex colours and rigidly bound to its bone, so a player is
  // one draw call (two with the shirt number) and all players share one material.
  const root = new Group();
  root.name = 'player';
  const h = look.height;
  root.scale.setScalar(h);
  const bw = 1 + look.build * 0.06;

  const joint = (parent: Object3D, x: number, y: number, z = 0): Bone => {
    const j = new Bone();
    j.position.set(x, y, z);
    parent.add(j);
    return j;
  };
  const body = new Bone();
  const pelvis = joint(body, 0, 0.95, 0);
  const spine = joint(pelvis, 0, 0.06, 0);
  const neck = joint(spine, 0, 0.465, 0.005);
  const head = joint(neck, 0, 0.075, 0.01);
  const shL = joint(spine, 0.235 * bw, 0.4, -0.01);
  const elL = joint(shL, 0, -0.29, 0);
  const shR = joint(spine, -0.235 * bw, 0.4, -0.01);
  const elR = joint(shR, 0, -0.29, 0);
  const hipL = joint(pelvis, 0.1 * bw, -0.02, 0);
  const knL = joint(hipL, 0, -0.45, 0);
  const anL = joint(knL, 0, -0.41, 0);
  const hipR = joint(pelvis, -0.1 * bw, -0.02, 0);
  const knR = joint(hipR, 0, -0.45, 0);
  const anR = joint(knR, 0, -0.41, 0);
  const bones: Bone[] = [pelvis, spine, neck, head, shL, elL, shR, elR, hipL, knL, anL, hipR, knR, anR];
  const all = [...bones, body];
  body.updateMatrixWorld(true);

  const parts: Part[] = [];
  const col = new Color();
  const tmpM = new Matrix4();
  const tmpE = new Euler();
  const tmpQ = new Quaternion();
  /** A primitive on a bone: local offset/scale/tilt, baked into bind pose. */
  const part = (bone: Bone, g: BufferGeometry, color: string, x = 0, y = 0, z = 0, scale: [number, number, number] = [1, 1, 1], rx = 0) => {
    tmpQ.setFromEuler(tmpE.set(rx, 0, 0));
    tmpM.compose(new Vector3(x, y, z), tmpQ, new Vector3(...scale));
    g.applyMatrix4(tmpM);
    g.applyMatrix4(bone.matrixWorld);
    col.set(color);
    parts.push({ geo: g, tags: { aBone: all.indexOf(bone) }, color: [col.r, col.g, col.b] });
  };
  const cyl = (rt: number, rb: number, len: number, seg = 8) => new CylinderGeometry(rt, rb, len, seg, 1).translate(0, -len / 2, 0);

  // Shorts, torso, collar.
  part(pelvis, new CylinderGeometry(0.17 * bw, 0.185 * bw, 0.21, 10).translate(0, -0.1, 0), look.shorts, 0, 0.1, 0, [1, 1, 0.74]);
  part(spine, new CylinderGeometry(0.228, 0.168, 0.47, 12, 2).translate(0, 0.235, 0), look.shirt, 0, 0, 0, [bw, 1, 0.62]);
  part(spine, cyl(0.082, 0.094, 0.035, 10), look.trim, 0, 0.475, 0.005, [1, 1, 0.85]);
  // Neck, head, nose, hair.
  part(neck, cyl(0.056, 0.064, 0.09), look.skin, 0, 0.08, 0);
  part(head, new SphereGeometry(0.112, 14, 10).translate(0, 0.105, 0), look.skin, 0, 0, 0, [0.93, 1.08, 1.02]);
  part(head, new BoxGeometry(0.028, 0.04, 0.03), look.skin, 0, 0.09, 0.112);
  if (look.hairStyle !== 3) {
    const big = look.hairStyle === 4;
    const r = look.hairStyle === 1 ? 0.116 : big ? 0.14 : 0.122;
    part(head, new SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, look.hairStyle === 1 ? 1.1 : 1.35).translate(0, 0.105, 0), look.hair, 0, 0.02, -0.012, [0.98, big ? 1.05 : 1, 1.06], -0.32);
    if (look.hairStyle === 2) part(head, new BoxGeometry(0.2, 0.15, 0.06), look.hair, 0, 0.07, -0.085);
  }
  // Arms.
  for (const [sh, el] of [
    [shL, elL],
    [shR, elR],
  ] as const) {
    part(sh, new SphereGeometry(0.08, 10, 8), look.shirt, 0, -0.01, 0);
    part(sh, cyl(0.076, 0.066, look.longSleeves ? 0.29 : 0.16, 10), look.shirt);
    if (!look.longSleeves) part(sh, cyl(0.058, 0.044, 0.29, 10), look.skin);
    // Forearm tapering to the wrist, then a flat hand with a thumb (a padded glove for keepers).
    part(el, cyl(0.05, 0.033, 0.25, 10), look.longSleeves ? look.shirt : look.skin);
    const g = !!look.gloves;
    const handC = look.gloves ?? look.skin;
    part(el, new BoxGeometry(g ? 0.08 : 0.062, g ? 0.11 : 0.085, g ? 0.042 : 0.03).translate(0, -0.045, 0), handC, 0, -0.25, 0.004);
    part(el, new BoxGeometry(0.022, g ? 0.055 : 0.045, 0.024).translate(0, -0.022, 0), handC, 0, -0.26, g ? 0.03 : 0.024, [1, 1, 1], -0.45);
  }
  // Legs.
  for (const [hip, kn, an] of [
    [hipL, knL, anL],
    [hipR, knR, anR],
  ] as const) {
    // Thigh tapering to the knee; the calf swells under the sock and narrows to the ankle.
    part(hip, cyl(0.102 * bw, 0.064, 0.45, 10), look.skin);
    part(hip, cyl(0.116 * bw, 0.106 * bw, 0.22, 10), look.shorts, 0, 0.03, 0);
    part(kn, cyl(0.064, 0.06, 0.08, 10), look.skin, 0, 0.02, 0);
    part(kn, cyl(0.066, 0.075, 0.12, 10), look.socks, 0, -0.04, -0.006);
    part(kn, cyl(0.075, 0.042, 0.26, 10), look.socks, 0, -0.16, -0.006);
    // Boot: sole, heel and upper, a rounded toe, and a coloured flash along the side.
    part(an, new BoxGeometry(0.094, 0.022, 0.27).translate(0, -0.064, 0.052), look.bootSole);
    part(an, new BoxGeometry(0.088, 0.07, 0.15).translate(0, -0.022, -0.012), look.boots);
    part(an, new SphereGeometry(0.05, 10, 6).translate(0, 0, 0), look.boots, 0, -0.04, 0.1, [0.9, 0.62, 1.55]);
    part(an, new BoxGeometry(0.092, 0.016, 0.13).translate(0, -0.03, 0.035), look.bootAccent);
  }

  const geo = merge(parts, ['aBone'], true);
  const boneAttr = geo.attributes.aBone;
  const n = boneAttr.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = boneAttr.getX(i);
    sw[i * 4] = 1;
  }
  geo.deleteAttribute('aBone');
  geo.setAttribute('skinIndex', new BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(sw, 4));
  const mesh = new SkinnedMesh(geo, kit.skinnedMat());
  mesh.castShadow = true;
  // A fixed sphere round the player, big enough for a full-length dive, so a player off-screen is
  // culled: no draw call, no skeleton update and no bone-texture upload that frame. (The sphere a
  // skinned mesh would compute itself is from one pose, and costly to compute.)
  mesh.boundingSphere = new Sphere(new Vector3(0, 0.9, 0), 2.4);
  mesh.add(body);
  mesh.bind(new Skeleton(all));
  root.add(mesh);

  if (look.number !== null) {
    const outline = look.trim === '#111111' ? '#f5f5f5' : '#111111';
    const num = new Mesh(kit.geo('numplane', () => new PlaneGeometry(0.2, 0.2)), kit.numberMat(look.number, look.trim, outline));
    num.position.set(0, 0.27, -0.128);
    num.rotation.set(-0.08, Math.PI, 0);
    spine.add(num);
  }
  // Hand markers, for a held ball.
  const L = { hand: new Object3D() };
  const R = { hand: new Object3D() };
  L.hand.position.set(0, -0.29, 0.03);
  R.hand.position.set(0, -0.29, 0.03);
  elL.add(L.hand);
  elR.add(R.hand);

  const rest = bones.map((b) => b.position.clone());

  // -------------------------------------------------------------------------
  // Animation state

  const loco = new Pose();
  const act = new Pose();
  const out = new Pose();
  const from = new Pose();
  const keep = new Pose();
  const lastOut = new Pose();
  let fromW = 0;
  let action: Action | null = null;
  let phase = Math.random() * Math.PI * 2;
  let yaw: number | null = null;
  let speedS = 0;
  let sideS = 0;
  let fwdS = 0;
  let keeperW = 0;
  let windedW = 0;
  let throwW = 0;
  let holdW = 0;
  let dribbleW = 0;
  let wallW = 0;
  const idleSeed = Math.random() * 10;
  let last = 0;

  function start(ev: AnimEvent, p: SimBody) {
    let mirror = false;
    if (ev.kind === 'kick' && ev.style !== 'throw') {
      // Kick with the foot on the side the ball goes from: a ball played to the left is struck with the right.
      const fx = p.facing.x;
      const fy = p.facing.y;
      const side = fx * ev.dir.y - fy * ev.dir.x; // > 0: target to the player's right (sim y is down)
      mirror = side > 0.25 ? true : side < -0.25 ? false : Math.random() < 0.3;
    } else if (ev.kind === 'tackle' || ev.kind === 'knockdown') mirror = Math.random() < 0.5;
    else if (ev.kind === 'dive') mirror = ev.side < 0;
    else if (ev.kind === 'celebrate') mirror = Math.random() < 0.4;
    from.copy(out);
    fromW = 1;
    const dur = ev.kind === 'tackle' ? (ev.slide ? DUR.tackle + (ev.failed ? 0.35 : 0) : 0.45) : DUR[ev.kind];
    action = { ev, dur, mirror };
  }

  function locomotion(P: Pose, time: number, dtSim: number, reduced: boolean) {
    const speed = speedS;
    const gait = smooth(0.25, 3.6, speed);
    const sprint = smooth(5.2, 7.6, speed);
    // Stride length grows with speed, so cadence rises more slowly than speed.
    const stride = 1.25 + 0.32 * speed;
    const back = fwdS < -0.6 && speed > 0.8 ? -1 : 1;
    phase += ((speed * dtSim) / stride) * Math.PI * 2 * back;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const sR = -s;
    const cR = -c;
    const amp = (0.28 + 0.36 * gait + 0.32 * sprint) * gait;
    const kAmp = (0.55 + 0.75 * sprint) * gait;
    P.reset();
    // Legs: thigh swing, knee folds during the forward swing, foot plants.
    P.set('hipL', -s * amp, 0, 0.02);
    P.set('hipR', -sR * amp, 0, -0.02);
    P.set('knL', 0.08 + kAmp * Math.max(0, c) ** 1.4 + 0.15 * gait * Math.max(0, -s));
    P.set('knR', 0.08 + kAmp * Math.max(0, cR) ** 1.4 + 0.15 * gait * Math.max(0, -sR));
    P.set('anL', -0.15 * gait * Math.max(0, s) + 0.25 * gait * Math.max(0, -s) * Math.max(0, c));
    P.set('anR', -0.15 * gait * Math.max(0, sR) + 0.25 * gait * Math.max(0, -sR) * Math.max(0, cR));
    // Arms swing against the legs, elbows bent more as you speed up.
    const armAmp = (0.2 + 0.45 * gait + 0.4 * sprint) * Math.max(0.15, gait);
    P.set('shL', s * armAmp, 0, 0.09 + 0.05 * gait);
    P.set('shR', sR * armAmp, 0, -0.09 - 0.05 * gait);
    P.set('elL', -(0.25 + 0.95 * gait + 0.25 * sprint) - Math.max(0, -s) * 0.25 * gait);
    P.set('elR', -(0.25 + 0.95 * gait + 0.25 * sprint) - Math.max(0, -sR) * 0.25 * gait);
    // Trunk: lean into the run, counter-rotate the shoulders, bob twice a cycle.
    const lean = 0.04 + 0.12 * gait + 0.16 * sprint;
    P.set('spine', lean * back, -s * 0.14 * gait, -sideS * 0.12);
    P.set('pelvis', 0, s * 0.1 * gait, 0);
    P.set('head', -lean * 0.6 * back, s * 0.06 * gait, 0);
    const bob = gait * (0.055 * Math.abs(s) - 0.035) - 0.01 * sprint;
    // Sidestep: shuffle with a little roll instead of a forward stride.
    const side = clamp01(Math.abs(sideS) / Math.max(0.5, speed)) * gait;
    if (side > 0.05) {
      P.add('hipL', 0, 0, Math.max(0, s) * 0.3 * side * Math.sign(sideS));
      P.add('hipR', 0, 0, Math.max(0, -s) * 0.3 * side * Math.sign(sideS));
    }
    // Idle: breathing and a slow weight shift, bouncing on the toes at kickoff-ready.
    const idle = 1 - gait;
    if (idle > 0 && !reduced) {
      const t = time + idleSeed;
      P.add('spine', 0.02 * Math.sin(t * 1.9) * idle, 0.05 * Math.sin(t * 0.37) * idle, 0.03 * Math.sin(t * 0.53) * idle);
      P.add('head', 0, 0.25 * Math.sin(t * 0.29 + 1) * idle, 0);
      P.add('hipL', -0.05 * idle, 0, 0.06 * idle);
      P.add('hipR', 0.04 * idle, 0, -0.07 * idle);
      P.add('knL', 0.1 * idle);
      P.add('knR', 0.14 * idle);
      P.add('shL', 0.03 * Math.sin(t * 0.8) * idle, 0, 0.06 * idle);
      P.add('shR', -0.03 * Math.sin(t * 0.8) * idle, 0, -0.06 * idle);
    }
    P.body(0, bob - 0.02 * idle, 0);
  }

  // Stances layered over locomotion with their own smoothed weights.
  const stance = new Pose();
  function stances(P: Pose) {
    if (keeperW > 0.01) {
      stance.copy(P);
      stance.set('hipL', -0.55, 0, 0.22).set('hipR', -0.55, 0, -0.22);
      stance.set('knL', 0.95).set('knR', 0.95).set('anL', -0.35).set('anR', -0.35);
      stance.set('spine', 0.42, 0, 0).set('head', -0.3);
      stance.set('shL', -0.5, 0, 0.55).set('shR', -0.5, 0, -0.55).set('elL', -0.7).set('elR', -0.7);
      stance.a[BODY + 1] = -0.16;
      P.blend(stance, keeperW * (1 - smooth(1.5, 4, speedS)));
    }
    if (windedW > 0.01) {
      stance.copy(P);
      stance.set('spine', 0.75, 0, 0).set('head', -0.45);
      stance.set('hipL', -0.45, 0, 0.08).set('hipR', -0.4, 0, -0.08).set('knL', 0.45).set('knR', 0.4);
      stance.set('shL', -0.95, 0, 0.25).set('shR', -0.95, 0, -0.25).set('elL', -0.25).set('elR', -0.25);
      stance.a[BODY + 1] = -0.07;
      P.blend(stance, windedW);
    }
    if (wallW > 0.01) {
      // In the wall: feet together, hands crossed low in front.
      stance.copy(P);
      stance.set('hipL', -0.05, 0, -0.03).set('hipR', -0.05, 0, 0.03).set('knL', 0.12).set('knR', 0.12);
      stance.set('shL', -0.45, 0, -0.32).set('shR', -0.45, 0, 0.32).set('elL', -0.55).set('elR', -0.55);
      stance.set('spine', 0.08).set('head', 0.05);
      P.blend(stance, wallW * (1 - smooth(1, 3, speedS)));
    }
    if (dribbleW > 0.01) {
      P.add('spine', 0.08 * dribbleW, 0, 0);
      P.add('head', 0.25 * dribbleW, 0, 0);
    }
    if (holdW > 0.01) {
      stance.copy(P);
      stance.set('shL', -1.05, 0, -0.2).set('shR', -1.05, 0, 0.2).set('elL', -1.15).set('elR', -1.15);
      stance.add('spine', 0.08, 0, 0);
      P.blend(stance, holdW);
    }
    if (throwW > 0.01) {
      stance.copy(P);
      stance.set('shL', -3.0, 0, -0.18).set('shR', -3.0, 0, 0.18).set('elL', -1.35).set('elR', -1.35);
      stance.set('spine', -0.22, 0, 0).set('head', 0.15);
      stance.set('hipL', -0.25).set('knL', 0.25).set('hipR', 0.2).set('knR', 0.1);
      P.blend(stance, throwW);
    }
  }

  function actionPose(P: Pose, a: Action, t: number) {
    const ev = a.ev;
    const u = t / a.dur;
    P.copy(loco);
    switch (ev.kind) {
      case 'kick': {
        if (ev.style === 'throw') {
          P.set('shL', keys(u, [0, -3.0, 0.3, -2.4, 0.6, -1.4, 1, -1.0]), 0, -0.15);
          P.set('shR', keys(u, [0, -3.0, 0.3, -2.4, 0.6, -1.4, 1, -1.0]), 0, 0.15);
          P.set('elL', keys(u, [0, -1.35, 0.3, -0.3, 1, -0.4]));
          P.set('elR', keys(u, [0, -1.35, 0.3, -0.3, 1, -0.4]));
          P.set('spine', keys(u, [0, -0.25, 0.3, 0.35, 1, 0.1]));
          P.set('hipL', -0.3).set('knL', 0.2).set('hipR', 0.25).set('knR', 0.15);
          break;
        }
        // Kicking leg is the right; mirror() gives the left.
        const big = ev.style === 'shot' ? 1 : ev.style === 'chip' ? 0.8 : 0.45 + 0.35 * ev.power;
        const strike = 0.34;
        const backswing = keys(u, [0, 0, 0.1, 0.25, strike - 0.04, 0.55 + 0.45 * big, strike, 0.1, strike + 0.12, -0.75 - 0.75 * big, 0.72, -0.4 * big, 1, 0]);
        P.set('hipR', backswing, 0, -0.06);
        P.set('knR', keys(u, [0, 0.2, strike - 0.04, 1.2 + 0.6 * big, strike + 0.03, 0.15, 0.7, 0.2, 1, 0.12]));
        P.set('anR', keys(u, [0, 0, strike, 0.45, 1, 0]));
        P.set('hipL', keys(u, [0, -0.1, strike, -0.25, 0.7, -0.05, 1, 0]), 0, 0.05);
        P.set('knL', keys(u, [0, 0.2, strike, 0.45, 1, 0.15]));
        // Arms out for balance; the far arm sweeps across.
        P.set('shL', keys(u, [0, 0, strike, -0.35, 1, 0]), 0, keys(u, [0, 0.2, strike, 0.95 + 0.25 * big, 1, 0.15]));
        P.set('shR', keys(u, [0, 0, strike, 0.45, 1, 0]), 0, keys(u, [0, -0.2, strike, -0.6, 1, -0.15]));
        P.set('elL', -0.4).set('elR', -0.5);
        const lean = ev.style === 'chip' ? -0.22 : ev.style === 'shot' ? 0.1 : 0.15;
        P.set('spine', keys(u, [0, 0.05, strike, lean, 1, 0.06]), keys(u, [0, 0, strike - 0.05, 0.3, strike + 0.1, -0.25, 1, 0]), keys(u, [0, 0, strike, 0.12, 1, 0]));
        P.set('head', keys(u, [0, 0.15, strike, 0.35, 1, 0]));
        // A full shot carries the body through and off the ground a little.
        const hop = ev.style === 'shot' ? 0.07 * bump(u, strike, 0.7) : 0;
        P.body(0, loco.a[BODY + 1] * 0.3 + hop, 0.12 * big * smooth(strike, 0.8, u), 0, 0, 0);
        break;
      }
      case 'tackle': {
        if (!ev.slide) {
          // Standing tackle: plant, lean in and poke a leg at the ball.
          const w = bump(u, 0, 1);
          P.set('hipR', -1.0 * w, 0, -0.15 * w).set('knR', 0.2 * w).set('anR', -0.2 * w);
          P.set('hipL', 0.2 * w, 0, 0.05 * w).set('knL', 0.6 * w);
          P.set('spine', 0.3 * w, 0.25 * w, 0).set('head', 0.15 * w);
          P.set('shL', -0.4 * w, 0, 0.7 * w).set('shR', 0.3 * w, 0, -0.5 * w).set('elL', -0.5).set('elR', -0.5);
          P.body(0, loco.a[BODY + 1] - 0.12 * w, 0.1 * w);
          break;
        }
        // Slide on the hip: lean back, lead leg out straight, trailing leg tucked.
        const down = smooth(0, 0.16, t) * (1 - smooth(a.dur - 0.3, a.dur, t));
        P.set('spine', -0.55 * down, 0.35 * down, 0.25 * down);
        P.set('hipR', -1.45 * down, 0, -0.1 * down);
        P.set('knR', 0.08);
        P.set('anR', -0.3 * down);
        P.set('hipL', -0.7 * down, 0, 0.25 * down);
        P.set('knL', 1.65 * down);
        P.set('shL', -0.4 * down, 0, 1.0 * down).set('elL', -0.5 * down);
        P.set('shR', 0.5 * down, 0, -0.55 * down).set('elR', -0.6 * down);
        P.set('head', 0.4 * down);
        P.body(0.05 * down, -0.62 * down, 0.15 * down, -0.62 * down, 0.4 * down, -0.12 * down);
        break;
      }
      case 'knockdown': {
        // Clipped: legs go, land on the backside, roll up.
        const fall = smooth(0, 0.22, t) * (1 - smooth(a.dur - 0.38, a.dur, t));
        P.set('spine', -0.3 * fall + 0.25 * bump(t, 0.25, 0.6), 0, 0.2 * fall);
        P.set('hipL', -1.2 * fall, 0, 0.15 * fall).set('knL', 0.9 * fall);
        P.set('hipR', -0.9 * fall, 0, -0.1 * fall).set('knR', 1.4 * fall);
        P.set('shL', -0.2 * fall, 0, 0.9 * fall).set('elL', -0.4 * fall);
        P.set('shR', 0.9 * fall, 0, -0.5 * fall).set('elR', -0.5 * fall);
        P.set('head', 0.35 * fall);
        P.body(0.05 * fall, -0.72 * fall, -0.1 * fall, -0.42 * fall, 0, 0.12 * fall);
        break;
      }
      case 'header': {
        const air = bump(u, 0.12, 0.8);
        P.set('hipL', -0.5 * air, 0, 0.1).set('hipR', -0.15 * air).set('knL', 1.2 * air).set('knR', 0.7 * air);
        P.set('anL', 0.4 * air).set('anR', 0.4 * air);
        P.set('shL', -0.5 * air, 0, 1.0 * air).set('shR', -0.5 * air, 0, -1.0 * air).set('elL', -1.0 * air).set('elR', -1.0 * air);
        const nod = keys(u, [0, 0, 0.35, -0.45, 0.5, 0.55, 0.75, 0, 1, 0]);
        P.set('spine', keys(u, [0, 0.1, 0.35, -0.25, 0.5, 0.3, 1, 0.05])).set('head', nod);
        P.body(0, 0.48 * air - 0.12 * bump(u, 0, 0.14) - 0.08 * bump(u, 0.8, 1), 0);
        break;
      }
      case 'dive': {
        // Load, launch sideways with the arms over the head, land, get up.
        // Built as a dive to the player's right; mirror() for the left.
        const reach = Math.min(1.6, Math.max(0.6, ev.reach));
        const launch = smooth(0.08, 0.36, t);
        const up = 1 - smooth(a.dur - 0.4, a.dur, t);
        const fly = launch * up;
        const height = Math.min(1.6, ev.height);
        const loft = bump(t, 0.1, 0.6) * (0.25 + height * 0.45);
        P.set('spine', 0.1 * fly, 0, 0.25 * fly);
        P.set('shL', -0.3 * fly, 0, 2.7 * fly).set('elL', -0.2 * fly);
        P.set('shR', -0.3 * fly, 0, -2.5 * fly).set('elR', -0.15 * fly);
        P.set('hipL', -0.2 * fly, 0, 0.5 * fly).set('knL', 0.4 * fly);
        P.set('hipR', 0.1 * fly, 0, -0.15 * fly).set('knR', 0.2 * fly);
        P.set('head', 0, 0, -0.2 * fly);
        const crouch = bump(t, 0, 0.16) * 0.15;
        P.body(-reach * fly, loft - crouch - 0.5 * fly * smooth(0.45, 0.6, t) * (1 - loft), 0, 0, 0, 1.35 * fly);
        break;
      }
      case 'catch': {
        const w = smooth(0, 0.12, t) * (1 - smooth(a.dur - 0.2, a.dur, t));
        const low = ev.height < 0.5;
        P.set('shL', (low ? -0.6 : -1.3) * w, 0, -0.15 * w).set('shR', (low ? -0.6 : -1.3) * w, 0, 0.15 * w);
        P.set('elL', -1.2 * w).set('elR', -1.2 * w);
        P.set('spine', (low ? 0.6 : 0.25) * w).set('head', 0.2 * w);
        if (low) P.set('hipL', -0.5 * w).set('hipR', -0.5 * w).set('knL', 0.8 * w).set('knR', 0.8 * w);
        P.body(0, (low ? -0.2 : 0) * w, 0);
        break;
      }
      case 'celebrate': {
        const w = smooth(0, 0.2, t) * (1 - smooth(a.dur - 0.4, a.dur, t));
        const st = ev.style % 3;
        if (st === 0) {
          // One arm punched high, a couple of jumps.
          const pump = Math.sin(t * 9) * 0.15;
          P.set('shL', -2.95 * w + pump * w, 0, 0.15 * w).set('elL', -0.15 * w);
          P.set('shR', -0.6 * w, 0, -0.5 * w).set('elR', -1.4 * w);
          P.set('spine', -0.15 * w, 0.15 * w, -0.08 * w).set('head', -0.35 * w);
          const hop = Math.max(0, Math.sin(t * 6)) * 0.2 * w * (t < 1.4 ? 1 : 0);
          P.add('knL', 0.3 * hop * 3).add('knR', 0.3 * hop * 3);
          P.body(0, loco.a[BODY + 1] + hop, 0);
        } else if (st === 1) {
          // Aeroplane: arms out, banking.
          const bank = Math.sin(t * 2.6) * 0.3;
          P.set('shL', 0, 0, 1.5 * w).set('shR', 0, 0, -1.5 * w).set('elL', -0.1).set('elR', -0.1);
          P.set('spine', 0.1 * w, 0, bank * w).set('head', -0.2 * w);
          P.body(0, loco.a[BODY + 1], 0, 0, 0, bank * 0.5 * w);
        } else {
          // Knee slide, both arms up.
          const k = smooth(0.1, 0.45, t) * (1 - smooth(a.dur - 0.5, a.dur, t));
          P.set('hipL', 0.15 * k).set('hipR', 0.15 * k).set('knL', 1.9 * k).set('knR', 1.9 * k).set('anL', 0.6 * k).set('anR', 0.6 * k);
          P.set('shL', -2.6 * w, 0, 0.45 * w).set('shR', -2.6 * w, 0, -0.45 * w).set('elL', -0.2).set('elR', -0.2);
          P.set('spine', -0.45 * k).set('head', -0.5 * k);
          P.body(0, -0.5 * k, 0.15 * k, 0, 0, 0);
        }
        break;
      }
      case 'cheer': {
        const w = smooth(0, 0.3, t) * (1 - smooth(a.dur - 0.4, a.dur, t));
        const clap = Math.abs(Math.sin(t * 7));
        P.set('shL', -2.5 * w, 0, (0.25 + 0.25 * clap) * w).set('shR', -2.5 * w, 0, -(0.25 + 0.25 * clap) * w);
        P.set('elL', -0.5 * w).set('elR', -0.5 * w);
        P.set('head', -0.3 * w);
        break;
      }
      case 'dejected': {
        const w = smooth(0, 0.4, t) * (1 - smooth(a.dur - 0.5, a.dur, t));
        P.set('shL', -2.45 * w, 0, 0.85 * w).set('shR', -2.45 * w, 0, -0.85 * w);
        P.set('elL', -2.1 * w).set('elR', -2.1 * w);
        P.set('spine', 0.15 * w).set('head', 0.4 * w);
        break;
      }
      case 'card': {
        const w = smooth(0, 0.25, t) * (1 - smooth(a.dur - 0.35, a.dur, t));
        P.set('shR', -3.05 * w, 0, 0.05 * w).set('elR', -0.05 * w);
        P.set('shL', 0.1 * w, 0, 0.15 * w);
        P.set('spine', -0.08 * w).set('head', -0.15 * w);
        break;
      }
    }
    if (a.mirror) P.mirror();
  }

  function envelope(a: Action, t: number): number {
    const k = a.ev.kind;
    const fin = k === 'kick' ? 0.06 : 0.1;
    const fout = k === 'kick' ? 0.16 : 0.12;
    return smooth(0, fin, t) * (1 - smooth(a.dur - fout, a.dur, t));
  }

  const tmp = new Vector3();
  const tmp2 = new Vector3();

  return {
    object: root,

    update(dt, p, events, ctx) {
      for (const ev of events) start(ev, p);
      const reduced = ctx.reducedMotion;

      // Root: position (extrapolated between ticks) and heading.
      const lead = ctx.lead;
      root.position.set(sx(p.pos.x + p.vel.x * lead), 0, sz(p.pos.y + p.vel.y * lead));
      const target = Math.atan2(p.facing.x, p.facing.y);
      if (yaw === null) yaw = target;
      // Turn quickly, but never snap: max ~11 rad/s.
      const d = angleDelta(yaw, target);
      const maxTurn = 11 * dt;
      yaw += Math.abs(d) < maxTurn ? d : Math.sign(d) * maxTurn;
      yaw = damp(yaw, yaw + angleDelta(yaw, target), 14, dt);
      root.rotation.y = yaw;

      // Velocity in the player's frame, smoothed so the gait never jumps.
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const vx = p.vel.x;
      const vz = p.vel.y;
      const speed = Math.sqrt(vx * vx + vz * vz);
      const fwd = vx * fx + vz * fz;
      const side = vx * fz - vz * fx;
      const k = ctx.dtSim > 0 ? 12 : 0;
      speedS = damp(speedS, speed, k, dt);
      fwdS = damp(fwdS, fwd, k, dt);
      sideS = damp(sideS, side, k, dt);

      keeperW = damp(keeperW, ctx.keeperSet, 6, dt);
      windedW = damp(windedW, p.winded && speed < 1.2 && !ctx.hasBall ? 1 : 0, 3, dt);
      throwW = damp(throwW, ctx.throwHold ? 1 : 0, 8, dt);
      holdW = damp(holdW, ctx.holding ? 1 : 0, 10, dt);
      dribbleW = damp(dribbleW, ctx.hasBall ? 1 : 0, 6, dt);
      wallW = damp(wallW, ctx.wall ? 1 : 0, 5, dt);

      locomotion(loco, ctx.time, ctx.dtSim, reduced);
      stances(loco);
      out.copy(loco);

      if (action) {
        const t = ctx.time - action.ev.t0;
        // Get up early if the sim already has them running again.
        const recover = (action.ev.kind === 'knockdown' || action.ev.kind === 'tackle') && t > 0.35 && speed > 3.5;
        if (t >= action.dur || t < -0.2 || recover) {
          if (recover) {
            from.copy(lastOut);
            fromW = 1;
          }
          action = null;
        } else {
          actionPose(act, action, Math.max(0, t));
          out.blend(act, envelope(action, Math.max(0, t)));
        }
      }
      // Cross-fade out of whatever pose we were in when the last action began or ended.
      if (fromW > 0) {
        fromW = Math.max(0, fromW - dt / 0.12);
        keep.copy(out);
        out.copy(from).blend(keep, 1 - fromW);
      }
      lastOut.copy(out);

      // Apply.
      const a = out.a;
      for (let i = 0; i < NB; i++) {
        const b = bones[i];
        b.rotation.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
        b.position.copy(rest[i]);
      }
      body.position.set(a[BODY], a[BODY + 1], a[BODY + 2]);
      body.rotation.set(a[BODY + 3], a[BODY + 4], a[BODY + 5]);
      last = ctx.time;
    },

    handsWorld(target) {
      L.hand.getWorldPosition(tmp);
      R.hand.getWorldPosition(tmp2);
      return target.copy(tmp).add(tmp2).multiplyScalar(0.5);
    },

    headTop(target) {
      head.getWorldPosition(target);
      target.y += 0.25 * h;
      return target;
    },

    busy() {
      return action !== null && last - action.ev.t0 < action.dur;
    },

    dispose() {
      root.removeFromParent();
      geo.dispose();
      mesh.skeleton.dispose();
      // Materials belong to the PlayerKit.
    },
  };
}


// ---------------------------------------------------------------------------
// Looks

const SKINS = ['#f3d2b5', '#e8b98f', '#d9a479', '#c08657', '#a06a42', '#80522f', '#674026'];
const HAIRS = ['#16110d', '#2b1c12', '#4a2f1b', '#73492a', '#a5733f', '#d7b56d', '#e8d9a8', '#3a3a3a', '#8a2d16'];

/** A kit-colour pick that reads against both shirts: the keeper's kit. */
export function keeperColors(own: string, other: string): { shirt: string; shorts: string; socks: string; trim: string } {
  const options = [
    { shirt: '#f4dc1c', shorts: '#1b1b1b', socks: '#f4dc1c', trim: '#1b1b1b' },
    { shirt: '#24b35a', shorts: '#0f3d22', socks: '#24b35a', trim: '#f5f5f5' },
    { shirt: '#ff7a1a', shorts: '#2a2a2a', socks: '#ff7a1a', trim: '#1b1b1b' },
    { shirt: '#7c3fe0', shorts: '#2a1a4a', socks: '#7c3fe0', trim: '#f5f5f5' },
    { shirt: '#2e2e2e', shorts: '#2e2e2e', socks: '#2e2e2e', trim: '#f4dc1c' },
    { shirt: '#1fc7c7', shorts: '#0d3a3a', socks: '#1fc7c7', trim: '#111111' },
  ];
  let best = options[0];
  let bestD = -1;
  for (const o of options) {
    const d = Math.min(colorDist(o.shirt, own), colorDist(o.shirt, other));
    if (d > bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export function colorDist(a: string, b: string): number {
  const p = (h: string) => {
    const s = h.replace('#', '');
    const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) || 0);
  };
  const x = p(a);
  const y = p(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Varied but stable looks per player id. */
export function lookFor(id: string, kit: { shirt: string; shorts: string; socks: string; trim: string }, number: number | null, keeper: boolean, rand: (salt: number) => number): PlayerLook {
  const skinI = Math.floor(rand(1) * SKINS.length);
  const dark = skinI >= 4;
  const hairPool = dark ? [0, 1, 7] : [0, 1, 2, 3, 4, 5, 6, 8];
  const hair = HAIRS[hairPool[Math.floor(rand(2) * hairPool.length)]];
  const style = Math.floor(rand(3) * 5);
  const bootPick = ['#141414', '#141414', '#1e2a3a', '#2b2b2b', '#f2f2f2'][Math.floor(rand(4) * 5)];
  const accent = ['#ff5a1f', '#2563eb', '#d4ff3a', '#e11d48', '#ffffff', '#ffd60a', '#22d3ee'][Math.floor(rand(7) * 7)];
  void id;
  return {
    ...kit,
    skin: SKINS[skinI],
    hair,
    hairStyle: style,
    boots: bootPick,
    bootSole: bootPick === '#f2f2f2' ? '#d8d8d8' : '#3a3a3a',
    bootAccent: accent === bootPick ? '#ff5a1f' : accent,
    gloves: keeper ? '#f4f4f4' : null,
    longSleeves: keeper,
    number,
    height: 0.95 + rand(5) * 0.1,
    build: rand(6) * 2 - 1,
  };
}
