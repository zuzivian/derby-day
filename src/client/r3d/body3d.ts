// The footballer's body: one continuous, smoothly skinned mesh built from lofted cross-sections
// (torso, limbs, boots), a shaped head with a painted face, and hair, with a painted kit texture
// (tonal pattern, collar, side panels, numbers front and back, the name across the shoulders).
//
// Everything is built in the bind pose: standing straight, arms hanging at the sides, feet at y = 0,
// +z forward, +x the player's left (see player3d.ts). Each ring of a loft is weighted between two
// bones, so elbows, knees, the waist and the shoulders bend smoothly instead of hinging like a
// mannequin. Colours are per vertex; the kit texture multiplies over them (kit parts are white in
// the vertices, everything else maps to a white texel).

import { BufferAttribute, BufferGeometry, CanvasTexture, Color, SRGBColorSpace, SphereGeometry } from './three.ts';

/** Bone indices in the skeleton (player3d.ts builds the bones in this order). */
export const BI = { pelvis: 0, spine: 1, neck: 2, head: 3, shL: 4, elL: 5, shR: 6, elR: 7, hipL: 8, knL: 9, anL: 10, hipR: 11, knR: 12, anR: 13, chest: 14 } as const;
type BoneIx = (typeof BI)[keyof typeof BI];

/** Joint positions in the bind pose, local units (the player's root scale makes them metres). */
export const SKEL = {
  pelvisY: 0.95,
  spineUp: 0.06,
  chestUp: 0.24,
  /** Neck and shoulders hang off the chest. */
  neck: [0, 0.225, 0.005] as const,
  headUp: 0.075,
  shoulder: [0.235, 0.16, -0.01] as const,
  upperArm: 0.29,
  forearm: 0.25,
  hip: [0.1, -0.02, 0] as const,
  thigh: 0.45,
  shin: 0.41,
};

export interface BodyLook {
  shirt: string;
  shorts: string;
  socks: string;
  trim: string;
  skin: string;
  hair: string;
  hairStyle: number;
  boots: string;
  bootSole: string;
  bootAccent: string;
  gloves: string | null;
  longSleeves: boolean;
  build: number;
}

// ---------------------------------------------------------------------------
// Atlas layout (v up): the shirt's torso unwrap fills v 0.25..1; a white texel for untextured parts
// sits at the bottom left; the face at u 0.5..0.75, v 0..0.125.

const SHIRT_V0 = 0.25;
const WHITE_UV: [number, number] = [0.06, 0.06];
const FACE_U0 = 0.5;
const FACE_U1 = 0.75;
const FACE_V0 = 0.0;
const FACE_V1 = 0.125;

/** Where the torso's shirt starts and ends (the hem over the shorts, the collar). */
export const SHIRT_Y0 = 1.0;
export const SHIRT_Y1 = 1.495;

// ---------------------------------------------------------------------------
// Geometry accumulator

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, c: Color, u: number, v: number, a: number, b: number, w: number): number {
    this.pos.push(x, y, z);
    this.nor.push(0, 0, 0);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    // Two influences: bone a with 1 - w, bone b with w.
    if (w <= 0.001 || a === b) {
      this.si.push(a, 0, 0, 0);
      this.sw.push(1, 0, 0, 0);
    } else if (w >= 0.999) {
      this.si.push(b, 0, 0, 0);
      this.sw.push(1, 0, 0, 0);
    } else {
      this.si.push(a, b, 0, 0);
      this.sw.push(1 - w, w, 0, 0);
    }
    return this.count - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Smooth normals over the triangles from index `from` on (one part). Seam vertices share a position: welded by position. */
  normals(fromVert: number, fromIdx: number): void {
    const { pos, nor, idx } = this;
    const n = this.count;
    const acc = new Float32Array((n - fromVert) * 3);
    for (let i = fromIdx; i < idx.length; i += 3) {
      const a = idx[i];
      const b = idx[i + 1];
      const c = idx[i + 2];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
      const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        const k = (v - fromVert) * 3;
        acc[k] += nx;
        acc[k + 1] += ny;
        acc[k + 2] += nz;
      }
    }
    // Weld: vertices at the same position (loft seams, hem lips at a hair's distance are not welded) share a normal.
    const key = (i: number) => `${Math.round(pos[i * 3] * 2e4)},${Math.round(pos[i * 3 + 1] * 2e4)},${Math.round(pos[i * 3 + 2] * 2e4)}`;
    const groups = new Map<string, number[]>();
    for (let i = fromVert; i < n; i++) {
      const k = key(i);
      const g = groups.get(k);
      if (g) g.push(i);
      else groups.set(k, [i]);
    }
    for (const g of groups.values()) {
      let x = 0, y = 0, z = 0;
      for (const i of g) {
        const k = (i - fromVert) * 3;
        x += acc[k];
        y += acc[k + 1];
        z += acc[k + 2];
      }
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      for (const i of g) {
        nor[i * 3] = x / l;
        nor[i * 3 + 1] = y / l;
        nor[i * 3 + 2] = z / l;
      }
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(this.si), 4));
    g.setAttribute('skinWeight', new BufferAttribute(new Float32Array(this.sw), 4));
    g.setIndex(new BufferAttribute(this.count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return g;
  }
}

