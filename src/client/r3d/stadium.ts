// The stadium: grass and markings, goals with nets that move, ad boards,
// stands with an instanced crowd and flags, floodlight pylons, sky, and a
// town outside (car park, trees, low buildings). Sized from the sim constants
// so the six-a-side arena and a full 105 × 68 pitch both work.

import { BOX_DEPTH, BOX_W, CENTRE_R, CORNER_R, GOAL_BAR_H, GOAL_DEPTH, GOAL_W, PENALTY_SPOT, PITCH_H, PITCH_W, RETREAT, SIX_DEPTH, SIX_W } from '../../sim/constants.ts';
import type { TeamSetup } from '../../sim/types.ts';
import { arcPoints, merge, place, ribbon, type Part } from './geo.ts';
import { BIG_PITCH, HALF_H, HALF_W, clamp01 } from './space.ts';
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from './three.ts';

export interface StadiumOptions {
  teams: [TeamSetup, TeamSetup];
  /** 0..1: crowd density, texture sizes and shadow casting for slow GPUs. */
  quality: 'low' | 'high';
  anisotropy: number;
}

export interface Stadium {
  group: Group;
  /** Stands keyed by side, so the camera can hide the one it looks through. */
  stands: Record<'far' | 'near' | 'left' | 'right', Object3D>;
  /** The ad boards along each side, so the camera can hide the ones it looks through (like the stands). */
  boards: Record<'far' | 'near' | 'left' | 'right', Object3D>;
  update(dt: number, time: number, o: { excite: [number, number]; ball: { x: number; y: number; z: number; speed: number } }): void;
  /** A goal went in at this end (0: home goal at x = 0, 1: away goal), ball at scene position. */
  ripple(side: 0 | 1, at: Vector3, strength: number): void;
  dispose(): void;
}

// Layout, in metres from the touchline / goal line.
const RUNOFF_SIDE = BIG_PITCH ? 4.2 : 1.6;
const RUNOFF_END = BIG_PITCH ? 4.5 : GOAL_DEPTH + 1.6;
/** Ad boards: right at the edge in the small arena (the sim bounces the ball off them). */
const BOARD_SIDE = BIG_PITCH ? 3.2 : 0.18;
const BOARD_END = BIG_PITCH ? 3.6 : 0.18;
const BOARD_H = BIG_PITCH ? 0.9 : 0.8;
const STAND_SIDE = RUNOFF_SIDE + 1.2;
const STAND_END = RUNOFF_END + 1.2;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, aniso: number, repeat = false): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  }
  return t;
}

