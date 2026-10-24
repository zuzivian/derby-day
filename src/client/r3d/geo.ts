// Geometry helpers: merge simple geometries into one draw call, with an
// optional per-part float attribute (used to tag crowd heads and arms).

import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from './three.ts';

export interface Part {
  geo: BufferGeometry;
  /** Values for extra float attributes, constant over this part. */
  tags?: Record<string, number>;
  /** Per-vertex colour for the whole part. */
  color?: [number, number, number];
}

/** Concatenate geometries (position, normal, uv; optional colour and tags) into one indexed geometry. */
export function merge(parts: Part[], tagNames: string[] = [], withColor = false): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.geo.attributes.position.count;
    ni += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = withColor ? new Float32Array(nv * 3) : null;
  const tags = tagNames.map(() => new Float32Array(nv));
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const g = p.geo;
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array as Float32Array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, vo * 2);
    if (col) {
      const c = p.color ?? [1, 1, 1];
      for (let i = 0; i < n; i++) col.set(c, (vo + i) * 3);
    }
    tagNames.forEach((t, k) => tags[k].fill(p.tags?.[t] ?? 0, vo, vo + n));
    if (g.index) {
      const src = g.index.array as ArrayLike<number>;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = vo + i;
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new BufferAttribute(col, 3));
  tagNames.forEach((t, k) => out.setAttribute(t, new BufferAttribute(tags[k], 1)));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Apply a translation, Y rotation and scale to a geometry in place. */
export function place(g: BufferGeometry, x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = 1): BufferGeometry {
  const m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rotY), new Vector3(sx, sy, sz));
  g.applyMatrix4(m);
  return g;
}

/** A flat strip of quads on the ground (y = const), from a polyline. */
export function ribbon(points: [number, number][], width: number, y: number, closed = false): BufferGeometry {
  const pts = closed ? [...points, points[0]] : points;
  const pos: number[] = [];
  const idx: number[] = [];
  const hw = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    pos.push(x - dz * hw, y, z + dx * hw, x + dz * hw, y, z - dx * hw);
    if (i > 0) {
      const k = (i - 1) * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  return g;
}

export function arcPoints(cx: number, cz: number, r: number, a0: number, a1: number, n = 48): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}