// ---------------------------------------------------------------------------
// Lofts: a tube through rings along y (or, for boots, along z), each ring an ellipse (a superellipse
// for the boxier torso) with its own centre, colour, bone pair and texture mapping.

interface Ring {
  /** Position along the loft axis. */
  t: number;
  /** Half extents across the axis: x, and the other one (z for a vertical loft, y for a horizontal one). */
  rx: number;
  rz: number;
  /** Centre offsets across the axis. */
  cx?: number;
  cz?: number;
  color: string;
  /** Bones a and b and the weight of b. */
  a: BoneIx;
  b?: BoneIx;
  w?: number;
  /** Map onto the shirt unwrap (torso only); otherwise the white texel. */
  shirt?: boolean;
  /** Per-vertex colour override, by angle around (0 = +z front, PI/2 = +x left) and ring. */
  tint?: (theta: number) => string | null;
}

interface LoftOpts {
  seg: number;
  /** Superellipse exponent (2 = ellipse). */
  power?: number;
  capStart?: boolean;
  capEnd?: boolean;
  /** Loft along z instead of y (boots): rz is then the vertical half extent, cz a vertical offset. */
  alongZ?: boolean;
  /** Offset of the whole loft. */
  ox?: number;
  oy?: number;
  oz?: number;
}

const tmpC = new Color();
const tintC = new Color();

function loft(B: Builder, rings: Ring[], o: LoftOpts): void {
  const v0 = B.count;
  const i0 = B.idx.length;
  const seg = o.seg;
  const p = o.power ?? 2;
  const ox = o.ox ?? 0;
  const oy = o.oy ?? 0;
  const oz = o.oz ?? 0;
  const ringStart: number[] = [];
  for (const r of rings) {
    ringStart.push(B.count);
    tmpC.set(r.color);
    for (let k = 0; k <= seg; k++) {
      // Seam on the player's left side (+x); the angle runs from +x through -z (the back) to -x and +z (the front).
      const theta = Math.PI / 2 + (k / seg) * Math.PI * 2;
      const s = Math.sin(theta);
      const c = Math.cos(theta);
      // Superellipse: |x|^p + |z|^p = 1.
      const se = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / p);
      const ax = r.rx * se(s) + (r.cx ?? 0);
      const az = r.rz * se(c) + (r.cz ?? 0);
      let x: number, y: number, z: number;
      if (o.alongZ) {
        x = ax + ox;
        y = az + oy;
        z = r.t + oz;
      } else {
        x = ax + ox;
        y = r.t + oy;
        z = az + oz;
      }
      let u: number, v: number;
      if (r.shirt) {
        u = k / seg;
        v = SHIRT_V0 + (1 - SHIRT_V0) * Math.max(0, Math.min(1, (r.t - SHIRT_Y0) / (SHIRT_Y1 - SHIRT_Y0)));
      } else {
        u = WHITE_UV[0];
        v = WHITE_UV[1];
      }
      const tint = r.tint?.(theta);
      const cc = tint ? tintC.set(tint) : tmpC;
      B.vert(x, y, z, cc, u, v, r.a, r.b ?? r.a, r.w ?? 0);
    }
  }
  const up = rings.length > 1 && rings[rings.length - 1].t > rings[0].t;
  for (let j = 0; j < rings.length - 1; j++) {
    const a = ringStart[j];
    const b = ringStart[j + 1];
    // Outward-facing winding: depends on which way the loft runs and on its axis (worked through in the PR).
    for (let k = 0; k < seg; k++) {
      const a0 = a + k, a1 = a + k + 1, b0 = b + k, b1 = b + k + 1;
      if (up !== !!o.alongZ) {
        B.tri(a0, a1, b0);
        B.tri(a1, b1, b0);
      } else {
        B.tri(a0, b0, a1);
        B.tri(a1, b0, b1);
      }
    }
  }
  const cap = (ri: number, end: boolean) => {
    const r = rings[ri];
    const centre = o.alongZ ? B.vert((r.cx ?? 0) + ox, (r.cz ?? 0) + oy, r.t + oz, tmpC.set(r.color), WHITE_UV[0], WHITE_UV[1], r.a, r.b ?? r.a, r.w ?? 0) : B.vert((r.cx ?? 0) + ox, r.t + oy, (r.cz ?? 0) + oz, tmpC.set(r.color), r.shirt ? 0.5 : WHITE_UV[0], r.shirt ? 1 : WHITE_UV[1], r.a, r.b ?? r.a, r.w ?? 0);
    const s0 = ringStart[ri];
    // The cap faces outward along the axis at the loft's far end when it runs +, at its near end when it runs -.
    const outwardPositive = end ? up : !up;
    for (let k = 0; k < seg; k++) {
      if (outwardPositive !== !!o.alongZ) B.tri(centre, s0 + k, s0 + k + 1);
      else B.tri(centre, s0 + k + 1, s0 + k);
    }
  };
  if (o.capStart) cap(0, false);
  if (o.capEnd) cap(rings.length - 1, true);
  B.normals(v0, i0);
}