/** Seeded random for scenery, so the stadium looks the same every time. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Textures

function grassTexture(w: number, h: number, quality: 'low' | 'high', aniso: number): CanvasTexture {
  const px = quality === 'high' ? 2048 : 1024;
  const cw = px;
  const ch = Math.round((px * h) / w);
  const [c, g] = canvas(cw, ch);
  const k = cw / w;
  // Mowing stripes across the pitch, an even number so the halfway line sits on a seam.
  const bands = Math.max(10, Math.round(PITCH_W / (BIG_PITCH ? 5.25 : 5)) & ~1);
  const bw = PITCH_W / bands;
  const x0 = (w - PITCH_W) / 2;
  g.fillStyle = '#3f9b37';
  g.fillRect(0, 0, cw, ch);
  for (let i = -6; i < bands + 6; i++) {
    g.fillStyle = i % 2 === 0 ? '#46a83c' : '#3b9334';
    g.fillRect((x0 + i * bw) * k, 0, bw * k + 1, ch);
  }
  // Fine noise and soft wear, so close-ups don't look like flat paint.
  const r = rng(7);
  const img = g.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 14;
    d[i] += n * 0.6;
    d[i + 1] += n;
    d[i + 2] += n * 0.4;
  }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.06;
  for (let i = 0; i < 70; i++) {
    g.fillStyle = r() < 0.5 ? '#2e7a2a' : '#5bb84d';
    const rx = r() * cw;
    const ry = r() * ch;
    const rr = (2 + r() * 7) * k;
    g.beginPath();
    g.ellipse(rx, ry, rr, rr * (0.6 + r()), r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Goalmouth wear.
  g.globalAlpha = 0.12;
  for (const gx of [x0, x0 + PITCH_W]) {
    const grd = g.createRadialGradient(gx * k, (h / 2) * k, 0, gx * k, (h / 2) * k, 5 * k);
    grd.addColorStop(0, '#8a8a4a');
    grd.addColorStop(1, 'rgba(138,138,74,0)');
    g.fillStyle = grd;
    g.fillRect((gx - 6) * k, (h / 2 - 6) * k, 12 * k, 12 * k);
  }
  g.globalAlpha = 1;
  return tex(c, aniso);
}

const SPONSORS = ['DERBY DAY', 'TOP BINS', 'NUTMEG', 'PITCHSIDE', 'GOAL FM', 'HAT-TRICK', 'BOOTROOM', 'OFFSIDE CAFE', 'GAFFER', 'LAST MINUTE'];

/** Cartoon portrait for the boards: round face, hair, big grin. Original drawing, nobody in particular. */
function face(g: CanvasRenderingContext2D, x: number, y: number, r: number, skin: string, hair: string, seed: number) {
  g.save();
  g.translate(x, y);
  g.fillStyle = hair;
  g.beginPath();
  g.ellipse(0, -r * 0.25, r * 1.05, r * 0.95, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(0, 0, r * 0.85, r, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = hair;
  g.beginPath();
  g.ellipse(0, -r * 0.62, r * 0.82, r * 0.42, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = '#111';
  const eye = r * 0.12;
  g.beginPath();
  g.arc(-r * 0.3, -r * 0.12, eye, 0, Math.PI * 2);
  g.arc(r * 0.3, -r * 0.12, eye, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#111';
  g.lineWidth = r * 0.1;
  g.beginPath();
  if (seed % 2) g.arc(0, r * 0.2, r * 0.42, 0.15 * Math.PI, 0.85 * Math.PI);
  else {
    g.fillStyle = '#fff';
    g.arc(0, r * 0.22, r * 0.38, 0, Math.PI);
    g.closePath();
    g.fill();
  }
  g.stroke();
  g.restore();
}

function boardTexture(aniso: number): CanvasTexture {
  const panels = 8;
  const pw = 320;
  const [c, g] = canvas(pw * panels, 64);
  const schemes = [
    ['#ff6a00', '#111111', '#ffffff'],
    ['#111111', '#ff7a1a', '#ffffff'],
    ['#ffffff', '#ff5a00', '#111111'],
    ['#ff8c1a', '#ffffff', '#111111'],
  ];
  const skins = ['#f1c9a5', '#c68863', '#8d5a36', '#e8b98f'];
  const hairs = ['#2b1c12', '#111', '#a5733f', '#5a3a20'];
  for (let i = 0; i < panels; i++) {
    const [bg, fg, ac] = schemes[i % schemes.length];
    const x = i * pw;
    g.fillStyle = bg;
    g.fillRect(x, 0, pw, 64);
    g.fillStyle = ac;
    g.fillRect(x, 58, pw, 6);
    const withFace = i % 3 === 1;
    if (withFace) face(g, x + 36, 32, 22, skins[i % 4], hairs[(i + 1) % 4], i);
    g.fillStyle = fg;
    g.font = `italic 800 ${withFace ? 34 : 38}px 'Big Shoulders Display', 'Arial Narrow', Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(SPONSORS[i % SPONSORS.length], x + (withFace ? pw / 2 + 28 : pw / 2), 31);
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(x + pw - 2, 0, 2, 64);
  }
  return tex(c, aniso, true);
}

function netTexture(): CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 5;
  g.beginPath();
  // Diamond mesh reads better than squares at a distance.
  g.moveTo(0, 32);
  g.lineTo(32, 0);
  g.lineTo(64, 32);
  g.lineTo(32, 64);
  g.closePath();
  g.stroke();
  const t = tex(c, 4, true);
  return t;
}

function latticeTexture(): CanvasTexture {
  const [c, g] = canvas(64, 256);
  g.clearRect(0, 0, 64, 256);
  g.strokeStyle = '#fff';
  g.lineWidth = 7;
  g.strokeRect(3, -4, 58, 264);
  g.lineWidth = 4;
  for (let y = 0; y < 256; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(64, y + 64);
    g.moveTo(64, y);
    g.lineTo(0, y + 64);
    g.moveTo(0, y);
    g.lineTo(64, y);
    g.stroke();
  }
  return tex(c, 4, true);
}

function windowTexture(): CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  const r = rng(3);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const lit = r();
      g.fillStyle = lit < 0.15 ? '#c9d9e8' : lit < 0.3 ? '#6f8597' : '#3d4f5e';
      g.fillRect(x * 32 + 7, y * 32 + 8, 18, 16);
    }
  }
  return tex(c, 4, true);
}

function parkingTexture(): CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#7d8084';
  g.fillRect(0, 0, 256, 256);
  const r = rng(11);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = 'rgba(245,245,240,.85)';
  g.lineWidth = 3;
  for (let x = 0; x <= 256; x += 32) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 100);
    g.moveTo(x, 156);
    g.lineTo(x, 256);
    g.stroke();
  }
  return tex(c, 4, true);
}

// ---------------------------------------------------------------------------
// Crowd: one instanced draw per stand. A fan is three boxes (body, head,
// arms); the vertex shader bobs, jumps and raises arms by excitement.

const CROWD_VERT_PARS = `
attribute float aPart;
attribute float aSeed;
uniform float uTime;
uniform float uExcite;
`;
const CROWD_VERT = `
#include <begin_vertex>
{
  float sd = aSeed;
  float ph = uTime * (2.2 + sd * 2.4) + sd * 37.0;
  float keen = step(0.3, fract(sd * 13.7));
  float ex = uExcite * keen;
  float hop = max(0.0, sin(ph * 1.7)) * (0.03 + 0.3 * ex);
  transformed.y += hop;
  float arms = step(1.5, aPart);
  float up = clamp(0.15 + ex * 1.2 + 0.25 * step(0.92, fract(sd * 5.3)), 0.0, 1.0);
  transformed.y += arms * up * (0.42 + 0.06 * sin(ph * 2.3));
  transformed.x += arms * up * 0.08 * sin(ph * 1.3);
  transformed.x += sin(uTime * 0.6 + sd * 21.0) * 0.035;
}
`;
const CROWD_COLOR = `
#include <color_vertex>
{
  float t = fract(aSeed * 7.31);
  // Faces a little darker than life, so heads don't sparkle across the stand at broadcast distance.
  vec3 skinC = mix(vec3(0.93, 0.74, 0.58), vec3(0.36, 0.22, 0.13), t * t) * 0.8;
  float isHead = step(0.5, aPart) * step(aPart, 1.5);
  vColor.rgb = mix(vColor.rgb, skinC, isHead);
}
`;

const FLAG_VERT_PARS = `
attribute float aSeed;
uniform float uTime;
uniform float uExcite;
`;
const FLAG_VERT = `
#include <begin_vertex>
{
  // Pinned on the pole (x = 0), waving more toward the free edge; swung side to side when excited.
  float along = clamp(position.x / 1.3, 0.0, 1.0);
  float ph = uTime * (3.0 + aSeed * 2.0) + aSeed * 50.0;
  transformed.z += sin(ph + position.x * 3.2) * 0.22 * along;
  transformed.y += sin(ph * 0.7 + position.x * 2.0) * 0.06 * along;
  float swing = sin(uTime * (1.6 + aSeed) + aSeed * 9.0) * (0.25 + 0.6 * uExcite);
  float c = cos(swing);
  float s = sin(swing);
  transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
  transformed.y += 1.1 + max(0.0, sin(ph * 1.7)) * 0.2 * uExcite;
}
`;

interface CrowdMat {
  mat: Material;
  uniforms: { uTime: { value: number }; uExcite: { value: number } };
}

function crowdMaterial(kind: 'fan' | 'flag'): CrowdMat {
  const uniforms = { uTime: { value: 0 }, uExcite: { value: 0 } };
  const mat = new MeshLambertMaterial({ color: '#ffffff', side: kind === 'flag' ? DoubleSide : 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uExcite = uniforms.uExcite;
    if (kind === 'fan') {
      sh.vertexShader = CROWD_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', CROWD_VERT).replace('#include <color_vertex>', CROWD_COLOR);
    } else {
      sh.vertexShader = FLAG_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', FLAG_VERT);
    }
  };
  mat.customProgramCacheKey = () => `crowd-${kind}`;
  return { mat, uniforms };
}

function fanGeometry(): BufferGeometry {
  const parts: Part[] = [
    { geo: new BoxGeometry(0.44, 0.62, 0.3).translate(0, 0.31, 0), tags: { aPart: 0 } },
    { geo: new BoxGeometry(0.21, 0.24, 0.22).translate(0, 0.77, 0.01), tags: { aPart: 1 } },
    { geo: new BoxGeometry(0.62, 0.11, 0.12).translate(0, 0.55, 0.1), tags: { aPart: 2 } },
  ];
  return merge(parts, ['aPart']);
}

// ---------------------------------------------------------------------------
// Nets

class NetPanel {
  readonly mesh: Mesh;
  private base: Float32Array;
  private live = false;
  /**
   * `corners`: four goal-local points (bottom-left, bottom-right, top-right, top-left), `normal`
   * the outward direction it bulges.
   */
  constructor(
    corners: [Vector3, Vector3, Vector3, Vector3],
    private normal: Vector3,
    segU: number,
    segV: number,
    mat: Material,
    uvScale: [number, number],
  ) {
    const g = new PlaneGeometry(1, 1, segU, segV);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const [a, b, c, d] = corners;
    const p = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      // Bilinear patch.
      p.set(0, 0, 0)
        .addScaledVector(a, (1 - u) * (1 - v))
        .addScaledVector(b, u * (1 - v))
        .addScaledVector(c, u * v)
        .addScaledVector(d, (1 - u) * v);
      pos.setXYZ(i, p.x, p.y, p.z);
      uv.setXY(i, u * uvScale[0], v * uvScale[1]);
    }
    g.computeVertexNormals();
    this.base = new Float32Array(pos.array as Float32Array);
    this.mesh = new Mesh(g, mat);
    this.mesh.renderOrder = 2;
  }

  /** Displace by ripple impulses and by a ball pressing into the net (goal-local coordinates). */
  update(impulses: { at: Vector3; age: number; amp: number }[], ball: Vector3 | null, ballR: number): void {
    const active = impulses.length > 0 || ball !== null;
    if (!active && !this.live) return;
    const pos = this.mesh.geometry.attributes.position;
    const arr = pos.array as Float32Array;
    const n = this.normal;
    const base = this.base;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const y = base[i * 3 + 1];
      const z = base[i * 3 + 2];
      let d = 0;
      for (const im of impulses) {
        const dx = x - im.at.x;
        const dy = y - im.at.y;
        const dz = z - im.at.z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        d += im.amp * Math.exp(-r * r * 0.9) * Math.exp(-im.age * 2.6) * Math.cos(im.age * 11 - r * 3.2) + im.amp * 0.4 * Math.exp(-r * 0.8) * Math.exp(-im.age * 1.6) * Math.sin(im.age * 7 - r * 2.2);
      }
      if (ball) {
        // Signed distance of the ball surface beyond the panel's resting plane.
        const dx = ball.x - x;
        const dy = ball.y - y;
        const dz = ball.z - z;
        const along = dx * n.x + dy * n.y + dz * n.z + ballR;
        const lat2 = dx * dx + dy * dy + dz * dz - (along - ballR) * (along - ballR);
        if (along > -0.1) d += Math.max(0, along + 0.1) * Math.exp(-Math.max(0, lat2) * 4);
      }
      arr[i * 3] = x + n.x * d;
      arr[i * 3 + 1] = y + n.y * d;
      arr[i * 3 + 2] = z + n.z * d;
    }
    pos.needsUpdate = true;
    this.live = active;
  }
}

// ---------------------------------------------------------------------------

export function buildStadium(o: StadiumOptions): Stadium {
  const group = new Group();
  group.name = 'stadium';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const hi = o.quality === 'high';
  const home = o.teams[0];
  const away = o.teams[1];
  const r = rng(20250);

  // --- sky -------------------------------------------------------------------
  const skyMat = keep(
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new Color('#2f78d6') }, mid: { value: new Color('#7fb6ee') }, bottom: { value: new Color('#dbe9f5') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.7, h)) : mix(bottom, mid, smoothstep(-0.02, 0.12, h)); gl_FragColor = vec4(c, 1.0); }',
    }),
  );
  const sky = new Mesh(keep(new SphereGeometry(900, 24, 12)), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  group.add(sky);
  // A few chunky clouds.
  const cloudMat = keep(new MeshLambertMaterial({ color: '#ffffff', emissive: new Color('#c9d8ea'), emissiveIntensity: 0.55 } as Record<string, unknown>));
  const cloudGeo = keep(new IcosahedronGeometry(1, 1));
  for (let i = 0; i < (hi ? 9 : 0); i++) {
    const a = (i / 9) * Math.PI * 2 + r();
    const d = 420 + r() * 200;
    const cl = new Group();
    for (let k = 0; k < 4; k++) {
      const m = new Mesh(cloudGeo, cloudMat);
      m.position.set((k - 1.5) * 18 + r() * 10, r() * 6, r() * 10);
      m.scale.set(22 + r() * 16, 10 + r() * 6, 16 + r() * 8);
      cl.add(m);
    }
    cl.position.set(Math.cos(a) * d, 110 + r() * 80, Math.sin(a) * d);
    group.add(cl);
  }

  // --- ground: town, car park, verges ----------------------------------------
  const outerW = PITCH_W + 2 * (STAND_END + 40);
  const outerH = PITCH_H + 2 * (STAND_SIDE + 40);
  const parkTex = keep(parkingTexture());
  parkTex.repeat.set(outerW / 20, outerH / 20);
  const ground = new Mesh(keep(new PlaneGeometry(outerW, outerH)), keep(new MeshLambertMaterial({ map: parkTex })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  group.add(ground);
  const verge = new Mesh(keep(new PlaneGeometry(1600, 1600)), keep(new MeshLambertMaterial({ color: '#5d8f3e' })));
  verge.rotation.x = -Math.PI / 2;
  verge.position.y = -0.06;
  group.add(verge);

  // --- pitch -----------------------------------------------------------------
  const gw = PITCH_W + 2 * STAND_END;
  const gh = PITCH_H + 2 * STAND_SIDE;
  const grass = new Mesh(keep(new PlaneGeometry(gw, gh)), keep(new MeshLambertMaterial({ map: keep(grassTexture(gw, gh, o.quality, o.anisotropy)) })));
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  group.add(grass);

  // Markings, as geometry so they stay crisp at any zoom.
  const LW = 0.12;
  const Y = 0.012;
  const lines: Part[] = [];
  const seg = (pts: [number, number][], closed = false) => lines.push({ geo: ribbon(pts, LW, Y, closed) });
  const hw = HALF_W;
  const hh = HALF_H;
  seg([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], true);
  seg([[0, -hh], [0, hh]]);
  const centreR = CENTRE_R;
  seg(arcPoints(0, 0, centreR, 0, Math.PI * 2, 72));
  const spot = (x: number, z: number, rr = 0.16) => lines.push({ geo: ribbon(arcPoints(x, z, rr / 2, 0, Math.PI * 2, 12), rr, Y) });
  spot(0, 0, 0.22);
  const sixD = SIX_DEPTH;
  const sixW = SIX_W;
  const penD = PENALTY_SPOT;
  for (const s of [-1, 1]) {
    const gx = s * hw;
    const bx = gx - s * BOX_DEPTH;
    seg([[gx, -BOX_W / 2], [bx, -BOX_W / 2], [bx, BOX_W / 2], [gx, BOX_W / 2]]);
    const sx6 = gx - s * sixD;
    seg([[gx, -sixW / 2], [sx6, -sixW / 2], [sx6, sixW / 2], [gx, sixW / 2]]);
    spot(gx - s * penD, 0);
    // The "D": the part of the 9.15 m circle round the spot outside the box.
    const dr = RETREAT;
    const off = BOX_DEPTH - penD;
    if (dr > off) {
      const a = Math.acos(off / dr);
      const mid = s > 0 ? Math.PI : 0;
      seg(arcPoints(gx - s * penD, 0, dr, mid - a, mid + a, 24));
    }
    if (BIG_PITCH) {
      // Corner arcs, curving into the pitch.
      for (const t of [-1, 1]) {
        const a1 = Math.atan2(0, -s);
        const a2 = Math.atan2(-t, 0);
        let d = a2 - a1;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        seg(arcPoints(gx, t * hh, CORNER_R, a1, a1 + d, 10));
      }
    }
  }
  const lineMat = keep(new MeshLambertMaterial({ color: '#f4f6f1', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const lineMesh = new Mesh(keep(merge(lines)), lineMat);
  lineMesh.receiveShadow = true;
  group.add(lineMesh);

  // --- goals -----------------------------------------------------------------
  const postMat = keep(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.1 }));
  const netMat = keep(new MeshBasicMaterial({ map: keep(netTexture()), transparent: true, opacity: 0.75, side: DoubleSide, depthWrite: false, alphaTest: 0.02 }));
  const nets: NetPanel[][] = [];
  const goalGroups: Group[] = [];
  const POST_R = 0.06;
  const postGeo = keep(new CylinderGeometry(POST_R, POST_R, GOAL_BAR_H + POST_R, 10).translate(0, (GOAL_BAR_H + POST_R) / 2, 0));
  const barGeo = keep(new CylinderGeometry(POST_R, POST_R, GOAL_W + 2 * POST_R, 10).rotateX(Math.PI / 2));
  const strutGeo = keep(new CylinderGeometry(0.025, 0.025, 1, 6).translate(0, 0.5, 0));
  for (const side of [0, 1] as const) {
    const gg = new Group();
    gg.position.set(side === 0 ? -hw : hw, 0, 0);
    // Goal-local: +x is out of the pitch (into the net), z across.
    if (side === 0) gg.rotation.y = Math.PI;
    for (const z of [-GOAL_W / 2 - POST_R, GOAL_W / 2 + POST_R]) {
      const p = new Mesh(postGeo, postMat);
      p.position.set(POST_R, 0, z);
      p.castShadow = true;
      gg.add(p);
    }
    const bar = new Mesh(barGeo, postMat);
    bar.position.set(POST_R, GOAL_BAR_H + POST_R / 2, 0);
    bar.castShadow = true;
    gg.add(bar);
    const D = GOAL_DEPTH;
    const backTop = GOAL_BAR_H * 0.82;
    // Back stanchions.
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) {
      const s = new Mesh(strutGeo, postMat);
      s.position.set(D, 0, z);
      s.scale.y = backTop;
      gg.add(s);
      const s2 = new Mesh(strutGeo, postMat);
      s2.position.set(POST_R, GOAL_BAR_H, z);
      s2.scale.y = Math.hypot(D, GOAL_BAR_H - backTop);
      s2.rotation.z = -Math.atan2(D, GOAL_BAR_H - backTop) - Math.PI;
      s2.rotation.z = -(Math.PI / 2 + Math.atan2(GOAL_BAR_H - backTop, D));
      gg.add(s2);
    }
    const W2 = GOAL_W / 2;
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
    const density = 0.16; // metres per mesh cell
    const panels = [
      new NetPanel([v(D, 0, -W2), v(D, 0, W2), v(D, backTop, W2), v(D, backTop, -W2)], v(1, 0, 0), 16, 6, netMat, [GOAL_W / density / 4, backTop / density / 4]),
      new NetPanel([v(0.08, GOAL_BAR_H, -W2), v(0.08, GOAL_BAR_H, W2), v(D, backTop, W2), v(D, backTop, -W2)], v(0.25, 1, 0).normalize(), 16, 4, netMat, [GOAL_W / density / 4, D / density / 4]),
      new NetPanel([v(0.08, 0, -W2), v(D, 0, -W2), v(D, backTop, -W2), v(0.08, GOAL_BAR_H, -W2)], v(0, 0, -1), 5, 6, netMat, [D / density / 4, GOAL_BAR_H / density / 4]),
      new NetPanel([v(0.08, 0, W2), v(D, 0, W2), v(D, backTop, W2), v(0.08, GOAL_BAR_H, W2)], v(0, 0, 1), 5, 6, netMat, [D / density / 4, GOAL_BAR_H / density / 4]),
    ];
    for (const p of panels) {
      gg.add(p.mesh);
      disposables.push(p.mesh.geometry);
    }
    nets.push(panels);
    goalGroups.push(gg);
    group.add(gg);
  }
  const impulses: { at: Vector3; age: number; amp: number }[][] = [[], []];

  // --- ad boards -------------------------------------------------------------
  const boardTex = keep(boardTexture(o.anisotropy));
  const boardMat = keep(new MeshLambertMaterial({ map: boardTex, emissive: new Color('#ffffff'), emissiveMap: boardTex, emissiveIntensity: 0.45 } as Record<string, unknown>));
  const boardBack = keep(new MeshLambertMaterial({ color: '#6b7178' }));
  const boards = { far: new Group(), near: new Group(), left: new Group(), right: new Group() };
  const addBoard = (x0: number, z0: number, x1: number, z1: number) => {
    const side: keyof typeof boards = Math.abs(z0 - z1) < 0.01 ? (z0 < 0 ? 'far' : 'near') : x0 < 0 ? 'left' : 'right';
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.5) return;
    const g = new BoxGeometry(len, BOARD_H, 0.12);
    // Texture repeats every 12 m along the board.
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (len / 12), uv.getY(i));
    disposables.push(g);
    const m = new Mesh(g, [boardBack, boardBack, boardBack, boardBack, boardMat, boardBack] as unknown as Material);
    m.position.set((x0 + x1) / 2, BOARD_H / 2, (z0 + z1) / 2);
    m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    m.castShadow = true;
    m.receiveShadow = true;
    boards[side].add(m);
  };
  const bx = hw + BOARD_END;
  const bz = hh + BOARD_SIDE;
  // Far side faces the camera (+z): BoxGeometry's +z face is material 4, so draw it left to right.
  addBoard(-bx, -bz, bx, -bz);
  addBoard(bx, bz, -bx, bz);
  const gap = BIG_PITCH ? 0 : GOAL_W / 2 + 0.15;
  for (const s of [-1, 1]) {
    const x = s * bx;
    // Ends: leave the goal mouth open in the arena.
    if (gap > 0) {
      addBoard(x, s * -bz, x, s * -gap);
      addBoard(x, s * gap, x, s * bz);
    } else addBoard(x, -s * bz, x, s * bz);
  }
  group.add(boards.far, boards.near, boards.left, boards.right);

  // --- stands, crowd, flags --------------------------------------------------
  const concrete = keep(new MeshLambertMaterial({ vertexColors: true } as Record<string, unknown>));
  const roofMat = keep(new MeshStandardMaterial({ color: '#e7e9ec', roughness: 0.6, metalness: 0.2, side: DoubleSide }));
  const steelMat = keep(new MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.55, metalness: 0.2 }));
  const fanGeo = keep(fanGeometry());
  const flagGeo = keep(new PlaneGeometry(1.3, 0.85, 8, 1).translate(0.65, 0.42, 0));
  const poleGeo = keep(new CylinderGeometry(0.02, 0.02, 2.6, 4).translate(0, 1.3, 0));
  const fanMats: CrowdMat[] = [];
  const stands = {} as Record<'far' | 'near' | 'left' | 'right', Object3D>;
  const density = hi ? 0.86 : 0.32;
  const crowdColor = new Color();
  const tmpM = new Matrix4();
  const tmpQ = new Quaternion();
  const tmpP = new Vector3();
  const tmpS = new Vector3(1, 1, 1);
  const UP = new Vector3(0, 1, 0);

  // Crowd colours: very light kits (white, cream) would turn a stand into a white wall, so they are
  // knocked back, and everything is pulled toward a dark grey for less contrast.
  const grey = new Color('#4a4f57');
  const tone = (c: Color) => {
    const l = (c.r + c.g + c.b) / 3;
    if (l > 0.62) c.multiplyScalar(0.62 / l);
    return c.lerp(grey, 0.38);
  };
  const buildStand = (key: 'far' | 'near' | 'left' | 'right', fans: TeamSetup, rows: number, roof: boolean) => {
    const sg = new Group();
    sg.name = `stand-${key}`;
    const along = key === 'far' || key === 'near' ? PITCH_W + 2 * STAND_END - 2 : PITCH_H + 2 * STAND_SIDE - 2;
    const off = key === 'far' || key === 'near' ? hh + STAND_SIDE : hw + STAND_END;
    const ROW_D = 0.85;
    const RISE = 0.44;
    const FRONT = 0.9;
    // Stand-local: x along, z away from the pitch (positive), y up. Front wall at z = 0.
    const blocks: Part[] = [];
    const stepCol = tone(new Color(fans.primary)).lerp(new Color('#3a3f47'), 0.35);
    // Painted front wall, grey steps, lighter back and side walls.
    blocks.push({ geo: new BoxGeometry(along, FRONT, 0.4).translate(0, FRONT / 2, 0.2), color: [0.07, 0.16, 0.3] });
    for (let i = 0; i < rows; i++) {
      const top = FRONT + i * RISE;
      // Steps in a dark shade of the fans' colour, barely striped: empty places blend into the block.
      const k = i % 2 ? 0.5 : 0.45;
      blocks.push({ geo: new BoxGeometry(along, top, ROW_D).translate(0, top / 2, 0.4 + i * ROW_D + ROW_D / 2), color: [stepCol.r * k, stepCol.g * k, stepCol.b * k] });
    }
    const depth = 0.4 + rows * ROW_D;
    const backH = FRONT + rows * RISE + 2.2;
    blocks.push({ geo: new BoxGeometry(along, backH, 0.5).translate(0, backH / 2, depth + 0.25), color: [0.68, 0.7, 0.73] });
    // Side walls.
    for (const s of [-1, 1]) blocks.push({ geo: new BoxGeometry(0.4, backH, depth).translate((s * along) / 2, backH / 2, depth / 2), color: [0.68, 0.7, 0.73] });
    const shell = new Mesh(merge(blocks, [], true), concrete);
    disposables.push(shell.geometry);
    shell.castShadow = true;
    shell.receiveShadow = true;
    sg.add(shell);
    // Seat strip colour on the risers (thin boxes on each step front).
    const seats: Part[] = [];
    for (let i = 0; i < rows; i++) {
      const top = FRONT + i * RISE;
      seats.push({ geo: new BoxGeometry(along - 0.6, 0.22, 0.05).translate(0, top + 0.11, 0.4 + i * ROW_D + 0.1) });
    }
    // Seats in a dark shade of the fans' colour, so empty seats (a thin crowd on slow GPUs) blend
    // into the block instead of showing as a second pattern.
    const seatMat = keep(new MeshLambertMaterial({ color: tone(new Color(fans.primary)).multiplyScalar(0.42) }));
    const seatMesh = new Mesh(merge(seats), seatMat);
    disposables.push(seatMesh.geometry);
    seatMesh.receiveShadow = true;
    sg.add(seatMesh);

    if (roof) {
      const rh = backH + 4.5;
      const roofG = new BoxGeometry(along + 2, 0.25, depth + 3).translate(0, 0, (depth - 3) / 2);
      const rm = new Mesh(roofG, roofMat);
      disposables.push(roofG);
      rm.position.set(0, rh, 0);
      rm.rotation.x = -0.07;
      rm.castShadow = true;
      rm.receiveShadow = true;
      sg.add(rm);
      // Orange steel: posts at the back and a front truss.
      const posts: Part[] = [];
      for (let x = -along / 2; x <= along / 2 + 0.01; x += along / Math.max(2, Math.round(along / 18))) {
        posts.push({ geo: new BoxGeometry(0.35, rh, 0.35).translate(x, rh / 2, depth + 0.6) });
      }
      posts.push({ geo: new BoxGeometry(along + 2, 0.5, 0.4).translate(0, rh - 0.25, -1.4) });
      const pm = new Mesh(merge(posts), steelMat);
      disposables.push(pm.geometry);
      pm.castShadow = true;
      sg.add(pm);
    }

    // Fans.
    const seatsAlong = Math.floor((along - 1.2) / 0.56);
    const spots: [number, number, number, number][] = [];
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < seatsAlong; j++) {
        if (r() > density) continue;
        const x = -along / 2 + 0.6 + j * 0.56 + (r() - 0.5) * 0.12;
        spots.push([x, FRONT + i * RISE, 0.4 + i * ROW_D + ROW_D * 0.55, i]);
      }
    }
    const cm = crowdMaterial('fan');
    fanMats.push(cm);
    disposables.push(cm.mat);
    const im = new InstancedMesh(fanGeo, cm.mat, spots.length);
    const seeds = new Float32Array(spots.length);
    // A calm crowd (the owner's screenshot read as random bright blocks): each stand is cut into
    // sections about 14 m long, most in the fans' primary colour and some in their secondary, with a
    // few fans in muted everyday clothes. Colours are pulled toward a mid grey (less contrast) and
    // darken toward the back rows, under the roof, so the stand reads as a mass, not as noise.
    const section = 22;
    const nSec = Math.max(1, Math.round(along / section));
    const secCol = Array.from({ length: nSec }, (_, k) => (k % 3 === 1 ? fans.secondary : fans.primary));
    const casual = ['#30343b', '#3d434c', '#4b4f57', '#5a4a3c', '#2f3c52'];
    spots.forEach(([x, y, z, row], i) => {
      const sc = 0.92 + r() * 0.16;
      tmpQ.setFromAxisAngle(UP, Math.PI + (r() - 0.5) * 0.5);
      tmpP.set(x, y, z);
      tmpS.set(sc, sc, sc);
      tmpM.compose(tmpP, tmpQ, tmpS);
      im.setMatrixAt(i, tmpM);
      const sec = Math.min(nSec - 1, Math.max(0, Math.floor(((x + along / 2) / along) * nSec)));
      const pick = r();
      crowdColor.set(pick < 0.93 ? secCol[sec] : casual[Math.floor(r() * casual.length)]);
      tone(crowdColor);
      // Darker toward the back (under the roof), and only a slight per-fan variation.
      crowdColor.multiplyScalar((1 - 0.5 * (row / Math.max(1, rows - 1))) * (0.95 + r() * 0.06));
      im.setColorAt(i, crowdColor);
      seeds[i] = r();
    });
    // Per-instance seed lives on a per-stand geometry clone so stands can differ in size.
    const geo = fanGeo.clone();
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    disposables.push(geo);
    im.geometry = geo;
    im.receiveShadow = true;
    im.frustumCulled = false;
    sg.add(im);

    // Flags in the fans' colours, one every few metres along random rows.
    const nFlags = hi ? Math.round((along / 3.2) * (rows / 12)) : 0;
    const fm = crowdMaterial('flag');
    fanMats.push(fm);
    disposables.push(fm.mat);
    const flags = new InstancedMesh(flagGeo.clone(), fm.mat, nFlags);
    disposables.push(flags.geometry);
    const poles = new InstancedMesh(poleGeo, keep(new MeshLambertMaterial({ color: '#d9d9d9' })), nFlags);
    const fseeds = new Float32Array(nFlags);
    const flagCols = [fans.primary, fans.secondary, fans.primary, fans.primary];
    for (let i = 0; i < nFlags; i++) {
      const row = Math.floor(r() * rows);
      const x = -along / 2 + 1 + r() * (along - 2);
      tmpQ.setFromAxisAngle(UP, Math.PI + (r() - 0.5) * 0.8);
      tmpP.set(x, FRONT + row * RISE + 0.6, 0.4 + row * ROW_D + ROW_D * 0.5);
      tmpS.set(1, 1, 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      flags.setMatrixAt(i, tmpM);
      tmpP.y -= 0.6;
      tmpM.compose(tmpP, tmpQ, tmpS);
      poles.setMatrixAt(i, tmpM);
      crowdColor.set(flagCols[i % flagCols.length]);
      flags.setColorAt(i, tone(crowdColor));
      fseeds[i] = r();
    }
    flags.geometry.setAttribute('aSeed', new InstancedBufferAttribute(fseeds, 1));
    flags.frustumCulled = false;
    if (nFlags > 0) sg.add(flags, poles);

    // Place the stand: local +z points away from the pitch.
    if (key === 'far') {
      sg.position.set(0, 0, -off);
      sg.rotation.y = Math.PI;
    } else if (key === 'near') {
      sg.position.set(0, 0, off);
    } else if (key === 'left') {
      sg.position.set(-off, 0, 0);
      sg.rotation.y = -Math.PI / 2;
    } else {
      sg.position.set(off, 0, 0);
      sg.rotation.y = Math.PI / 2;
    }
    stands[key] = sg;
    group.add(sg);
    return cm;
  };
  const farRows = BIG_PITCH ? 18 : 13;
  const crowdHome = [buildStand('far', home, farRows, true), buildStand('near', home, farRows - 2, true), buildStand('left', home, farRows - 4, false)];
  const crowdAway = [buildStand('right', away, farRows - 4, false)];
  // Map each crowd material to which team it cheers for.
  const fanSide = new Map<Material, 0 | 1>();
  for (const c of crowdHome) fanSide.set(c.mat, 0);
  for (const c of crowdAway) fanSide.set(c.mat, 1);
  // Flags follow the fans of their stand: materials were pushed fan, flag, fan, flag...
  for (let i = 0; i < fanMats.length; i += 2) fanSide.set(fanMats[i + 1].mat, fanSide.get(fanMats[i].mat) ?? 0);

  // --- floodlight pylons -----------------------------------------------------
  const lattice = keep(latticeTexture());
  const pylonH = BIG_PITCH ? 46 : 34;
  lattice.repeat.set(2, pylonH / 4);
  const pylonMat = keep(new MeshLambertMaterial({ color: '#ff7a1a', map: lattice, transparent: false, alphaTest: 0.5, side: DoubleSide }));
  const lampMat = keep(new MeshBasicMaterial({ color: '#fffbe8' }));
  const headMat = keep(new MeshLambertMaterial({ color: '#2a2d31' }));
  const pylonGeo = keep(new CylinderGeometry(0.5, 1.6, pylonH, 4, 1, true).translate(0, pylonH / 2, 0));
  const headGeo = keep(new BoxGeometry(6, 3.4, 0.6));
  const lampGeo = keep(new PlaneGeometry(1.1, 0.7));
  for (const sxs of [-1, 1]) {
    for (const szs of [-1, 1]) {
      const pg = new Group();
      const px = sxs * (hw + STAND_END + 6);
      const pz = szs * (hh + STAND_SIDE + 6);
      pg.position.set(px, 0, pz);
      const tower = new Mesh(pylonGeo, pylonMat);
      tower.rotation.y = Math.PI / 4;
      tower.castShadow = true;
      pg.add(tower);
      const headG = new Group();
      headG.position.set(0, pylonH + 1, 0);
      // Local frame of the pylon group: the pitch centre is at (-px, 0, -pz).
      headG.lookAt(-px * 0.8, pylonH * 0.15, -pz * 0.8);
      const hm = new Mesh(headGeo, headMat);
      headG.add(hm);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          const l = new Mesh(lampGeo, lampMat);
          l.position.set(-2.2 + i * 1.47, -1.05 + j * 1.05, 0.31);
          headG.add(l);
        }
      }
      pg.add(headG);
      group.add(pg);
    }
  }

  // --- outside: cars, trees, buildings ---------------------------------------
  // Software renderers (low quality) skip the town: it is only seen in wide shots.
  if (hi) {
    const ringX = hw + STAND_END + 14;
    const ringZ = hh + STAND_SIDE + 12;
    // Cars in bays round the stadium.
    const carParts: Part[] = [
      { geo: new BoxGeometry(4.2, 0.75, 1.8).translate(0, 0.55, 0), color: [1, 1, 1] },
      { geo: new BoxGeometry(2.2, 0.6, 1.6).translate(-0.2, 1.2, 0), color: [0.55, 0.62, 0.7] },
      { geo: new BoxGeometry(0.7, 0.36, 1.86).translate(1.35, 0.25, 0), color: [0.08, 0.08, 0.08] },
      { geo: new BoxGeometry(0.7, 0.36, 1.86).translate(-1.35, 0.25, 0), color: [0.08, 0.08, 0.08] },
    ];
    const carGeo = keep(merge(carParts, [], true));
    const carSpots: [number, number, number][] = [];
    for (let row = 0; row < 3; row++) {
      for (let x = -ringX - 20; x <= ringX + 20; x += 2.6) {
        if (r() < 0.25) continue;
        carSpots.push([x, -(ringZ + 4 + row * 7.5), Math.PI / 2 + (row % 2) * Math.PI]);
        if (r() < 0.6) carSpots.push([x, ringZ + 10 + row * 7.5, Math.PI / 2 + (row % 2) * Math.PI]);
      }
    }
    for (let row = 0; row < 2; row++) {
      for (let z = -ringZ; z <= ringZ; z += 2.6) {
        if (r() < 0.3) continue;
        for (const s of [-1, 1]) carSpots.push([s * (ringX + 5 + row * 7.5), z, row % 2 ? 0 : Math.PI]);
      }
    }
    const carMat = keep(new MeshLambertMaterial({ vertexColors: true } as Record<string, unknown>));
    const cars = new InstancedMesh(carGeo, carMat, carSpots.length);
    const carCols = ['#c0392b', '#f5f5f5', '#1f1f1f', '#2e86de', '#7f8c8d', '#f1c40f', '#27ae60', '#d35400', '#bdc3c7', '#34495e'];
    carSpots.forEach(([x, z, a], i) => {
      tmpQ.setFromAxisAngle(UP, a + (r() - 0.5) * 0.08);
      tmpP.set(x, 0, z);
      tmpS.set(1, 1, 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      cars.setMatrixAt(i, tmpM);
      cars.setColorAt(i, crowdColor.set(carCols[Math.floor(r() * carCols.length)]));
    });
    cars.receiveShadow = true;
    group.add(cars);

    // Trees on the verges.
    const trunkGeo = keep(new CylinderGeometry(0.22, 0.3, 2.6, 5).translate(0, 1.3, 0));
    const crownGeo = keep(new IcosahedronGeometry(2.4, 0).translate(0, 4.4, 0));
    const coneGeo = keep(new ConeGeometry(2.1, 6, 7).translate(0, 5.2, 0));
    const treeSpots: [number, number, number][] = [];
    const treeR = Math.max(ringX + 32, ringZ + 34);
    for (let i = 0; i < (hi ? 150 : 70); i++) {
      const a = r() * Math.PI * 2;
      const d = treeR + r() * 40;
      treeSpots.push([Math.cos(a) * d * (ringX / treeR + 0.35), Math.sin(a) * d * (ringZ / treeR + 0.5), 0.8 + r() * 0.7]);
    }
    const trunks = new InstancedMesh(trunkGeo, keep(new MeshLambertMaterial({ color: '#6b4a2f' })), treeSpots.length);
    const crowns = new InstancedMesh(crownGeo, keep(new MeshLambertMaterial({ color: '#ffffff', flatShading: true } as Record<string, unknown>)), treeSpots.length);
    const cones = new InstancedMesh(coneGeo, keep(new MeshLambertMaterial({ color: '#ffffff', flatShading: true } as Record<string, unknown>)), treeSpots.length);
    let nCones = 0;
    let nCrowns = 0;
    treeSpots.forEach(([x, z, s], i) => {
      tmpQ.setFromAxisAngle(UP, r() * 6);
      tmpP.set(x, 0, z);
      tmpS.set(s, s * (0.9 + r() * 0.3), s);
      tmpM.compose(tmpP, tmpQ, tmpS);
      trunks.setMatrixAt(i, tmpM);
      const green = crowdColor.setHSL(0.25 + r() * 0.08, 0.45 + r() * 0.2, 0.25 + r() * 0.12);
      if (r() < 0.35) {
        cones.setMatrixAt(nCones, tmpM);
        cones.setColorAt(nCones++, green);
      } else {
        crowns.setMatrixAt(nCrowns, tmpM);
        crowns.setColorAt(nCrowns++, green);
      }
    });
    cones.count = nCones;
    crowns.count = nCrowns;
    group.add(trunks, crowns, cones);

    // Low town beyond: merged boxes with a window texture, UVs scaled to size.
    const winTex = keep(windowTexture());
    const blds: Part[] = [];
    const bldCols: [number, number, number][] = [
      [0.86, 0.8, 0.72],
      [0.75, 0.72, 0.7],
      [0.9, 0.88, 0.84],
      [0.72, 0.55, 0.45],
      [0.6, 0.66, 0.72],
    ];
    for (let i = 0; i < (hi ? 70 : 36); i++) {
      const a = r() * Math.PI * 2;
      const d = treeR + 45 + r() * 120;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d * 0.8;
      const w = 10 + r() * 18;
      const dd = 10 + r() * 14;
      const h = 6 + r() * (r() < 0.15 ? 30 : 12);
      const g = new BoxGeometry(w, h, dd);
      const uv = g.attributes.uv;
      const nor = g.attributes.normal;
      for (let k = 0; k < uv.count; k++) {
        const side = Math.abs(nor.getY(k)) > 0.5 ? 0 : 1;
        const horiz = Math.abs(nor.getX(k)) > 0.5 ? dd : w;
        uv.setXY(k, side ? (uv.getX(k) * horiz) / 6 : 0.02, side ? (uv.getY(k) * h) / 3.2 : 0.02);
      }
      place(g, x, h / 2, z, -a + Math.PI / 2);
      blds.push({ geo: g, color: bldCols[Math.floor(r() * bldCols.length)] });
    }
    const town = new Mesh(keep(merge(blds, [], true)), keep(new MeshLambertMaterial({ map: winTex, vertexColors: true } as Record<string, unknown>)));
    group.add(town);
  }

  // ---------------------------------------------------------------------------

  const local = new Vector3();
  const ballLocal = new Vector3();
  return {
    group,
    stands,
    boards,
    update(dt, time, s) {
      for (const m of fanMats) {
        m.uniforms.uTime.value = time;
        const side = fanSide.get(m.mat) ?? 0;
        m.uniforms.uExcite.value = clamp01(s.excite[side]);
      }
      // Nets: ripples and the ball pressing in.
      const BALL_VIS_R = 0.15;
      for (const side of [0, 1] as const) {
        const list = impulses[side];
        for (const im of list) im.age += dt;
        while (list.length && list[0].age > 2.4) list.shift();
        const gx = side === 0 ? -hw : hw;
        const out = side === 0 ? -1 : 1;
        // Ball in this goal's local frame (rotation by pi flips x and z).
        const bxl = (s.ball.x - gx) * out;
        const bzl = s.ball.y * out;
        let inside: Vector3 | null = null;
        if (bxl > -0.2 && bxl < GOAL_DEPTH + 0.5 && Math.abs(bzl) < GOAL_W / 2 + 0.5 && s.ball.z < GOAL_BAR_H + 0.4) inside = ballLocal.set(bxl, s.ball.z + BALL_VIS_R, bzl);
        for (const p of nets[side]) p.update(list, inside, BALL_VIS_R);
      }
    },
    ripple(side, at, strength) {
      const gg = goalGroups[side];
      local.copy(at);
      gg.worldToLocal(local);
      impulses[side].push({ at: local.clone(), age: 0, amp: Math.min(0.5, 0.12 + strength * 0.02) });
    },
    dispose() {
      group.traverse((obj) => {
        const m = obj as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
        const im = obj as InstancedMesh;
        if (im.isInstancedMesh) im.dispose();
      });
      for (const d of disposables) d.dispose();
    },
  };
}
