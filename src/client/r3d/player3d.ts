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

import { grassDiff, worstDiff } from '../kits.ts';
import type { MatchPlayer } from '../../sim/types.ts';
import { angleDelta, damp, smooth, sx, sz } from './space.ts';
import { BI, SKEL, buildBody, joints, paintKit } from './body3d.ts';
import { hash01 } from './space.ts';
import { Bone, CanvasTexture, Euler, Group, MeshStandardMaterial, Object3D, Quaternion, Skeleton, SkinnedMesh, Sphere, Vector3, type BufferGeometry, type Material } from './three.ts';

// ---------------------------------------------------------------------------
// Public types

/** The subset of a sim player the model reads. A referee can supply the same shape. */
export type SimBody = Pick<MatchPlayer, 'pos' | 'vel' | 'facing'> & Partial<Pick<MatchPlayer, 'sprinting' | 'stun' | 'winded' | 'role' | 'air' | 'dive'>>;

/** 'roll' is a keeper bowling the ball out along the ground from his hands. */
export type KickStyle = 'pass' | 'chip' | 'shot' | 'throw' | 'roll';

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
  | { kind: 'card'; t0: number; color: 'yellow' | 'red' }
  /** The referee's signal: both arms out in front (advantage), or one arm out for a free kick. */
  | { kind: 'signal'; t0: number; style: 'advantage' | 'point' };

export interface PlayerContext {
  /** Animation clock in seconds. Follows sim time: it stops when the match or replay is paused. */
  time: number;
  /** How far the clock moved since the last update (sim seconds, 0 when paused). */
  dtSim: number;
  /** Seconds to extrapolate the sim position by its velocity, for smooth motion between ticks. */
  lead: number;
  /** 0..1: keeper crouched and set, ball threatening. */
  keeperSet: number;
  /** Where the body faces instead of the sim's facing (a keeper watching the ball: director.ts keeperLook). */
  look?: { x: number; y: number } | null;
  /** Holding the ball overhead for a throw-in. */
  throwHold: boolean;
  /** Keeper holding the ball in their hands. */
  holding: boolean;
  /** Dribbling: the ball is at this player's feet. */
  hasBall: boolean;
  /** Standing in a defensive wall at a free kick. */
  wall: boolean;
  /** The referee's arm held straight up: an indirect free kick until someone else touches it (Law 5). */
  armUp?: boolean;
  /** The ball (sim metres, z its height): heads turn to follow it. */
  ball?: { x: number; y: number; z: number } | null;
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
  /** A dark rim round the silhouette: the kit is too close to the grass to read without one. */
  rim?: boolean;
  number: number | null;
  /** 0.94..1.06 overall scale. */
  height: number;
  /** -1..1: slight build variation (shoulder width, limb thickness). */
  build: number;
  /** Surname across the shoulders of the shirt. */
  name?: string | null;
  /** Tonal pattern of the shirt (body3d.ts paintKit), and a V-neck or a crew collar; from the kit's colours when unset. */
  pattern?: number;
  vneck?: boolean;
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

/** The rim: how dark at the silhouette, and from and to where across the surface (1 = edge-on). */
const RIM_DARK = 0.9;
const RIM_FROM = 0.3;
const RIM_TO = 0.62;
/** Brightness of a surface touching the grass (1 = none), rising to full by 0.24 m up. */
const FOOT_DARK = 0.6;
/** Strength of the sky light along a player's silhouette. */
const SKY_RIM = 0.35;

// ---------------------------------------------------------------------------
// Shared resources: geometries and materials are cached and shared by every
// player built from the same PlayerKit, and disposed with it.

export class PlayerKit {
  private geos = new Map<string, BufferGeometry>();
  private mats = new Map<string, Material>();
  private owned: Material[] = [];
  private textures: CanvasTexture[] = [];
  /** Kit texture size in px (square), and mesh detail: the renderer sets these per quality. */
  texSize = 256;
  detail: 'low' | 'high' = 'high';

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