/** A sphere-based part (head, hair, ears) deformed by `shape`, rigid on one bone (or blended by `weight`). */
function blob(
  B: Builder,
  g: BufferGeometry,
  color: string | ((x: number, y: number, z: number) => string),
  bone: BoneIx,
  shape?: (v: [number, number, number]) => void,
  uvMap?: (x: number, y: number, z: number, u: number, v: number) => [number, number],
  weight?: (x: number, y: number, z: number) => [BoneIx, BoneIx, number],
): void {
  const v0 = B.count;
  const i0 = B.idx.length;
  const pa = g.attributes.position;
  const ua = g.attributes.uv;
  const one = typeof color === 'string' ? new Color(color) : null;
  for (let i = 0; i < pa.count; i++) {
    const v: [number, number, number] = [pa.getX(i), pa.getY(i), pa.getZ(i)];
    shape?.(v);
    const c = one ?? tmpC.set((color as (x: number, y: number, z: number) => string)(v[0], v[1], v[2]));
    const [u, w] = uvMap ? uvMap(v[0], v[1], v[2], ua.getX(i), ua.getY(i)) : WHITE_UV;
    const [a, b, wt] = weight ? weight(v[0], v[1], v[2]) : [bone, bone, 0];
    B.vert(v[0], v[1], v[2], c, u, w, a, b, wt);
  }
  const ix = g.index!;
  for (let i = 0; i < ix.count; i += 3) B.tri(v0 + ix.getX(i), v0 + ix.getX(i + 1), v0 + ix.getX(i + 2));
  g.dispose();
  B.normals(v0, i0);
}

// ---------------------------------------------------------------------------
// The body

/** Joint heights in the bind pose (y), derived from SKEL. */
export function joints(bw: number) {
  const pelvis = SKEL.pelvisY;
  const spine = pelvis + SKEL.spineUp;
  const chest = spine + SKEL.chestUp;
  const neck = chest + SKEL.neck[1];
  const head = neck + SKEL.headUp;
  const shoulder = chest + SKEL.shoulder[1];
  const elbow = shoulder - SKEL.upperArm;
  const wrist = elbow - SKEL.forearm;
  const hip = pelvis + SKEL.hip[1];
  const knee = hip - SKEL.thigh;
  const ankle = knee - SKEL.shin;
  return { pelvis, spine, chest, neck, head, shoulder, elbow, wrist, hip, knee, ankle, shX: SKEL.shoulder[0] * bw, hipX: SKEL.hip[0] * bw };
}

/** Head centre height and radius (bind pose), for the face and the hair. */
const HEAD_R = 0.112;

export function buildBody(look: BodyLook, detail: 'low' | 'high' = 'high', textured = true): BufferGeometry {
  const B = new Builder();
  const bw = 1 + look.build * 0.06;
  const J = joints(bw);
  const hi = detail === 'high';
  const segT = hi ? 18 : 12;
  const segL = hi ? 12 : 8;
  const segA = hi ? 10 : 7;

  // Weight of bone b across a band [y0, y1] (0 below, 1 above), smoothed.
  const band = (y: number, y0: number, y1: number) => {
    const t = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
    return t * t * (3 - 2 * t);
  };

  // --- Torso: shorts up to the hem, then the shirt to the collar.
  // Bones: pelvis below the waist, blending into the spine, then the chest above the ribs.
  const torsoBone = (y: number): Pick<Ring, 'a' | 'b' | 'w'> => {
    if (y < 1.02) return { a: BI.pelvis };
    if (y < 1.12) return { a: BI.pelvis, b: BI.spine, w: band(y, 1.02, 1.12) };
    if (y < 1.22) return { a: BI.spine };
    if (y < 1.32) return { a: BI.spine, b: BI.chest, w: band(y, 1.22, 1.32) };
    return { a: BI.chest };
  };
  const tr = (t: number, rx: number, rz: number, color: string, extra: Partial<Ring> = {}): Ring => ({ t, rx: rx * bw, rz, cz: extra.cz, color, ...torsoBone(t), ...extra });
  // With a kit texture the torso's vertices are white and the texture paints the shirt.
  const shirtW = textured ? '#ffffff' : look.shirt;
  loft(
    B,
    [
      tr(0.8, 0.135, 0.09, look.shorts, { cz: -0.005 }),
      tr(0.85, 0.172, 0.112, look.shorts, { cz: -0.008 }),
      tr(0.93, 0.182, 0.12, look.shorts, { cz: -0.01 }),
      tr(0.995, 0.176, 0.115, look.shorts, { cz: -0.008 }),
      // The shirt hangs loose over the shorts: a lip at the hem.
      tr(0.997, 0.192, 0.128, shirtW, { cz: -0.006, shirt: true }),
      tr(1.06, 0.188, 0.124, shirtW, { cz: -0.004, shirt: true }),
      tr(1.15, 0.19, 0.122, shirtW, { cz: 0, shirt: true }),
      tr(1.24, 0.203, 0.13, shirtW, { cz: 0.006, shirt: true }),
      tr(1.32, 0.214, 0.138, shirtW, { cz: 0.008, shirt: true }),
      tr(1.39, 0.222, 0.128, shirtW, { cz: 0.002, shirt: true }),
      tr(1.44, 0.2, 0.108, shirtW, { cz: -0.006, shirt: true }),
      tr(1.475, 0.135, 0.085, shirtW, { cz: -0.004, shirt: true }),
      tr(SHIRT_Y1, 0.078, 0.07, shirtW, { cz: 0.0, shirt: true }),
    ],
    { seg: segT, power: 2.35, capStart: true, capEnd: true },
  );

  // --- Neck.
  const neckW = (y: number): Pick<Ring, 'a' | 'b' | 'w'> => (y < J.neck + 0.02 ? { a: BI.chest, b: BI.neck, w: band(y, J.neck - 0.03, J.neck + 0.02) } : { a: BI.neck, b: BI.head, w: band(y, J.head - 0.01, J.head + 0.03) });
  loft(
    B,
    [1.46, 1.5, 1.54, 1.58, 1.62].map((t, i) => ({ t, rx: [0.062, 0.056, 0.052, 0.05, 0.05][i], rz: [0.06, 0.056, 0.054, 0.052, 0.05][i], cz: [0.0, 0.004, 0.008, 0.012, 0.014][i], color: look.skin, ...neckW(t) })),
    { seg: segA },
  );

  // --- Head: a sphere shaped into a skull and jaw, with a nose, ears and a painted face.
  const hc = J.head + 0.105;
  const headShape = (v: [number, number, number]) => {
    let [x, y, z] = v;
    // Narrower at the jaw, a chin a little forward, the back of the skull rounder.
    const below = Math.max(0, -y / HEAD_R);
    x *= 0.93 * (1 - 0.18 * below * below);
    y *= 1.1;
    z *= 1.0 + (z > 0 ? 0.04 : 0.06) - 0.12 * below * (z < 0 ? 1 : 0);
    if (z > 0 && y < 0) z += 0.012 * below;
    // Brow ridge and cheekbones: a slight push forward of the upper face.
    if (z > 0.06 && y > -0.01 && y < 0.05) z += 0.006;
    v[0] = x;
    v[1] = y + hc;
    v[2] = z + 0.008;
  };
  const faceUv = (x: number, y: number, z: number): [number, number] => {
    // Unwrapped around y like the torso (seam at the left side), the front half onto the face rect.
    let th = Math.atan2(x, z - 0.008) - Math.PI / 2;
    while (th < 0) th += Math.PI * 2;
    while (th >= Math.PI * 2) th -= Math.PI * 2;
    const u = th / (Math.PI * 2);
    const vy = (y - (hc - HEAD_R * 1.1)) / (HEAD_R * 2.2);
    return [FACE_U0 + (FACE_U1 - FACE_U0) * u, FACE_V0 + (FACE_V1 - FACE_V0) * Math.max(0, Math.min(1, vy))];
  };
  blob(B, new SphereGeometry(HEAD_R, hi ? 16 : 12, hi ? 12 : 9), look.skin, BI.head, headShape, (x, y, z) => faceUv(x, y, z));
  // Nose.
  blob(B, new SphereGeometry(0.022, 6, 5), look.skin, BI.head, (v) => {
    v[0] *= 0.7;
    v[1] = v[1] * 1.3 + hc - 0.012;
    v[2] = v[2] * 0.9 + 0.112;
  });
  // Ears.
  for (const sx of [1, -1]) {
    blob(B, new SphereGeometry(0.028, 6, 5), look.skin, BI.head, (v) => {
      v[0] = v[0] * 0.4 + sx * 0.1;
      v[1] = v[1] * 1.15 + hc - 0.005;
      v[2] = v[2] * 0.75 - 0.005;
    });
  }
  // Hair.
  hair(B, look, hc, hi);

  // --- Arms: deltoid in the shirt, the sleeve with a cuff, then skin (or sleeve to the wrist for keepers).
  for (const side of [1, -1] as const) {
    const sh = side > 0 ? BI.shL : BI.shR;
    const el = side > 0 ? BI.elL : BI.elR;
    const x = side * J.shX;
    const sleeveEnd = look.longSleeves ? J.wrist + 0.015 : J.shoulder - 0.16;
    // Kit colour on sleeves comes from the vertices (they map to the texture's white texel).
    const sleeveColor = look.shirt;
    const colorAt = (y: number) => (y > sleeveEnd || look.longSleeves ? sleeveColor : look.skin);
    const wA = (y: number): Pick<Ring, 'a' | 'b' | 'w'> => {
      if (y > J.shoulder - 0.02) return { a: BI.chest, b: sh, w: band(-y, -(J.shoulder + 0.06), -(J.shoulder - 0.02)) };
      if (y > J.elbow + 0.04) return { a: sh };
      if (y > J.elbow - 0.04) return { a: sh, b: el, w: band(-y, -(J.elbow + 0.04), -(J.elbow - 0.04)) };
      return { a: el };
    };
    const S = J.shoulder;
    const E = J.elbow;
    const W = J.wrist;
    const pts: [number, number, number, number, number][] = [
      // y, rx, rz, cx (outward), cz
      [S + 0.045, 0.03, 0.04, -0.03, 0],
      [S + 0.025, 0.056, 0.062, -0.012, 0],
      [S - 0.02, 0.066, 0.068, 0.0, 0],
      [S - 0.09, 0.064, 0.064, 0.0, 0],
    ];
    const rings: Ring[] = pts.map(([y, rx, rz, cx, cz]) => ({ t: y, rx, rz, cx: cx * side, cz, color: colorAt(y), ...wA(y) }));
    if (!look.longSleeves) {
      // Cuff: trim colour, then a lip into the bare arm.
      rings.push({ t: sleeveEnd + 0.012, rx: 0.067, rz: 0.066, cx: 0.0 * side, color: sleeveColor, ...wA(sleeveEnd + 0.012) });
      rings.push({ t: sleeveEnd + 0.003, rx: 0.067, rz: 0.066, cx: 0.0 * side, color: look.trim, ...wA(sleeveEnd) });
      rings.push({ t: sleeveEnd, rx: 0.067, rz: 0.066, cx: 0.0 * side, color: look.trim, ...wA(sleeveEnd) });
      rings.push({ t: sleeveEnd - 0.002, rx: 0.062, rz: 0.063, cx: 0.0, color: look.skin, ...wA(sleeveEnd) });
    }
    const lower: [number, number, number, number][] = [
      [S - 0.2, 0.06, 0.062, 0.0],
      [E + 0.05, 0.052, 0.052, 0.0],
      [E, 0.048, 0.048, -0.004],
      [E - 0.04, 0.052, 0.052, 0.0],
      [E - 0.1, 0.046, 0.045, 0.004],
      [W + 0.04, 0.034, 0.035, 0.006],
      [W + 0.005, 0.029, 0.032, 0.006],
    ];
    for (const [y, rx, rz, cz] of lower) {
      // Short sleeves: the rings inside the sleeve are not needed. Long: the cuff rings below take over at the wrist.
      if (!look.longSleeves && y >= sleeveEnd - 0.002) continue;
      if (look.longSleeves && y <= W + 0.036) continue;
      const c = look.longSleeves && y > W + 0.03 ? sleeveColor : look.skin;
      rings.push({ t: y, rx: look.longSleeves && y > W + 0.03 ? rx * 1.12 : rx, rz: look.longSleeves && y > W + 0.03 ? rz * 1.12 : rz, cz, color: c, ...wA(y) });
    }
    if (look.longSleeves) {
      // Long sleeve: the cuff at the wrist.
      rings.push({ t: W + 0.034, rx: 0.038, rz: 0.04, cz: 0.006, color: sleeveColor, ...wA(W) });
      rings.push({ t: W + 0.03, rx: 0.038, rz: 0.04, cz: 0.006, color: look.trim, ...wA(W) });
      rings.push({ t: W + 0.012, rx: 0.036, rz: 0.038, cz: 0.006, color: look.trim, ...wA(W) });
      rings.push({ t: W + 0.009, rx: 0.028, rz: 0.03, cz: 0.006, color: look.skin, ...wA(W) });
    }
    loft(B, rings, { seg: segA, ox: x, capStart: true, capEnd: true });

    // Hand: palm facing the thigh, fingers down, a thumb forward; a padded glove for keepers.
    const g = !!look.gloves;
    const hc2 = look.gloves ?? look.skin;
    const k = g ? 1.3 : 1;
    loft(
      B,
      [
        { t: W + 0.01, rx: 0.02 * k, rz: 0.03 * k, cz: 0.006, color: hc2, a: el },
        { t: W - 0.02, rx: 0.022 * k, rz: 0.042 * k, cz: 0.008, color: hc2, a: el },
        { t: W - 0.06, rx: 0.02 * k, rz: 0.044 * k, cz: 0.008, color: hc2, a: el },
        { t: W - 0.095, rx: 0.016 * k, rz: 0.038 * k, cz: 0.006, color: hc2, a: el },
        { t: W - 0.11, rx: 0.01 * k, rz: 0.026 * k, cz: 0.004, color: hc2, a: el },
      ],
      { seg: 8, ox: x + side * 0.004, capStart: false, capEnd: true },
    );
    // Thumb.
    blob(B, new SphereGeometry(0.014 * k, 5, 4), hc2, el, (v) => {
      v[0] = v[0] + x - side * 0.012;
      v[1] = v[1] * 2.2 + W - 0.035;
      v[2] = v[2] + 0.045 * k;
    });
  }

  // --- Legs: shorts over the thigh, a hem, the bare knee, the sock from just below it, into the boot.
  for (const side of [1, -1] as const) {
    const hip = side > 0 ? BI.hipL : BI.hipR;
    const kn = side > 0 ? BI.knL : BI.knR;
    const an = side > 0 ? BI.anL : BI.anR;
    const x = side * J.hipX;
    const H = J.hip;
    const K = J.knee;
    const A = J.ankle;
    const wL = (y: number): Pick<Ring, 'a' | 'b' | 'w'> => {
      if (y > H - 0.06) return { a: BI.pelvis, b: hip, w: band(-y, -(H + 0.05), -(H - 0.06)) };
      if (y > K + 0.06) return { a: hip };
      if (y > K - 0.05) return { a: hip, b: kn, w: band(-y, -(K + 0.06), -(K - 0.05)) };
      if (y > A + 0.04) return { a: kn };
      return { a: kn, b: an, w: band(-y, -(A + 0.04), -(A - 0.01)) };
    };
    const hem = 0.79;
    const sockTop = K - 0.035;
    const L = (y: number, rx: number, rz: number, color: string, cx = 0, cz = 0): Ring => ({ t: y, rx: rx * (y > K ? bw : 1), rz: rz * (y > K ? bw : 1), cx: cx * side, cz, color, ...wL(y) });
    loft(
      B,
      [
        L(1.0, 0.11, 0.115, look.shorts, -0.01),
        L(0.92, 0.118, 0.12, look.shorts, 0.0),
        L(0.85, 0.118, 0.118, look.shorts, 0.004),
        L(hem + 0.004, 0.116, 0.114, look.shorts, 0.006),
        L(hem, 0.098, 0.1, look.skin, 0.004, 0.004),
        L(0.72, 0.092, 0.096, look.skin, 0.002, 0.006),
        L(0.64, 0.08, 0.083, look.skin, 0.0, 0.006),
        L(0.56, 0.066, 0.068, look.skin, 0.0, 0.006),
        L(K + 0.02, 0.058, 0.06, look.skin, 0.0, 0.01),
        L(sockTop + 0.004, 0.058, 0.06, look.skin, 0.0, 0.006),
        // Sock turn-over: a little proud of the leg, a band of trim near the top.
        L(sockTop, 0.065, 0.066, look.socks, 0.0, 0.004),
        L(sockTop - 0.02, 0.066, 0.068, look.trim, 0.0, 0.0),
        L(sockTop - 0.035, 0.066, 0.068, look.trim, 0.0, -0.004),
        L(sockTop - 0.038, 0.066, 0.068, look.socks, 0.0, -0.004),
        L(0.36, 0.064, 0.07, look.socks, 0.0, -0.014),
        L(0.29, 0.06, 0.064, look.socks, 0.0, -0.012),
        L(0.21, 0.048, 0.05, look.socks, 0.0, -0.006),
        L(0.14, 0.04, 0.042, look.socks, 0.0, -0.002),
        L(A + 0.035, 0.038, 0.04, look.socks, 0.0, 0.0),
        L(A + 0.009, 0.039, 0.043, look.socks, 0.0, -0.002),
        L(A + 0.005, 0.04, 0.046, look.boots, 0.0, -0.004),
      ],
      { seg: segL, ox: x, capStart: false, capEnd: true },
    );
    // Boot: along z from the heel to the toe, sole underneath, a coloured flash on the outside.
    const bootTint = (y0: number) => (theta: number): string | null => {
      void y0;
      // theta: 0 is +z... here for a z-loft: x = rx sin, y = rz cos; cos < -0.55 is the sole.
      const c = Math.cos(theta);
      const s = Math.sin(theta) * side;
      if (c < -0.6) return look.bootSole;
      if (s > 0.55 && c > -0.4 && c < 0.45) return look.bootAccent;
      return null;
    };
    const bz = (t: number, rx: number, ry: number, cy: number): Ring => ({ t, rx, rz: ry, cz: cy, color: look.boots, a: an, tint: bootTint(t) });
    loft(
      B,
      [bz(-0.075, 0.03, 0.03, A - 0.045), bz(-0.06, 0.044, 0.046, A - 0.035), bz(-0.02, 0.048, 0.052, A - 0.03), bz(0.03, 0.05, 0.042, A - 0.04), bz(0.09, 0.047, 0.03, A - 0.05), bz(0.14, 0.038, 0.022, A - 0.056), bz(0.17, 0.022, 0.014, A - 0.06)],
      { seg: 10, alongZ: true, ox: x, oy: 0, oz: 0.0, capStart: true, capEnd: true },
    );
  }

  return B.geometry();
}