  /**
   * The players' skinned-mesh material: colours live in the vertices, a player's kit texture (shirt,
   * numbers, face: body3d.ts paintKit) multiplies over them. Without a texture it is shared by every
   * player. With `rim`, darkened toward the silhouette, for a kit too close to the grass (kits.ts
   * grassClash): the dark edge separates the player from the pitch without changing the club's colours.
   * Every variant compiles to one of two shader programs.
   */
  skinnedMat(rim = false, map: CanvasTexture | null = null): Material {
    const key = rim ? 'skinned-rim' : 'skinned';
    if (!map) {
      const m = this.mats.get(key);
      if (m) return m;
    }
    const sm = new MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0, ...(map ? { map } : {}) } as Record<string, unknown>);
    // Contact: boots, socks and anything lying on the grass darken toward it (world height), which
    // roots the player without a shadow-map pixel or a mesh. Shirts sit well above it, so kits are untouched.
    // Sky: a soft cool light along the silhouette, the broadcast look of players lit from all round by
    // the open sky; not on rim kits, whose edge is darkened instead.
    sm.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', 'varying float vFootY;\n#include <common>')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvFootY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', 'varying float vFootY;\n#include <common>').replace(
        '#include <opaque_fragment>',
        `outgoingLight *= mix( ${FOOT_DARK.toFixed(2)}, 1.0, smoothstep( 0.0, 0.24, vFootY ) );
float rimEdge = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
${
  rim
    ? `outgoingLight *= 1.0 - ${RIM_DARK.toFixed(2)} * smoothstep( ${RIM_FROM.toFixed(2)}, ${RIM_TO.toFixed(2)}, rimEdge );
`
    : `outgoingLight += vec3( 0.55, 0.65, 0.8 ) * ${SKY_RIM.toFixed(2)} * pow( rimEdge, 3.0 ) * diffuseColor.rgb;
`
}#include <opaque_fragment>`,
      );
    };
    sm.customProgramCacheKey = () => (rim ? 'player-rim-foot' : 'player-foot-sky');
    if (map) this.owned.push(sm);
    else this.mats.set(key, sm);
    return sm;
  }

  /** A player's kit texture, owned by the kit. null without a DOM. */
  kitTexture(look: PlayerLook): CanvasTexture | null {
    const outline = look.trim === '#111111' ? '#f5f5f5' : '#111111';
    const pick = hash01(`${look.shirt}|${look.trim}|${look.shorts}`, 9);
    const tex = paintKit(
      {
        shirt: look.shirt,
        trim: look.trim,
        numColor: look.trim,
        numOutline: outline,
        number: look.number,
        name: look.name ?? null,
        pattern: look.pattern ?? Math.floor(pick * 6),
        vneck: look.vneck ?? hash01(look.shirt, 3) < 0.5,
        skin: look.skin,
        hair: look.hair,
      },
      this.texSize,
    );
    if (tex) this.textures.push(tex);
    return tex;
  }

  dispose(): void {
    for (const g of this.geos.values()) g.dispose();
    for (const m of this.mats.values()) m.dispose();
    for (const m of this.owned) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geos.clear();
    this.mats.clear();
    this.owned = [];
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
  /** Seconds the clock has been held back (a keeper stretched out on the floor while the sim still has him there). */
  held: number;
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
  signal: 1.6,
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

/**
 * Players are drawn a little larger than life, as arcade football games do: with the camera pulled
 * back to show 45-60 m of pitch (owner's ask 1) a true-size player is a thin 35 px figure at
 * 1280x800, thinner than the Power Soccer references. The sim's sizes and collisions are unchanged.
 */
export const PLAYER_SCALE = 1.12;

export function createProceduralPlayer(kit: PlayerKit, look: PlayerLook): Player3D {
  // One skinned mesh per player: every primitive is baked into a single
  // geometry with vertex colours and rigidly bound to its bone, so a player is
  // one draw call (two with the shirt number) and all players share one material.
  const root = new Group();
  root.name = 'player';
  const h = look.height * PLAYER_SCALE;
  root.scale.setScalar(h);
  const bw = 1 + look.build * 0.06;

  const joint = (parent: Object3D, x: number, y: number, z = 0): Bone => {
    const j = new Bone();
    j.position.set(x, y, z);
    parent.add(j);
    return j;
  };
  // The skeleton (body3d.ts SKEL). The chest is not posed on its own: it takes part of the spine's
  // rotation, so the back bends as a curve rather than at one joint.
  const body = new Bone();
  const pelvis = joint(body, 0, SKEL.pelvisY, 0);
  const spine = joint(pelvis, 0, SKEL.spineUp, 0);
  const chest = joint(spine, 0, SKEL.chestUp, 0);
  const neck = joint(chest, SKEL.neck[0], SKEL.neck[1], SKEL.neck[2]);
  const head = joint(neck, 0, SKEL.headUp, 0);
  const shL = joint(chest, SKEL.shoulder[0] * bw, SKEL.shoulder[1], SKEL.shoulder[2]);
  const elL = joint(shL, 0, -SKEL.upperArm, 0);
  const shR = joint(chest, -SKEL.shoulder[0] * bw, SKEL.shoulder[1], SKEL.shoulder[2]);
  const elR = joint(shR, 0, -SKEL.upperArm, 0);
  const hipL = joint(pelvis, SKEL.hip[0] * bw, SKEL.hip[1], SKEL.hip[2]);
  const knL = joint(hipL, 0, -SKEL.thigh, 0);
  const anL = joint(knL, 0, -SKEL.shin, 0);
  const hipR = joint(pelvis, -SKEL.hip[0] * bw, SKEL.hip[1], SKEL.hip[2]);
  const knR = joint(hipR, 0, -SKEL.thigh, 0);
  const anR = joint(knR, 0, -SKEL.shin, 0);
  const bones: Bone[] = [pelvis, spine, neck, head, shL, elL, shR, elR, hipL, knL, anL, hipR, knR, anR];
  // Skeleton order is body3d.ts BI: the posed bones, then the chest (and the root last).
  const all = [...bones, chest, body];
  void BI;
  body.updateMatrixWorld(true);

  // One skinned mesh per player, one draw call: a continuous body (body3d.ts) whose colours live in
  // the vertices, with the kit texture (shirt, numbers, name, face) over them.
  const tex = kit.kitTexture(look);
  const geo = buildBody(look, kit.detail, !!tex);
  const mesh = new SkinnedMesh(geo, kit.skinnedMat(!!look.rim, tex));
  mesh.castShadow = true;
  // A fixed sphere round the player, big enough for a full-length dive, so a player off-screen is
  // culled: no draw call, no skeleton update and no bone-texture upload that frame. (The sphere a
  // skinned mesh would compute itself is from one pose, and costly to compute.)
  mesh.boundingSphere = new Sphere(new Vector3(0, 0.9, 0), 2.4);
  mesh.add(body);
  mesh.bind(new Skeleton(all));
  root.add(mesh);

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
  /** A reaction held back until the action in progress is over. */
  let later: AnimEvent | null = null;
  /** Gait cycle, 0..1 (two steps): the left foot lands at 0, the right at 0.5. */
  let cyc = Math.random();
  /** Smoothed forward acceleration, m/s². */
  let accS = 0;
  /** Where the head is turned to follow the ball (rad, + to his left), and tipped down to it. */
  let lookYaw = 0;
  let lookPitch = 0;
  let yaw: number | null = null;
  let speedS = 0;
  let sideS = 0;
  /** Smoothed turn rate, rad/s (+ = turning left), for banking into a turn. */
  let turnS = 0;
  let fwdS = 0;
  let keeperW = 0;
  let windedW = 0;
  let throwW = 0;
  let holdW = 0;
  let dribbleW = 0;
  let wallW = 0;
  let armUpW = 0;
  let airW = 0;
  const idleSeed = Math.random() * 10;
  let last = 0;

  function start(ev: AnimEvent, p: SimBody) {
    let mirror = false;
    if (ev.kind === 'kick' && ev.style !== 'throw' && ev.style !== 'roll') {
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
    action = { ev, dur, mirror, held: 0 };
  }

  // Leg geometry for the foot IK (bind pose, local units).
  const LEG = joints(bw);
  const THIGH = SKEL.thigh;
  const SHIN = SKEL.shin;
  const ANKLE_Y = LEG.ankle;
  const REACH = (THIGH + SHIN) * 0.995;
  const footT = new Vector3();
  const ikQ = new Quaternion();
  const ikE = new Euler();

  /**
   * Two-bone IK for one leg: the hip, knee and ankle angles that put the ankle at `target` (body
   * space, local units) with the foot pitched `toe` (rad, + toes down), written into P. The target is
   * taken into the pelvis's frame first, so the pelvis can twist and roll over planted feet. A target
   * out of reach is raised until it is in reach, with the heel (behind) or the toes (in front) lifting
   * to keep the boot on the grass.
   */
  function legIK(P: Pose, left: boolean, tx: number, ty: number, tz: number, toe: number, bodyY: number, pelvisYaw: number, pelvisRoll: number) {
    const hx = (left ? 1 : -1) * LEG.hipX;
    // Ankle target relative to the pelvis joint, in the pelvis's frame.
    footT.set(tx, ty - bodyY - SKEL.pelvisY, tz);
    ikQ.setFromEuler(ikE.set(0, pelvisYaw, pelvisRoll)).invert();
    footT.applyQuaternion(ikQ);
    let dx = footT.x - hx;
    let dy = footT.y - SKEL.hip[1];
    const dz = footT.z;
    let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > REACH) {
      // Raise it into reach: the leg straight, the foot rolled onto its toes or heel.
      const flat2 = dx * dx + dz * dz;
      const ny = -Math.sqrt(Math.max(0.0001, REACH * REACH - flat2));
      const lift = ny - dy;
      dy = ny;
      dist = Math.sqrt(flat2 + dy * dy);
      toe += dz < 0 ? Math.min(0.9, lift / 0.12) : -Math.min(0.5, lift / 0.08);
      if (dist > REACH) {
        const k = REACH / dist;
        dx *= k;
        dy *= k;
        dist = REACH;
      }
    }
    const cosK = (THIGH * THIGH + SHIN * SHIN - dist * dist) / (2 * THIGH * SHIN);
    const knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosK)));
    const cosA = (THIGH * THIGH + dist * dist - SHIN * SHIN) / (2 * THIGH * Math.max(1e-4, dist));
    const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
    const roll = Math.asin(Math.max(-1, Math.min(1, dx / Math.max(1e-4, dist))));
    const pitch = Math.atan2(-dz, -dy) - alpha;
    P.set(left ? 'hipL' : 'hipR', pitch, 0, roll);
    P.set(left ? 'knL' : 'knR', knee);
    P.set(left ? 'anL' : 'anR', toe - pitch - knee);
  }

  function locomotion(P: Pose, time: number, dtSim: number, reduced: boolean) {
    const speed = speedS;
    const gait = smooth(0.25, 3.6, speed);
    const run = smooth(2.2, 4.6, speed);
    const sprint = smooth(5.2, 7.6, speed);
    // Direction of travel in the player's frame (x his left, z forward), and how much of it is sideways or backwards.
    const vl = Math.max(1e-4, speed);
    const mx = speed > 0.05 ? sideS / vl : 0;
    const mz = speed > 0.05 ? fwdS / vl : 1;
    const lat = Math.abs(mx);
    const backw = Math.max(0, -mz);
    // Gait: a cycle is two steps. Stance (foot on the grass) is most of a walk's cycle and a third of a sprint's.
    const beta = 0.62 - 0.24 * run - 0.06 * sprint;
    const vLocal = speed / h;
    let freq = 0.75 + 0.18 * speed;
    // The distance the body covers while a foot is down; past what the legs can reach, step quicker instead.
    const sMax = (0.75 + 0.25 * run) * (1 - 0.55 * lat) * (1 - 0.35 * backw);
    let S = (vLocal * beta) / freq;
    if (S > sMax) {
      freq = (vLocal * beta) / sMax;
      S = sMax;
    }
    cyc = (cyc + freq * dtSim) % 1;
    const crouch = 0.035 * gait + 0.02 * run + 0.035 * sprint;
    const bobA = 0.016 * gait * (1 - run) - 0.028 * run;
    const bodyY = -crouch + bobA * Math.cos(4 * Math.PI * (cyc - beta / 2));
    const twist = (0.06 + 0.1 * run) * gait * (1 - lat);
    const pelvisYaw = -twist * Math.cos(2 * Math.PI * cyc);
    // The swing side's hip drops a little in a walk.
    const pelvisRoll = 0.04 * gait * (1 - run) * Math.sin(2 * Math.PI * cyc);
    P.reset();
    P.set('pelvis', 0, pelvisYaw, pelvisRoll);
    // Feet: planted through stance (moving back under him at exactly his speed, so they never skate),
    // then swung forward, the heel kicking up behind at a run.
    const lift = 0.05 * gait + 0.12 * run + 0.14 * sprint;
    const heel = 0.08 * run + 0.22 * sprint;
    const centre = -0.06 * S * run;
    for (const left of [true, false]) {
      const p = (cyc + (left ? 0 : 0.5)) % 1;
      const width = (left ? 1 : -1) * (LEG.hipX * (1 - 0.35 * run) + 0.05 * lat);
      let along: number;
      let fy = 0;
      let toe = 0;
      if (p < beta) {
        const u = p / beta;
        along = centre + S * (0.5 - u);
        // Heel strike (toes up), flat, then rolling onto the toes at push-off.
        toe = -0.2 * gait * (1 - run) * (1 - smooth(0, 0.18, u)) + 0.45 * gait * smooth(0.55, 1, u);
      } else {
        const u = (p - beta) / (1 - beta);
        const e = u * u * (3 - 2 * u);
        along = centre + S * (-0.5 + e) - heel * 0.9 * Math.sin(Math.PI * Math.min(1, u / 0.7)) * (1 - u);
        fy = lift * Math.sin(Math.PI * u) ** 0.8 + heel * Math.sin(Math.PI * Math.min(1, u / 0.75)) ** 2 * (1 - 0.6 * u);
        toe = 0.5 * gait * (1 - smooth(0, 0.5, u)) - 0.15 * gait * smooth(0.6, 1, u);
      }
      legIK(P, left, width + mx * along, ANKLE_Y + fy, mz * along, toe * (1 - 0.6 * backw), bodyY, pelvisYaw, pelvisRoll);
    }
    // Arms swing against the legs (the left forward as the right leg comes through), elbows bent more at speed.
    const sw = Math.cos(2 * Math.PI * cyc);
    const armAmp = (0.18 + 0.32 * run + 0.4 * sprint) * gait * (1 - 0.6 * lat) * (1 - 0.4 * backw);
    const elb = 0.25 + 0.75 * gait + 0.55 * run + 0.15 * sprint;
    P.set('shL', armAmp * sw, 0, 0.1 + 0.06 * gait);
    P.set('shR', -armAmp * sw, 0, -0.1 - 0.06 * gait);
    P.set('elL', -(elb + 0.35 * gait * Math.max(0, -sw)));
    P.set('elR', -(elb + 0.35 * gait * Math.max(0, sw)));
    // Trunk: lean into the run and into acceleration, back when braking or backpedalling; the shoulders
    // counter the pelvis; the head stays level.
    const lean = (0.04 + 0.1 * run + 0.14 * sprint) * (1 - backw) - 0.1 * backw * gait + Math.max(-0.2, Math.min(0.22, accS * 0.035));
    P.set('spine', lean, -pelvisYaw * 1.6, -sideS * 0.04 - pelvisRoll * 0.8);
    P.set('head', -lean * 0.7, pelvisYaw * 0.5, 0);
    // Idle: breathing and a slow weight shift.
    const idle = 1 - gait;
    if (idle > 0 && !reduced) {
      const t = time + idleSeed;
      P.add('spine', 0.02 * Math.sin(t * 1.9) * idle, 0.05 * Math.sin(t * 0.37) * idle, 0.03 * Math.sin(t * 0.53) * idle);
      P.add('head', 0, 0.2 * Math.sin(t * 0.29 + 1) * idle, 0);
      P.add('shL', 0.03 * Math.sin(t * 0.8) * idle, 0, 0.04 * idle);
      P.add('shR', -0.03 * Math.sin(t * 0.8) * idle, 0, -0.04 * idle);
    }
    // Bank into the turn, about the feet: a runner turning at speed leans in.
    const bank = reduced ? 0 : Math.max(-0.2, Math.min(0.2, -turnS * speed * 0.02)) * gait;
    P.body(0, bodyY, 0, 0, 0, bank);
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
    if (airW > 0.01) {
      // Jumping in the wall: knees drawn up, back straight, hands still guarding.
      stance.copy(P);
      stance.set('hipL', -0.55, 0, -0.03).set('hipR', -0.55, 0, 0.03).set('knL', 0.95).set('knR', 0.95);
      stance.set('spine', -0.05).set('head', -0.12);
      P.blend(stance, airW);
    }
    if (armUpW > 0.01) {
      // Law 5, an indirect free kick: the right arm straight up, held.
      stance.copy(P);
      stance.set('shR', -3.05, 0, 0.05).set('elR', -0.05);
      P.blend(stance, armUpW);
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
        if (ev.style === 'roll') {
          // Underarm: sink into a lunge, arms down and back, then bowl it out low and follow through.
          const lunge = bump(u, 0, 1);
          const arm = keys(u, [0, -1.05, 0.2, -0.15, 0.4, -1.1, 1, -0.45]);
          P.set('shL', arm, 0, -0.12).set('shR', arm, 0, 0.12);
          P.set('elL', keys(u, [0, -1.15, 0.2, -0.3, 0.4, -0.15, 1, -0.4])).set('elR', keys(u, [0, -1.15, 0.2, -0.3, 0.4, -0.15, 1, -0.4]));
          P.set('spine', 0.4 * lunge).set('head', 0.1 * lunge);
          P.set('hipR', -0.75 * lunge).set('knR', 0.7 * lunge).set('hipL', 0.15 * lunge).set('knL', 0.5 * lunge);
          P.body(0, loco.a[BODY + 1] - 0.22 * lunge, 0.1 * lunge);
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
        // He rolls about his feet, so lying out along the dive his middle is a metre ahead of where the sim
        // has him: bring it back (and keep him on the grass, not sunk into it).
        const roll = 1.35 * fly;
        P.body(-reach * fly + 0.75 * Math.sin(roll), loft - crouch, 0, 0, 0, roll);
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
      case 'signal': {
        const w = smooth(0, 0.2, t) * (1 - smooth(a.dur - 0.3, a.dur, t));
        if (a.ev.kind === 'signal' && a.ev.style === 'advantage') {
          // Law 5: both arms swept out in front, a little apart.
          P.set('shL', -1.65 * w, 0, 0.2 * w).set('shR', -1.65 * w, 0, -0.2 * w);
          P.set('elL', -0.1 * w).set('elR', -0.1 * w);
        } else {
          // One arm out, a little above level, the way the free kick goes.
          P.set('shR', -1.9 * w, 0, 0.05 * w).set('elR', -0.05 * w);
        }
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
      for (const ev of events) {
        // A keeper beaten while he lies where he dived stays down; his dejection comes when he is up.
        if (action?.ev.kind === 'dive' && ev.kind === 'dejected') later = ev;
        else start(ev, p);
      }
      const reduced = ctx.reducedMotion;

      // Root: position (extrapolated between ticks) and heading.
      const lead = ctx.lead;
      // Off the ground in a jumping wall (MatchPlayer.air, metres).
      root.position.set(sx(p.pos.x + p.vel.x * lead), p.air ?? 0, sz(p.pos.y + p.vel.y * lead));
      const face = ctx.look ?? p.facing;
      let target = Math.atan2(face.x, face.y);
      if (yaw === null) yaw = target;
      // A dive is sideways to wherever he was facing: he doesn't swing round in the air.
      if (action?.ev.kind === 'dive') target = yaw;
      // Turn quickly, but never snap: max ~11 rad/s.
      const d = angleDelta(yaw, target);
      const maxTurn = 11 * dt;
      const yaw0 = yaw;
      yaw += Math.abs(d) < maxTurn ? d : Math.sign(d) * maxTurn;
      yaw = damp(yaw, yaw + angleDelta(yaw, target), 14, dt);
      if (dt > 0) turnS = damp(turnS, ctx.dtSim > 0 ? angleDelta(yaw0, yaw) / dt : 0, 8, dt);
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
      const fwdPrev = fwdS;
      fwdS = damp(fwdS, fwd, k, dt);
      accS = damp(accS, ctx.dtSim > 0 && dt > 0 ? (fwdS - fwdPrev) / dt : 0, 5, dt);
      sideS = damp(sideS, side, k, dt);

      keeperW = damp(keeperW, ctx.keeperSet, 6, dt);
      windedW = damp(windedW, p.winded && speed < 1.2 && !ctx.hasBall ? 1 : 0, 3, dt);
      throwW = damp(throwW, ctx.throwHold ? 1 : 0, 8, dt);
      holdW = damp(holdW, ctx.holding ? 1 : 0, 10, dt);
      dribbleW = damp(dribbleW, ctx.hasBall ? 1 : 0, 6, dt);
      wallW = damp(wallW, ctx.wall ? 1 : 0, 5, dt);
      armUpW = damp(armUpW, ctx.armUp ? 1 : 0, 8, dt);
      // In the air from a jumping wall: no smoothing, the sim's height is the pose.
      airW = Math.min(1, (p.air ?? 0) / 0.3);

      locomotion(loco, ctx.time, ctx.dtSim, reduced);
      stances(loco);
      // Follow the ball with the head (and a little with the shoulders): turned toward it, tipped down to it
      // when it is close. Not a keeper whose whole body already faces it, nor a man with it at his feet.
      let wantYaw = 0;
      let wantPitch = 0;
      if (ctx.ball && !ctx.look && !ctx.hasBall && !ctx.holding && !ctx.throwHold) {
        const bx = ctx.ball.x - p.pos.x;
        const by = ctx.ball.y - p.pos.y;
        const dist = Math.sqrt(bx * bx + by * by);
        if (dist > 0.5) {
          const rel = angleDelta(yaw, Math.atan2(bx, by));
          // A ball behind him: half a glance over the shoulder, not an owl's turn.
          const behind = Math.abs(rel) > 1.9;
          wantYaw = Math.max(-1.2, Math.min(1.2, rel)) * (behind ? 0.45 : 1) * (1 - 0.5 * smooth(5.2, 7.6, speedS));
          wantPitch = Math.max(-0.25, Math.min(0.55, Math.atan2(1.8 - ctx.ball.z, dist) - 0.06));
        }
      }
      lookYaw = damp(lookYaw, wantYaw, 5, dt);
      lookPitch = damp(lookPitch, wantPitch, 5, dt);
      loco.add('head', lookPitch * 0.7, lookYaw * 0.62, 0);
      loco.add('spine', lookPitch * 0.12, lookYaw * 0.3, 0);
      out.copy(loco);

      if (action) {
        let t = ctx.time - action.ev.t0 - action.held;
        // He stays stretched out for as long as the sim's dive runs (it holds him out a while when he is early), and gets up after.
        if (action.ev.kind === 'dive' && p.dive && p.dive.ticks > 0 && t > action.dur - 0.4) {
          action.held += ctx.dtSim;
          t = action.dur - 0.4;
        }
        // Get up early if the sim already has them running again.
        const recover = (action.ev.kind === 'knockdown' || action.ev.kind === 'tackle') && t > 0.35 && speed > 3.5;
        if (t >= action.dur || t < -0.2 || recover) {
          if (recover) {
            from.copy(lastOut);
            fromW = 1;
          }
          action = null;
          if (later) {
            start({ ...later, t0: Math.max(later.t0, ctx.time) }, p);
            later = null;
          }
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
      // The spine's rotation, shared with the chest: a curve through the back.
      const si = B.spine * 3;
      spine.rotation.set(a[si] * 0.55, a[si + 1] * 0.55, a[si + 2] * 0.55);
      chest.rotation.set(a[si] * 0.45, a[si + 1] * 0.45, a[si + 2] * 0.45);
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
      // Materials and the kit texture belong to the PlayerKit.
    },
  };
}


// ---------------------------------------------------------------------------
// Looks

const SKINS = ['#f3d2b5', '#e8b98f', '#d9a479', '#c08657', '#a06a42', '#80522f', '#674026'];
const HAIRS = ['#16110d', '#2b1c12', '#4a2f1b', '#73492a', '#a5733f', '#d7b56d', '#e8d9a8', '#3a3a3a', '#8a2d16'];

type KeeperKit = { shirt: string; shorts: string; socks: string; trim: string };

/** The keeper kits to pick from. */
const KEEPER_KITS: KeeperKit[] = [
    { shirt: '#f4dc1c', shorts: '#1b1b1b', socks: '#f4dc1c', trim: '#1b1b1b' },
    { shirt: '#24b35a', shorts: '#0f3d22', socks: '#24b35a', trim: '#f5f5f5' },
    { shirt: '#ff7a1a', shorts: '#2a2a2a', socks: '#ff7a1a', trim: '#1b1b1b' },
    { shirt: '#7c3fe0', shorts: '#2a1a4a', socks: '#7c3fe0', trim: '#f5f5f5' },
    { shirt: '#2e2e2e', shorts: '#2e2e2e', socks: '#2e2e2e', trim: '#f4dc1c' },
    { shirt: '#1fc7c7', shorts: '#0d3a3a', socks: '#1fc7c7', trim: '#111111' },
    // Teal, cream, navy, sky blue and bottle green: with these every ladder fixture has two keeper
    // kits that read against both shirts and the grass and against each other (tests/dots.test.ts).
    { shirt: '#2f8f8f', shorts: '#123838', socks: '#2f8f8f', trim: '#f5f5f5' },
    { shirt: '#efefcf', shorts: '#2a2a2a', socks: '#efefcf', trim: '#111111' },
    { shirt: '#0f0f4f', shorts: '#0a0a2a', socks: '#0f0f4f', trim: '#f5f5f5' },
    { shirt: '#0f8fef', shorts: '#0a2a4a', socks: '#0f8fef', trim: '#f5f5f5' },
    { shirt: '#0f2f0f', shorts: '#0a1a0a', socks: '#0f2f0f', trim: '#f4dc1c' },
];

/** How well a keeper's shirt reads against both sides' shirts and the grass, for every vision (kits.ts). */
function keeperReads(shirt: string, own: string, other: string): number {
  return Math.min(worstDiff(shirt, own), worstDiff(shirt, other), grassDiff(shirt, 'low'), grassDiff(shirt, 'high'));
}

/**
 * The keeper's kit: of these, the one that reads best against both sides' shirts and the grass,
 * for normal and red-green colour-blind vision alike (kits.ts worstDiff, grassDiff).
 */
export function keeperColors(own: string, other: string): KeeperKit {
  let best = KEEPER_KITS[0];
  let bestD = -1;
  for (const o of KEEPER_KITS) {
    const d = keeperReads(o.shirt, own, other);
    if (d > bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Both keepers' kits, chosen together: the pair where the worst of these reads best, each keeper
 * against both shirts and the grass, and the two keepers against each other. (Picking the home
 * keeper first and the away keeper after can leave no away kit far enough from his.)
 */
export function keeperPair(home: string, away: string): [KeeperKit, KeeperKit] {
  let best: [KeeperKit, KeeperKit] = [keeperColors(home, away), keeperColors(away, home)];
  let bestD = -1;
  for (const h of KEEPER_KITS) {
    const rh = keeperReads(h.shirt, home, away);
    if (rh <= bestD) continue;
    for (const a of KEEPER_KITS) {
      if (a === h) continue;
      const d = Math.min(rh, keeperReads(a.shirt, away, home), worstDiff(h.shirt, a.shirt));
      if (d > bestD) {
        bestD = d;
        best = [h, a];
      }
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
export function lookFor(id: string, kit: { shirt: string; shorts: string; socks: string; trim: string; rim?: boolean }, number: number | null, keeper: boolean, rand: (salt: number) => number): PlayerLook {
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