function hair(B: Builder, look: BodyLook, hc: number, hi: boolean): void {
  const st = look.hairStyle;
  if (st === 3) return; // shaved
  const big = st === 4;
  const buzz = st === 1;
  const r = HEAD_R * (buzz ? 1.035 : big ? 1.22 : 1.08);
  // A cap over the skull: down to the brow at the front, the nape at the back, over the ears at the sides.
  const g = new SphereGeometry(r, hi ? 14 : 10, hi ? 8 : 6, 0, Math.PI * 2, 0, Math.PI * (st === 2 ? 0.72 : 0.6));
  blob(B, g, look.hair, BI.head, (v) => {
    let [x, y, z] = v;
    x *= 0.95;
    y *= big ? 1.08 : 1.12;
    z *= big ? 1.1 : 1.06;
    // Hairline: high on the forehead, over the top of the ears at the sides, down to the nape at the back.
    // A vertex below it slides up the shell to it.
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const fz = z / len;
    const side = Math.abs(x) / len;
    const minY = (fz > 0 ? 0.42 * fz * fz + 0.1 * (1 - fz) : -0.25 * -fz) * r - 0.02 * side * r;
    if (y < minY) {
      const k = Math.sqrt(Math.max(0, len * len - minY * minY) / Math.max(1e-6, x * x + z * z));
      x *= k;
      z *= k;
      y = minY;
    }
    // Thin at the hairline, so its edge lies on the skin instead of standing off it like a cap's brim.
    const edge = Math.max(0, 1 - (y - minY) / (0.35 * r));
    const hug = 1 - (big ? 0.12 : 0.075) * edge;
    x *= hug;
    z *= hug;
    v[0] = x;
    v[1] = y + hc + (big ? 0.02 : 0.012);
    v[2] = z - (big ? 0.01 : 0.004);
  });
  if (st === 2) {
    // Long: hair falling to the collar at the back.
    loft(
      B,
      [
        { t: hc + 0.02, rx: 0.1, rz: 0.06, cz: -0.05, color: look.hair, a: BI.head },
        { t: hc - 0.06, rx: 0.1, rz: 0.055, cz: -0.06, color: look.hair, a: BI.head },
        { t: hc - 0.12, rx: 0.085, rz: 0.04, cz: -0.07, color: look.hair, a: BI.head, b: BI.neck, w: 0.4 },
      ],
      { seg: 10, capEnd: true },
    );
  }
}

// ---------------------------------------------------------------------------
// The kit texture

export interface KitPaint {
  shirt: string;
  trim: string;
  /** Colour of the numbers and the name. */
  numColor: string;
  numOutline: string;
  number: number | null;
  name: string | null;
  /** 0..5: tonal pattern (none, pinstripes, hoops, gradient, chevrons, shadow stripes). */
  pattern: number;
  /** V-neck (true) or crew collar. */
  vneck: boolean;
  /** Skin and brow colours, for the face. */
  skin: string;
  hair: string;
}

const shade = (hex: string, k: number): string => {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + k)));
  return `#${c.getHexString()}`;
};

/** Paint one player's kit texture (shirt unwrap, face). null without a DOM (unit tests). */
export function paintKit(p: KitPaint, size: number): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  const S = size;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  // The shirt: canvas y 0 is v = 1 (the collar), y at v = SHIRT_V0 the hem.
  const top = 0;
  const bot = S * (1 - SHIRT_V0);
  const H = bot - top;
  const vy = (v: number) => top + (1 - v) * H; // v: 0 hem .. 1 collar, over the shirt rect
  g.fillStyle = p.shirt;
  g.fillRect(0, top, S, H);
  const light = shade(p.shirt, 0.05);
  const dark = shade(p.shirt, -0.05);
  g.save();
  g.beginPath();
  g.rect(0, top, S, H);
  g.clip();
  switch (p.pattern) {
    case 1: {
      g.fillStyle = dark;
      for (let x = 0; x < S; x += S / 32) g.fillRect(x, top, Math.max(1, S / 256), H);
      break;
    }
    case 2: {
      g.fillStyle = dark;
      for (let i = 0; i < 6; i += 2) g.fillRect(0, top + (i / 6) * H, S, H / 6);
      break;
    }
    case 3: {
      const gr = g.createLinearGradient(0, top, 0, bot);
      gr.addColorStop(0, light);
      gr.addColorStop(1, dark);
      g.fillStyle = gr;
      g.globalAlpha = 0.8;
      g.fillRect(0, top, S, H);
      g.globalAlpha = 1;
      break;
    }
    case 4: {
      g.strokeStyle = light;
      g.lineWidth = S / 40;
      for (const cx of [0.25, 0.75]) {
        for (let k = 0; k < 3; k++) {
          const y = top + H * (0.3 + k * 0.12);
          g.beginPath();
          g.moveTo((cx - 0.25) * S, y + H * 0.12);
          g.lineTo(cx * S, y);
          g.lineTo((cx + 0.25) * S, y + H * 0.12);
          g.stroke();
        }
      }
      break;
    }
    case 5: {
      g.fillStyle = dark;
      for (let x = 0; x < S; x += S / 12) g.fillRect(x, top, S / 24, H);
      break;
    }
  }
  // Fabric: soft shade toward the sides (under the arms) and creases above the hem.
  for (const sx of [0, 0.5, 1]) {
    const gr = g.createLinearGradient((sx - 0.12) * S, 0, (sx + 0.12) * S, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.5, 'rgba(0,0,0,0.16)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect((sx - 0.12) * S, top, 0.24 * S, H);
  }
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = Math.max(1, S / 170);
  for (let i = 0; i < 9; i++) {
    const x0 = ((i * 0.37) % 1) * S;
    const y0 = vy(0.06 + ((i * 0.53) % 1) * 0.22);
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(x0 + S * 0.03, y0 - H * 0.03, x0 + S * 0.07, y0 + H * 0.01);
    g.stroke();
  }
  // Side panels in the trim colour, down each side seam.
  g.fillStyle = p.trim;
  for (const sx of [0, 0.5, 1]) g.fillRect(sx * S - S * 0.008, vy(0.95), S * 0.016, vy(0.02) - vy(0.95));
  // Hem band.
  g.fillRect(0, vy(0.035), S, H * 0.022);
  g.restore();
  // Collar at the front (u = 0.75) and round the back of the neck.
  g.fillStyle = p.trim;
  g.fillRect(0, vy(1), S, H * 0.035);
  if (p.vneck) {
    g.beginPath();
    g.moveTo(0.75 * S - S * 0.07, vy(1));
    g.lineTo(0.75 * S, vy(0.84));
    g.lineTo(0.75 * S + S * 0.07, vy(1));
    g.lineTo(0.75 * S + S * 0.045, vy(1));
    g.lineTo(0.75 * S, vy(0.88));
    g.lineTo(0.75 * S - S * 0.045, vy(1));
    g.closePath();
    g.fill();
  }
  const font = (px: number) => `800 ${Math.round(px)}px 'Big Shoulders Display', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif`;
  const label = (text: string, x: number, y: number, px: number, squeeze = 1) => {
    g.save();
    g.translate(x, y);
    g.scale(squeeze, 1);
    g.font = font(px);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, px * 0.12);
    g.strokeStyle = p.numOutline;
    g.strokeText(text, 0, 0);
    g.fillStyle = p.numColor;
    g.fillText(text, 0, 0);
    g.restore();
  };
  if (p.number !== null) {
    // The back (u = 0.25): the name across the shoulders, the number under it.
    label(String(p.number), 0.25 * S, vy(0.5), H * 0.36, p.number >= 10 ? 0.62 : 0.8);
    // Front: a small number on the right of the chest (the player's right, the viewer's left).
    label(String(p.number), 0.68 * S, vy(0.68), H * 0.12, 0.8);
  }
  if (p.name) {
    const name = p.name.toUpperCase().slice(0, 12);
    g.font = font(H * 0.08);
    const wName = g.measureText(name).width;
    const maxW = S * 0.2;
    label(name, 0.25 * S, vy(0.79), H * 0.08, Math.min(1, maxW / Math.max(1, wName)));
  }
  // Crest on the left of the chest: a small shield in the trim colour.
  {
    const cx = 0.82 * S;
    const cy = vy(0.68);
    const r = H * 0.045;
    g.fillStyle = p.trim;
    g.beginPath();
    g.moveTo(cx - r, cy - r);
    g.lineTo(cx + r, cy - r);
    g.lineTo(cx + r, cy + r * 0.2);
    g.quadraticCurveTo(cx + r * 0.6, cy + r * 1.1, cx, cy + r * 1.4);
    g.quadraticCurveTo(cx - r * 0.6, cy + r * 1.1, cx - r, cy + r * 0.2);
    g.closePath();
    g.fill();
    g.fillStyle = p.shirt;
    g.beginPath();
    g.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    g.fill();
  }

  // The face, multiplied over the skin colour: eyes, brows, a mouth, a little shading.
  {
    const x0 = FACE_U0 * S;
    const w = (FACE_U1 - FACE_U0) * S;
    const y0 = (1 - FACE_V1) * S;
    const h = (FACE_V1 - FACE_V0) * S;
    // Head u: 0.5 back? The front is at u_head = 0.75; v from the chin (0) to the crown (1).
    const fx = (u: number) => x0 + w * u;
    const fy = (v: number) => y0 + h * (1 - v);
    // Soft cheek and eye-socket shading.
    g.fillStyle = 'rgba(120,70,50,0.10)';
    g.beginPath();
    g.ellipse(fx(0.75), fy(0.52), w * 0.09, h * 0.08, 0, 0, Math.PI * 2);
    g.fill();
    const brow = shade(p.hair, -0.05);
    for (const d of [-1, 1]) {
      const ex = fx(0.75 + d * 0.052);
      // Eye: white then a dark iris.
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.ellipse(ex, fy(0.555), w * 0.022, h * 0.03, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#2a1d16';
      g.beginPath();
      g.ellipse(ex, fy(0.555), w * 0.012, h * 0.032, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = brow;
      g.fillRect(ex - w * 0.03, fy(0.635), w * 0.06, h * 0.03);
    }
    g.fillStyle = 'rgba(110,45,40,0.55)';
    g.fillRect(fx(0.75) - w * 0.035, fy(0.3), w * 0.07, h * 0.022);
  }

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
