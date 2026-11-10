// The stadium: grass and markings, goals with nets that move, ad boards,
// stands with an instanced crowd and flags, floodlight pylons, sky, and a
// town outside (car park, trees, low buildings). Sized from the sim constants
// so the six-a-side arena and a full 105 × 68 pitch both work.

import { BOX_DEPTH, BOX_W, CENTRE_R, CORNER_R, GOAL_BAR_H, GOAL_DEPTH, GOAL_W, PENALTY_SPOT, PITCH_H, PITCH_W, RETREAT, SIX_DEPTH, SIX_W } from '../../sim/constants.ts';
import type { TeamSetup } from '../../sim/types.ts';
import { arcPoints, merge, place, ribbon, type Part } from './geo.ts';
import { BIG_PITCH, HALF_H, HALF_W, clamp01 } from './space.ts';
import { ATMOSPHERES, type Atmosphere } from './atmosphere.ts';
import {
  AdditiveBlending,
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
  LinearSRGBColorSpace,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from './three.ts';

export interface StadiumOptions {
  teams: [TeamSetup, TeamSetup];
  /** 0..1: crowd density, texture sizes and shadow casting for slow GPUs. */
  quality: 'low' | 'high';
  anisotropy: number;
  /** Time of day: sky, clouds, floodlights (atmosphere.ts). The afternoon when unset. */
  atmosphere?: Atmosphere;
}

export interface Stadium {
  group: Group;
  /** Stands keyed by side, so the camera can hide the one it looks through. */
  stands: Record<'far' | 'near' | 'left' | 'right', Object3D>;
  /** The ad boards along each side, so the camera can hide the ones it looks through (like the stands). */
  boards: Record<'far' | 'near' | 'left' | 'right', Object3D>;
  /** `still`: reduced motion: the crowd, flags and floodlights hold one pose. */
  update(dt: number, time: number, o: { excite: [number, number]; still?: boolean; ball: { x: number; y: number; z: number; speed: number } }): void;
  /** The floodlight heads, scene metres (for their shadows under the lights). */
  lights: Vector3[];
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

const smoothstep01 = (t: number): number => t * t * (3 - 2 * t);

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
  // Mowing stripes across the pitch, an even number so the halfway line sits on a seam. Natural
  // turf, yellow-green and soft-striped like the owner's Power Soccer references (drawn there at about
  // #82a052 to #a0c954); the old saturated #46a83c / #3b9334 read as cartoon green.
  const bands = Math.max(10, Math.round(PITCH_W / (BIG_PITCH ? 5.25 : 5)) & ~1);
  const bw = PITCH_W / bands;
  const x0 = (w - PITCH_W) / 2;
  g.fillStyle = '#86a24c';
  g.fillRect(0, 0, cw, ch);
  for (let i = -6; i < bands + 6; i++) {
    g.fillStyle = i % 2 === 0 ? '#90b055' : '#7e9945';
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
    g.fillStyle = r() < 0.5 ? '#74903f' : '#9cba5e';
    const rx = r() * cw;
    const ry = r() * ch;
    const rr = (2 + r() * 7) * k;
    g.beginPath();
    g.ellipse(rx, ry, rr, rr * (0.6 + r()), r() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Wear: scuffed goalmouths and penalty spots, the centre spot, and the touchlines trodden darker.
  g.globalAlpha = 1;
  const wear = (cx: number, cz: number, rad: number, a: number) => {
    const grd = g.createRadialGradient(cx * k, cz * k, 0, cx * k, cz * k, rad * k);
    grd.addColorStop(0, `rgba(138,128,72,${a})`);
    grd.addColorStop(1, 'rgba(138,128,72,0)');
    g.fillStyle = grd;
    g.fillRect((cx - rad) * k, (cz - rad) * k, 2 * rad * k, 2 * rad * k);
  };
  for (const s of [-1, 1]) {
    const gx = x0 + (s < 0 ? 0 : PITCH_W);
    wear(gx, h / 2, 6, 0.3);
    wear(gx - s * PENALTY_SPOT, h / 2, 2.4, 0.26);
  }
  wear(w / 2, h / 2, 1.8, 0.2);
  for (const z of [(h - PITCH_H) / 2, (h + PITCH_H) / 2]) {
    const grd = g.createLinearGradient(0, (z + (z < h / 2 ? 0 : -3)) * k, 0, (z + (z < h / 2 ? 3 : 0)) * k);
    grd.addColorStop(z < h / 2 ? 0 : 1, 'rgba(70,84,36,0.16)');
    grd.addColorStop(z < h / 2 ? 1 : 0, 'rgba(70,84,36,0)');
    g.fillStyle = grd;
    g.fillRect(x0 * k, (z < h / 2 ? z : z - 3) * k, PITCH_W * k, 3 * k);
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

/** One board panel: text, background, text colour, accent strip, and whether a cartoon face stands beside the text. */
type Panel = [string, string, string, string, boolean?];
const SCHEMES = [
  ['#ff6a00', '#111111', '#ffffff'],
  ['#111111', '#ff7a1a', '#ffffff'],
  ['#ffffff', '#ff5a00', '#111111'],
  ['#ff8c1a', '#ffffff', '#111111'],
];
/** Black or white ink, whichever reads on this colour. */
const ink = (hex: string) => {
  const c = new Color(hex);
  return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.45 ? '#111111' : '#ffffff';
};
/** A club's own board panel: its name in its colours. */
const clubPanel = (t: TeamSetup, flip = false): Panel => (flip ? [t.name.toUpperCase(), t.secondary, ink(t.secondary), t.primary] : [t.name.toUpperCase(), t.primary, ink(t.primary), t.secondary]);

/** Four fans' banners side by side (a quarter of the texture each): the club's name, a slogan, stripes, a crest. */
function bannerTexture(t: TeamSetup): CanvasTexture {
  const W = 256;
  const [c, g] = canvas(W * 4, 64);
  const name = t.name.toUpperCase();
  const short = name.split(/\s+/)[0];
  const texts = [name, `UP THE ${short}`, '', `${short} TILL I DIE`];
  for (let i = 0; i < 4; i++) {
    const x = i * W;
    const bg = i % 2 ? t.secondary : t.primary;
    const fg = i % 2 ? t.primary : t.secondary;
    g.fillStyle = bg;
    g.fillRect(x, 0, W, 64);
    if (i === 2) {
      // Stripes and a big ring: no words.
      g.fillStyle = fg;
      for (let k = 0; k < 8; k += 2) g.fillRect(x + (k * W) / 8, 0, W / 8, 64);
      g.strokeStyle = bg;
      g.lineWidth = 8;
      g.beginPath();
      g.arc(x + W / 2, 32, 22, 0, Math.PI * 2);
      g.stroke();
      continue;
    }
    g.fillStyle = fg;
    g.fillRect(x, 0, W, 5);
    g.fillRect(x, 59, W, 5);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let px = 34; px >= 14; px -= 2) {
      g.font = `800 ${px}px 'Big Shoulders Display', 'Arial Narrow', Arial, sans-serif`;
      if (g.measureText(texts[i]).width <= W - 20) break;
    }
    g.fillText(texts[i], x + W / 2, 33, W - 20);
  }
  return tex(c, 4);
}

function boardTexture(aniso: number, panels: Panel[], pw: number): CanvasTexture {
  const [c, g] = canvas(pw * panels.length, 64);
  const skins = ['#f1c9a5', '#c68863', '#8d5a36', '#e8b98f'];
  const hairs = ['#2b1c12', '#111', '#a5733f', '#5a3a20'];
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  panels.forEach(([text, bg, fg, ac, withFace], i) => {
    const x = i * pw;
    g.fillStyle = bg;
    g.fillRect(x, 0, pw, 64);
    g.fillStyle = ac;
    g.fillRect(x, 58, pw, 6);
    if (withFace) face(g, x + 36, 32, 22, skins[i % 4], hairs[(i + 1) % 4], i);
    g.fillStyle = fg;
    // Long club names shrink to fit their panel.
    for (let px = withFace ? 34 : 38; px >= 16; px -= 2) {
      g.font = `italic 800 ${px}px 'Big Shoulders Display', 'Arial Narrow', Arial, sans-serif`;
      if (g.measureText(text).width <= pw - (withFace ? 110 : 28)) break;
    }
    g.fillText(text, x + (withFace ? pw / 2 + 28 : pw / 2), 31, pw - (withFace ? 110 : 28)); // squeezed, never spilling into the next panel
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(x + pw - 2, 0, 2, 64);
  });
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

/** Profiled steel roof sheeting: mid-grey steel panels (dark enough to read against the sky in a tall portrait frame, where the roof fills the top) with a shadowed rib every repeat (one repeat is about 1.6 m of roof). */
function roofTexture(): CanvasTexture {
  const [c, g] = canvas(64, 16);
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#98a2ae');
  grad.addColorStop(0.45, '#adb6c0');
  grad.addColorStop(0.8, '#a0aab5');
  grad.addColorStop(1, '#939da9');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = 'rgba(30,38,50,.5)';
  g.fillRect(56, 0, 5, 16);
  g.fillStyle = 'rgba(255,255,255,.4)';
  g.fillRect(54, 0, 2, 16);
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

// The crowd is drawn as sprites: one quad per fan (two triangles, not the 36 of three boxes), cut from
// a painted atlas of poses (crowdAtlas). The atlas holds masks, not colours: red is the shirt, green the
// skin, full blue the hair and trousers, half blue a scarf, each shaded across the figure; the shader
// colours them per fan (shirt from the instance colour, skin and hair from its seed, the scarf in the
// club's second colour) and picks the pose: mostly seated when calm, standing, clapping, arms up and
// scarves aloft as the fans get going.

const CROWD_FRAMES = 6;
const CROWD_VERT_PARS = `
attribute float aSeed;
attribute float aSide;
attribute vec3 aSecond;
uniform float uTime;
uniform vec2 uExcite;
uniform float uFlash;
varying float vFlash;
varying vec3 vSkin;
varying vec3 vHair;
varying vec3 vSecond;
`;
const CROWD_VERT = `
#include <begin_vertex>
{
  float sd = aSeed;
  float ph = uTime * (2.2 + sd * 2.4) + sd * 37.0;
  float keen = step(0.3, fract(sd * 13.7));
  float exc = aSide > 0.5 ? uExcite.y : uExcite.x;
  float ex = exc * keen;
  float hop = max(0.0, sin(ph * 1.7)) * (0.02 + 0.22 * ex);
  // A wave round the stand when the fans are up.
  float wv = exc * smoothstep(0.3, 1.0, sin(uTime * 4.5 - instanceMatrix[3].x * 0.4));
  transformed.y += hop + wv * 0.1;
  transformed.x += sin(uTime * 0.6 + sd * 21.0) * 0.03;
  // A camera flash now and then, under the lights: a few in a stand at any moment, more when it erupts.
  float fr = fract(sd * 91.7 + uTime * (0.35 + fract(sd * 3.31) * 0.5));
  vFlash = uFlash * step(0.9965, fr);
  float t = fract(sd * 7.31);
  vSkin = mix(vec3(0.93, 0.74, 0.58), vec3(0.36, 0.22, 0.13), t * t) * 0.8;
  float hh = fract(sd * 3.77);
  vHair = hh < 0.6 ? vec3(0.05, 0.035, 0.025) : hh < 0.8 ? vec3(0.2, 0.12, 0.06) : hh < 0.9 ? vec3(0.55, 0.4, 0.2) : vec3(0.35, 0.35, 0.36);
  vSecond = aSecond;
}
`;
/** After the map's uv is set: pick the pose (a frame of the atlas) from the fan's mood and the time. */
const CROWD_UV = `
#include <uv_vertex>
{
  float sd = aSeed;
  float keen = step(0.3, fract(sd * 13.7));
  float exc = aSide > 0.5 ? uExcite.y : uExcite.x;
  float ex = exc * keen;
  float ph = uTime * (1.3 + fract(sd * 5.1)) + sd * 17.0;
  // Calm: most sit (two seated poses), a few stand or clap. Up: standing, clapping, arms up, scarves aloft.
  float calm = fract(sd * 2.71) < 0.78 ? (fract(sd * 9.3) < 0.7 ? 0.0 : 1.0) : (fract(sd * 6.1) < 0.6 ? 2.0 : 3.0);
  float pump = step(0.0, sin(ph * 3.0));
  float up = fract(sd * 4.13) < 0.45 ? 5.0 : mix(3.0, 4.0, pump);
  float noisy = clamp(ex * 1.6 - 0.25, 0.0, 1.0);
  float frame = step(fract(sd * 11.3), noisy) > 0.5 ? up : (ex > 0.25 ? 2.0 + step(0.5, fract(ph * 0.5)) : calm);
  #ifdef USE_MAP
  vMapUv.x = (vMapUv.x + frame) / ${CROWD_FRAMES}.0;
  #endif
}
`;
const CROWD_FRAG = `
{
  vec4 m = texture2D(map, vMapUv);
  float dark = smoothstep(0.62, 0.9, m.b);
  float scarf = (1.0 - dark) * smoothstep(0.2, 0.42, m.b);
  diffuseColor.rgb *= vColor.rgb * m.r + vSkin * m.g + vHair * dark + vSecond * scarf * 0.9;
  diffuseColor.a = m.a;
}
`;

const FLAG_VERT_PARS = `
attribute float aSeed;
attribute float aSide;
uniform float uTime;
uniform vec2 uExcite;
`;
const FLAG_VERT = `
#include <begin_vertex>
{
  // Pinned on the pole (x = 0), waving more toward the free edge; swung side to side when excited.
  float along = clamp(position.x / 1.3, 0.0, 1.0);
  float ph = uTime * (3.0 + aSeed * 2.0) + aSeed * 50.0;
  transformed.z += sin(ph + position.x * 3.2) * 0.22 * along;
  transformed.y += sin(ph * 0.7 + position.x * 2.0) * 0.06 * along;
  float exc = aSide > 0.5 ? uExcite.y : uExcite.x;
  float swing = sin(uTime * (1.6 + aSeed) + aSeed * 9.0) * (0.25 + 0.6 * exc);
  float c = cos(swing);
  float s = sin(swing);
  transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
  transformed.y += 1.1 + max(0.0, sin(ph * 1.7)) * 0.2 * exc;
}
`;

/** Shared by every stand: the time and how worked up each club's fans are (home, away). */
interface CrowdUniforms {
  uTime: { value: number };
  uExcite: { value: Vector2 };
  /** Camera flashes in the crowd (0 = none). */
  uFlash: { value: number };
}

function crowdMaterial(kind: 'fan' | 'flag', uniforms: CrowdUniforms, light = 1, atlas: CanvasTexture | null = null): Material {
  const mat = new MeshLambertMaterial({ color: new Color(light, light, light), side: kind === 'flag' || atlas ? DoubleSide : 0, ...(atlas ? { map: atlas, alphaTest: 0.4 } : {}) });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uExcite = uniforms.uExcite;
    sh.uniforms.uFlash = uniforms.uFlash;
    if (kind === 'fan') {
      sh.vertexShader = CROWD_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', CROWD_VERT).replace('#include <uv_vertex>', CROWD_UV);
      sh.fragmentShader =
        'varying float vFlash;\nvarying vec3 vSkin;\nvarying vec3 vHair;\nvarying vec3 vSecond;\n' +
        sh.fragmentShader
          .replace('#include <map_fragment>', '')
          .replace('#include <color_fragment>', CROWD_FRAG)
          .replace('#include <opaque_fragment>', 'outgoingLight += vec3(vFlash * 9.0) * step(0.5, texture2D(map, vMapUv).g);\n#include <opaque_fragment>');
    } else {
      sh.vertexShader = FLAG_VERT_PARS + sh.vertexShader.replace('#include <begin_vertex>', FLAG_VERT);
    }
  };
  mat.customProgramCacheKey = () => `crowd-${kind}`;
  return mat;
}

/** One fan: a quad 0.72 m wide and 1.8 m tall, feet at the origin, facing +z. */
function spriteGeometry(): BufferGeometry {
  return new PlaneGeometry(0.72, 1.8).translate(0, 0.9, 0);
}

/**
 * The crowd's poses, painted as masks (see CROWD_FRAMES above): 0 seated, 1 seated leaning on a knee,
 * 2 standing, 3 clapping, 4 both arms up, 5 a scarf held up over the head. 64 x 160 px a frame.
 */
function crowdAtlas(): CanvasTexture {
  const FW = 64;
  const FH = 160;
  const [c, g] = canvas(FW * CROWD_FRAMES, FH);
  const px = FH / 1.8; // pixels per metre
  // A part filled with its channel, shaded across (lit from the front, darker toward its edges).
  const fill = (ch: 'r' | 'g' | 'b' | 's', x0: number, x1: number) => {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    const col = (k: number) => (ch === 'r' ? `rgb(${k},0,0)` : ch === 'g' ? `rgb(0,${k},0)` : ch === 'b' ? 'rgb(0,0,255)' : 'rgb(0,0,120)');
    gr.addColorStop(0, col(150));
    gr.addColorStop(0.45, col(255));
    gr.addColorStop(1, col(170));
    g.fillStyle = gr;
  };
  const rrect = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  };
  const limb = (ch: 'r' | 'g' | 's', x0: number, y0: number, x1: number, y1: number, w: number) => {
    g.strokeStyle = ch === 'r' ? 'rgb(225,0,0)' : ch === 'g' ? 'rgb(0,225,0)' : 'rgb(0,0,120)';
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  for (let f = 0; f < CROWD_FRAMES; f++) {
    g.save();
    g.translate(f * FW, 0);
    const cx = FW / 2;
    const seated = f <= 1;
    // Heights in metres above the step: a seated fan's head is lower, the legs hidden by the row in front.
    const hipY = FH - (seated ? 0.45 : 0.95) * px;
    const shY = hipY - 0.52 * px;
    const headY = shY - 0.16 * px;
    const sw = 0.2 * px; // half shoulder width
    // Legs (standing): dark trousers.
    if (!seated) {
      fill('b', cx - sw, cx + sw);
      rrect(cx - sw * 0.8, hipY - 4, sw * 0.75, FH - hipY + 2, 4);
      rrect(cx + sw * 0.05, hipY - 4, sw * 0.75, FH - hipY + 2, 4);
    } else {
      fill('b', cx - sw, cx + sw);
      rrect(cx - sw * 0.85, hipY - 6, sw * 1.7, 0.22 * px, 5);
    }
    // Torso: the shirt, wider at the shoulders.
    fill('r', cx - sw, cx + sw);
    g.beginPath();
    g.moveTo(cx - sw, shY + 3);
    g.quadraticCurveTo(cx - sw, shY - 2, cx - sw + 6, shY - 2);
    g.lineTo(cx + sw - 6, shY - 2);
    g.quadraticCurveTo(cx + sw, shY - 2, cx + sw, shY + 3);
    g.lineTo(cx + sw * 0.82, hipY + 2);
    g.lineTo(cx - sw * 0.82, hipY + 2);
    g.closePath();
    g.fill();
    // Arms: sleeve then hand.
    const arm = (side: number, ex: number, ey: number, hx: number, hy: number) => {
      const sx = cx + side * (sw - 3);
      limb('r', sx, shY + 3, ex, ey, 8);
      limb('g', ex, ey, hx, hy, 6.5);
      g.fillStyle = 'rgb(0,230,0)';
      g.beginPath();
      g.arc(hx, hy, 3.6, 0, Math.PI * 2);
      g.fill();
    };
    if (f === 0 || f === 2) {
      for (const sd of [-1, 1]) arm(sd, cx + sd * (sw + 1), shY + 0.26 * px, cx + sd * (sw - 2), hipY - 2);
    } else if (f === 1) {
      arm(-1, cx - sw - 1, shY + 0.26 * px, cx - sw + 2, hipY - 2);
      arm(1, cx + sw + 2, shY + 0.24 * px, cx + 6, headY + 0.12 * px);
    } else if (f === 3) {
      for (const sd of [-1, 1]) arm(sd, cx + sd * (sw + 2), shY + 0.24 * px, cx + sd * 3, shY + 0.12 * px);
    } else if (f === 4) {
      for (const sd of [-1, 1]) arm(sd, cx + sd * (sw + 5), shY - 0.2 * px, cx + sd * (sw + 3), shY - 0.48 * px);
    } else {
      // Scarf held up taut between the hands, over the head.
      const hy = headY - 0.3 * px;
      g.strokeStyle = 'rgb(0,0,120)';
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(cx - sw - 4, hy);
      g.lineTo(cx + sw + 4, hy);
      g.stroke();
      for (const sd of [-1, 1]) arm(sd, cx + sd * (sw + 4), shY - 0.12 * px, cx + sd * (sw + 4), hy);
    }
    // Neck, head and hair.
    fill('g', cx - 7, cx + 7);
    g.fillRect(cx - 4, headY + 4, 8, shY - headY);
    fill('g', cx - 10, cx + 10);
    g.beginPath();
    g.ellipse(cx, headY - 2, 9.5, 11.5, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgb(0,0,255)';
    g.beginPath();
    g.ellipse(cx, headY - 8, 10, 7.5, 0, Math.PI, Math.PI * 2);
    g.fill();
    g.restore();
  }
  const t = tex(c, 4);
  // Masks, not colours: read as they are, no sRGB decoding.
  t.colorSpace = LinearSRGBColorSpace;
  return t;
}

function fanGeometry(): BufferGeometry {
  // Torso narrower at the hips than the shoulders; the head and the body shaded as if round (normals
  // pointing out from their middles), so a stand of boxes reads as people. No more triangles than boxes.
  const torso = new BoxGeometry(0.44, 0.62, 0.3).translate(0, 0.31, 0);
  const tp = torso.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const k = y < 0.3 ? 0.82 : 1;
    tp.setX(i, tp.getX(i) * k);
  }
  roundNormals(torso, 0, 0.36, 0, 0.6);
  const head = new BoxGeometry(0.21, 0.24, 0.22).translate(0, 0.77, 0.01);
  roundNormals(head, 0, 0.77, 0.01, 1);
  const parts: Part[] = [
    { geo: torso, tags: { aPart: 0 } },
    { geo: head, tags: { aPart: 1 } },
    { geo: new BoxGeometry(0.62, 0.11, 0.12).translate(0, 0.55, 0.1), tags: { aPart: 2 } },
  ];
  return merge(parts, ['aPart']);
}

/** Normals pointing away from a centre (with `vertical` of the vertical part kept): a box lit like a rounded shape. */
function roundNormals(g: BufferGeometry, cx: number, cy: number, cz: number, vertical: number): void {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) - cx;
    const y = (p.getY(i) - cy) * vertical;
    const z = p.getZ(i) - cz;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    // Half the box's own normal, half the round one: edges soften, faces still read.
    const bx = n.getX(i) * 0.4 + (x / l) * 0.6;
    const by = n.getY(i) * 0.4 + (y / l) * 0.6;
    const bz = n.getZ(i) * 0.4 + (z / l) * 0.6;
    const m = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    n.setXYZ(i, bx / m, by / m, bz / m);
  }
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
  const atmo = o.atmosphere ?? ATMOSPHERES.day;
  const home = o.teams[0];
  const away = o.teams[1];
  const r = rng(20250);

  // --- sky -------------------------------------------------------------------
  const skyMat = keep(
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new Color(atmo.sky[0]) }, mid: { value: new Color(atmo.sky[1]) }, bottom: { value: new Color(atmo.sky[2]) } },
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
  const cloudMat = keep(new MeshLambertMaterial({ color: atmo.clouds.color, emissive: new Color(atmo.clouds.emissive), emissiveIntensity: atmo.clouds.intensity } as Record<string, unknown>));
  // All puffs in one geometry: one draw call, not 36.
  const puffs: Part[] = [];
  for (let i = 0; i < (hi && atmo.clouds.show ? 9 : 0); i++) {
    const a = (i / 9) * Math.PI * 2 + r();
    const d = 420 + r() * 200;
    const puff: [number, number, number, number, number, number][] = [];
    for (let k = 0; k < 4; k++) puff.push([(k - 1.5) * 18 + r() * 10, r() * 6, r() * 10, 22 + r() * 16, 10 + r() * 6, 16 + r() * 8]);
    const cx = Math.cos(a) * d;
    const cy = 110 + r() * 80;
    const cz = Math.sin(a) * d;
    for (const [x, y, z, ax, ay, az] of puff) puffs.push({ geo: place(new IcosahedronGeometry(1, 1), cx + x, cy + y, cz + z, 0, ax, ay, az) });
  }
  if (puffs.length) group.add(new Mesh(keep(merge(puffs)), cloudMat));

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
  const verge = new Mesh(keep(new PlaneGeometry(1600, 1600)), keep(new MeshLambertMaterial({ color: '#7b9446' })));
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
  const netMat = keep(new MeshBasicMaterial({ map: keep(netTexture()), transparent: true, opacity: 0.75, side: DoubleSide, forceSinglePass: true, depthWrite: false, alphaTest: 0.02 }));
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
  // Sides: sponsors with both clubs' panels between them; each end carries its own club's name and colours.
  const boardMatOf = (panels: Panel[], pw: number) => {
    const map = keep(boardTexture(o.anisotropy, panels, pw));
    // LED boards: they glow, more so under the lights (and bloom there).
    return keep(new MeshLambertMaterial({ map, emissive: new Color('#ffffff'), emissiveMap: map, emissiveIntensity: atmo.tod === 'night' ? 1.4 : atmo.tod === 'dusk' ? 0.8 : 0.45 } as Record<string, unknown>));
  };
  const boardMats = {
    far: boardMatOf(Array.from({ length: 8 }, (_, i): Panel => (i % 4 === 1 ? clubPanel(home) : i % 4 === 3 ? clubPanel(away) : [SPONSORS[i % SPONSORS.length], ...(SCHEMES[i % 4] as [string, string, string]), i === 4])), 320),
    left: boardMatOf([clubPanel(home), clubPanel(home, true), clubPanel(home), clubPanel(home, true)], 640),
    right: boardMatOf([clubPanel(away), clubPanel(away, true), clubPanel(away), clubPanel(away, true)], 640),
  };
  // After a goal the side boards flash the scorers' name in their colours (Stadium.update).
  const goalPanels = (t: TeamSetup): Panel[] => Array.from({ length: 8 }, (_, i): Panel => (i % 2 === 0 ? ['GOAL!', t.primary, ink(t.primary), t.secondary] : clubPanel(t, true)));
  const goalMaps = [keep(boardTexture(o.anisotropy, goalPanels(home), 320)), keep(boardTexture(o.anisotropy, goalPanels(away), 320))];
  const adMap = boardMats.far.map as CanvasTexture;
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
    const m = new Mesh(g, [boardBack, boardBack, boardBack, boardBack, side === 'left' || side === 'right' ? boardMats[side] : boardMats.far, boardBack] as unknown as Material);
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
  // Under the lights the stands sit in the floodlights' spill, darker than the pitch they frame.
  const standK = atmo.stands;
  const concrete = keep(new MeshLambertMaterial({ vertexColors: true, color: new Color(standK, standK, standK) } as Record<string, unknown>));
  // Ribbed steel sheeting on top: a plain pale slab read as a blank grey band across the top of an upright phone's picture.
  const roofMat = keep(new MeshStandardMaterial({ color: '#ffffff', map: keep(roofTexture()), roughness: 0.6, metalness: 0.2, side: DoubleSide }));
  // The roof's leading edge: a dark fascia that gives it a crisp front line seen from any camera.
  const fasciaMat = keep(new MeshStandardMaterial({ color: '#232a36', roughness: 0.5, metalness: 0.3 }));
  // The underside, seen from the pitch under a tall upright frame (a phone held upright): a shaded steel soffit, not a
  // flat pale slab that read as a blank band across the top of the picture.
  const soffitMat = keep(new MeshStandardMaterial({ color: '#3a4250', roughness: 0.8, metalness: 0.25, side: DoubleSide }));
  // BoxGeometry face order: +x, -x, +y (top), -y (underside), +z, -z.
  const roofMats = [roofMat, roofMat, roofMat, soffitMat, roofMat, roofMat];
  const steelMat = keep(new MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.55, metalness: 0.2 }));
  const fanGeo = keep(spriteGeometry());
  const crowdTex = keep(crowdAtlas());
  const flagGeo = keep(new PlaneGeometry(1.3, 0.85, 8, 1).translate(0.65, 0.42, 0));
  const poleGeo = keep(new CylinderGeometry(0.02, 0.02, 2.6, 4).translate(0, 1.3, 0));
  const crowdU: CrowdUniforms = { uTime: { value: 0 }, uExcite: { value: new Vector2() }, uFlash: { value: 0 } };
  const lit = new Vector2();
  const stands = {} as Record<'far' | 'near' | 'left' | 'right', Object3D>;
  const density = hi ? 0.9 : 0.55;
  const crowdColor = new Color();
  const tmpM = new Matrix4();
  const tmpM2 = new Matrix4();
  const tmpQ = new Quaternion();
  const tmpP = new Vector3();
  const tmpS = new Vector3(1, 1, 1);
  const UP = new Vector3(0, 1, 0);

  // Crowd colours: very light kits (white, cream) would turn a stand into a white wall, so they are
  // knocked back, and everything is pulled toward a dark grey for less contrast.
  const grey = new Color('#4a4f57');
  const GREY_K = 0.26;
  const tone = (c: Color) => {
    const l = (c.r + c.g + c.b) / 3;
    if (l > 0.62) c.multiplyScalar(0.62 / l);
    return c.lerp(grey, GREY_K);
  };
  // Which club's fan sits at stand-local x: the left end is the home end, the right the away end, and
  // the away fans spill into the right-hand corners of the two long stands.
  const teamAt = (key: 'far' | 'near' | 'left' | 'right', x: number, along: number): 0 | 1 => {
    if (key === 'left' || key === 'right') return key === 'right' ? 1 : 0;
    const wf = (key === 'far' ? -x : x) / along + 0.5;
    return r() < (wf - 0.6) / 0.3 ? 1 : 0;
  };
  /** `split`: a second tier starts at this row (0: one tier), steeper, behind a balcony front with an LED ribbon. */
  // LED ribbons along the upper tiers' balconies: the club's panels and the sponsors', scrolling slowly (Stadium.update).
  const ribbons: MeshLambertMaterial[] = [];
  const ribbonMat = (t: TeamSetup): MeshLambertMaterial => {
    const panels: Panel[] = Array.from({ length: 8 }, (_, i): Panel => (i % 2 === 0 ? clubPanel(t, i % 4 === 2) : [SPONSORS[(i + 3) % SPONSORS.length], ...(SCHEMES[(i + 1) % 4] as [string, string, string]), false]));
    const map = keep(boardTexture(o.anisotropy, panels, 320));
    const m = keep(new MeshLambertMaterial({ map, emissive: new Color('#ffffff'), emissiveMap: map, emissiveIntensity: atmo.tod === 'night' ? 1.3 : atmo.tod === 'dusk' ? 0.75 : 0.4 } as Record<string, unknown>));
    ribbons.push(m);
    return m;
  };
  const buildStand = (key: 'far' | 'near' | 'left' | 'right', fans: TeamSetup, rows: number, roof: boolean, split = 0) => {
    const sg = new Group();
    sg.name = `stand-${key}`;
    const along = key === 'far' || key === 'near' ? PITCH_W + 2 * STAND_END - 2 : PITCH_H + 2 * STAND_SIDE - 2;
    const off = key === 'far' || key === 'near' ? hh + STAND_SIDE : hw + STAND_END;
    const ROW_D = 0.85;
    const RISE = 0.44;
    const FRONT = 0.9;
    const RISE2 = 0.6;
    /** Height of the step of row i: the upper tier rises more steeply, from a walkway a step up behind the balcony. */
    const topAt = (i: number) => (split > 0 && i >= split ? FRONT + split * RISE + 0.5 + (i - split) * RISE2 : FRONT + i * RISE);
    /** Rows with fans in them: not the walkway row at the foot of the upper tier. */
    const seated = (i: number) => !(split > 0 && i === split);
    // Stand-local: x along, z away from the pitch (positive), y up. Front wall at z = 0.
    const blocks: Part[] = [];
    const stepCol = tone(new Color(fans.primary)).lerp(new Color('#3a3f47'), 0.35);
    // Painted front wall, grey steps, lighter back and side walls.
    blocks.push({ geo: new BoxGeometry(along, FRONT, 0.4).translate(0, FRONT / 2, 0.2), color: [0.07, 0.16, 0.3] });
    for (let i = 0; i < rows; i++) {
      const top = topAt(i);
      // Steps in a dark shade of the fans' colour, barely striped: empty places blend into the block.
      const k = i % 2 ? 0.66 : 0.62;
      blocks.push({ geo: new BoxGeometry(along, top, ROW_D).translate(0, top / 2, 0.4 + i * ROW_D + ROW_D / 2), color: [stepCol.r * k, stepCol.g * k, stepCol.b * k] });
    }
    const depth = 0.4 + rows * ROW_D;
    const backH = topAt(rows) + 2.2;
    blocks.push({ geo: new BoxGeometry(along, backH, 0.5).translate(0, backH / 2, depth + 0.25), color: [0.68, 0.7, 0.73] });
    // Side walls.
    for (const s of [-1, 1]) blocks.push({ geo: new BoxGeometry(0.4, backH, depth).translate((s * along) / 2, backH / 2, depth / 2), color: [0.68, 0.7, 0.73] });
    const shell = new Mesh(merge(blocks, [], true), concrete);
    disposables.push(shell.geometry);
    shell.castShadow = true;
    shell.receiveShadow = true;
    sg.add(shell);
    // The upper tier's balcony front: a wall at the walkway with an LED ribbon along it.
    if (split > 0) {
      const z = 0.4 + split * ROW_D;
      const y0 = topAt(split);
      const front = new BoxGeometry(along, 1.05, 0.3).translate(0, y0 + 0.45, z - 0.05);
      // The face toward the pitch (-z) is material 5 of a BoxGeometry: the ribbon goes there.
      const fm = new Mesh(front, [concrete, concrete, concrete, concrete, concrete, ribbonMat(fans)] as unknown as Material);
      const uvF = front.attributes.uv;
      for (let i = 0; i < uvF.count; i++) uvF.setX(i, uvF.getX(i) * (along / 12));
      disposables.push(front);
      fm.castShadow = true;
      fm.receiveShadow = true;
      sg.add(fm);
    }
    // Seat strip colour on the risers (thin boxes on each step front).
    const seats: Part[] = [];
    for (let i = 0; i < rows; i++) {
      if (!seated(i)) continue;
      const top = topAt(i);
      seats.push({ geo: new BoxGeometry(along - 0.6, 0.22, 0.05).translate(0, top + 0.11, 0.4 + i * ROW_D + 0.1) });
    }
    // Seats in a dark shade of the fans' colour, so empty seats (a thin crowd on slow GPUs) blend
    // into the block instead of showing as a second pattern.
    const seatMat = keep(new MeshLambertMaterial({ color: tone(new Color(fans.primary)).multiplyScalar(0.7) }));
    const seatMesh = new Mesh(merge(seats), seatMat);
    disposables.push(seatMesh.geometry);
    seatMesh.receiveShadow = true;
    sg.add(seatMesh);

    if (roof) {
      const rh = backH + 4.5;
      const roofG = new BoxGeometry(along + 2, 0.25, depth + 3).translate(0, 0, (depth - 3) / 2);
      // One texture repeat per 1.6 m along the stand, so the ribs keep their spacing on every stand.
      const uv = roofG.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * ((along + 2) / 1.6));
      const rm = new Mesh(roofG, roofMats);
      const fasciaG = new BoxGeometry(along + 2.2, 0.8, 0.3).translate(0, -0.2, -3);
      rm.add(new Mesh(fasciaG, fasciaMat));
      disposables.push(roofG, fasciaG);
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

    // Banners hung over the front wall of the stand facing the camera, in the fans' colours.
    if (key === 'far' && hi) {
      const nB = 4;
      const bw = Math.min(11, along / (nB * 1.8));
      const bannerParts: Part[] = [];
      for (let b = 0; b < nB; b++) {
        const x = -along / 2 + (along * (b + 0.5)) / nB + (r() - 0.5) * 3;
        const gB = new PlaneGeometry(bw, 1.35).rotateY(Math.PI).translate(x, 1.0, -0.03);
        // Each banner its own quarter of the texture: four designs.
        const uvB = gB.attributes.uv;
        for (let i = 0; i < uvB.count; i++) uvB.setX(i, (b % 4) / 4 + uvB.getX(i) / 4);
        bannerParts.push({ geo: gB });
      }
      const bm = new Mesh(merge(bannerParts), keep(new MeshLambertMaterial({ map: keep(bannerTexture(fans)), side: DoubleSide })));
      disposables.push(bm.geometry);
      bm.receiveShadow = true;
      sg.add(bm);
    }

    // Fans.
    const seatsAlong = Math.floor((along - 1.2) / 0.56);
    const spots: [number, number, number, number, 0 | 1][] = [];
    for (let i = 0; i < rows; i++) {
      if (!seated(i)) continue;
      for (let j = 0; j < seatsAlong; j++) {
        if (r() > density) continue;
        const x = -along / 2 + 0.6 + j * 0.56 + (r() - 0.5) * 0.12;
        spots.push([x, topAt(i), 0.4 + i * ROW_D + ROW_D * 0.55, i, teamAt(key, x, along)]);
      }
    }
    const cm = crowdMaterial('fan', crowdU, standK, crowdTex);
    disposables.push(cm);
    const im = new InstancedMesh(fanGeo, cm, spots.length);
    const seeds = new Float32Array(spots.length);
    const sides = new Float32Array(spots.length);
    const seconds = new Float32Array(spots.length * 3);
    // A calm crowd (the owner's screenshot read as random bright blocks; then as alternating stripes
    // of primary and secondary sections): fans are mostly in the primary colour, some in the secondary
    // and a few in muted everyday clothes, mixed seat by seat so a stand reads as one mass of its
    // team's colour, as in the Power Soccer references. Colours are pulled toward a mid grey (less
    // contrast) and darken toward the back rows, under the roof.
    const casual = ['#30343b', '#3d434c', '#4b4f57', '#5a4a3c', '#2f3c52'];
    const secondTint = new Color();
    spots.forEach(([x, y, z, row, team], i) => {
      const kit = o.teams[team];
      const sc = 0.92 + r() * 0.16;
      tmpQ.setFromAxisAngle(UP, Math.PI + (r() - 0.5) * 0.5);
      tmpP.set(x, y, z);
      tmpS.set(sc, sc, sc);
      tmpM.compose(tmpP, tmpQ, tmpS);
      im.setMatrixAt(i, tmpM);
      const pick = r();
      if (pick < 0.78) crowdColor.set(kit.primary);
      // The secondary colour, part-way to the primary: scattered seat by seat at full contrast it speckled.
      else if (pick < 0.92) crowdColor.set(kit.secondary).lerp(secondTint.set(kit.primary), 0.4);
      else crowdColor.set(casual[Math.floor(r() * casual.length)]);
      tone(crowdColor);
      // Darker toward the back (under the roof), and only a slight per-fan variation.
      crowdColor.multiplyScalar((1 - 0.5 * (row / Math.max(1, rows - 1))) * (0.95 + r() * 0.06));
      im.setColorAt(i, crowdColor);
      secondTint.set(kit.secondary);
      tone(secondTint);
      seconds.set([secondTint.r, secondTint.g, secondTint.b], i * 3);
      seeds[i] = r();
      sides[i] = team;
    });
    // Per-instance seed lives on a per-stand geometry clone so stands can differ in size.
    const geo = fanGeo.clone();
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aSide', new InstancedBufferAttribute(sides, 1));
    geo.setAttribute('aSecond', new InstancedBufferAttribute(seconds, 3));
    disposables.push(geo);
    im.geometry = geo;
    im.receiveShadow = true;
    im.frustumCulled = false;
    sg.add(im);

    // Flags in the fans' colours, one every 8 m or so along random rows (one every 3 m was a wall of
    // waving rectangles over the crowd).
    const nFlags = hi ? Math.round((along / 8) * (rows / 12)) : 0;
    const fm = crowdMaterial('flag', crowdU, standK);
    disposables.push(fm);
    const flags = new InstancedMesh(flagGeo.clone(), fm, nFlags);
    disposables.push(flags.geometry);
    const poles = new InstancedMesh(poleGeo, keep(new MeshLambertMaterial({ color: '#d9d9d9' })), nFlags);
    const fseeds = new Float32Array(nFlags);
    const fsides = new Float32Array(nFlags);
    for (let i = 0; i < nFlags; i++) {
      const row = Math.floor(r() * rows);
      const x = -along / 2 + 1 + r() * (along - 2);
      tmpQ.setFromAxisAngle(UP, Math.PI + (r() - 0.5) * 0.8);
      tmpP.set(x, topAt(row) + 0.6, 0.4 + row * ROW_D + ROW_D * 0.5);
      tmpS.set(1, 1, 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      flags.setMatrixAt(i, tmpM);
      tmpP.y -= 0.6;
      tmpM.compose(tmpP, tmpQ, tmpS);
      poles.setMatrixAt(i, tmpM);
      const team = teamAt(key, x, along);
      const kit = o.teams[team];
      crowdColor.set(i % 4 === 1 ? kit.secondary : kit.primary);
      flags.setColorAt(i, tone(crowdColor));
      fseeds[i] = r();
      fsides[i] = team;
    }
    flags.geometry.setAttribute('aSeed', new InstancedBufferAttribute(fseeds, 1));
    flags.geometry.setAttribute('aSide', new InstancedBufferAttribute(fsides, 1));
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
  };
  // The stand facing the camera has two tiers; the ends are deeper than they were.
  const farRows = BIG_PITCH ? 18 : 13;
  buildStand('far', home, BIG_PITCH ? farRows + 13 : farRows, true, BIG_PITCH ? farRows - 1 : 0);
  buildStand('near', home, farRows - 2, true);
  buildStand('left', home, farRows - (BIG_PITCH ? 1 : 4), false);
  buildStand('right', away, farRows - (BIG_PITCH ? 1 : 4), false);

  // --- dugouts, photographers ------------------------------------------------
  // Two dugouts on the far touchline either side of halfway, a curved clear roof over a bench of
  // substitutes in their club's colours; photographers crouched behind each goal line.
  if (BIG_PITCH) {
    // Bench shells and the photographers' cameras: one draw, coloured per vertex.
    const shellMat = keep(new MeshLambertMaterial({ vertexColors: true } as Record<string, unknown>));
    const SHELL: [number, number, number] = [0.14, 0.17, 0.21];
    const roofClear = keep(new MeshStandardMaterial({ color: '#cfe6ff', roughness: 0.15, metalness: 0, transparent: true, opacity: 0.35, side: DoubleSide, depthWrite: false }));
    const benchParts: Part[] = [];
    const roofParts: Part[] = [];
    const subs: [number, number, 0 | 1][] = [];
    const DUG_L = 7;
    const dz = -(hh + 2.2);
    for (const side of [-1, 1] as const) {
      const cx = side * 9;
      // Back wall, ends and the bench.
      benchParts.push({ geo: new BoxGeometry(DUG_L, 1.5, 0.12).translate(cx, 0.75, dz - 0.65), color: SHELL });
      for (const e of [-1, 1]) benchParts.push({ geo: new BoxGeometry(0.1, 1.5, 1.3).translate(cx + (e * DUG_L) / 2, 0.75, dz), color: SHELL });
      benchParts.push({ geo: new BoxGeometry(DUG_L - 0.3, 0.45, 0.5).translate(cx, 0.225, dz - 0.35), color: [0.5, 0.08, 0.08] });
      // The roof: a quarter-cylinder of clear plastic over the bench.
      roofParts.push({ geo: new CylinderGeometry(1.3, 1.3, DUG_L, 14, 1, true, Math.PI, Math.PI / 2).rotateZ(Math.PI / 2).translate(cx, 1.5 - 1.3 + 1.3, dz - 0.65 + 0) });
      for (let k = 0; k < 9; k++) subs.push([cx - DUG_L / 2 + 0.6 + k * 0.72, dz - 0.3, side < 0 ? 0 : 1]);
    }
    const clear = new Mesh(keep(merge(roofParts)), roofClear);
    clear.renderOrder = 2;
    group.add(clear);
    // Substitutes and photographers: the crowd's figure, seated or crouched, in plain lit colours.
    const peopleMat = keep(new MeshLambertMaterial({ color: '#ffffff' }));
    const shooters: [number, number][] = [];
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 7; k++) {
        const z = (k - 3) * 2.4 + (k >= 3 ? 1.4 : -1.4) * (Math.abs(k - 3) < 1 ? 0 : 1);
        if (Math.abs(z) < GOAL_W / 2 + 1.2) continue;
        shooters.push([sx * (hw + 1.6 + (k % 2) * 0.5), z]);
      }
    }
    const people = new InstancedMesh(keep(fanGeometry()), peopleMat, subs.length + shooters.length);
    let n = 0;
    subs.forEach(([x, z, team]) => {
      tmpQ.setFromAxisAngle(UP, 0);
      tmpP.set(x, 0.12, z);
      tmpS.set(0.95, 0.95, 0.95);
      people.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
      // Training tops: the club's colour, darkened.
      people.setColorAt(n++, crowdColor.set(o.teams[team].primary).multiplyScalar(0.55));
    });
    for (const [x, z] of shooters) {
      // Facing the pitch, crouched low behind the boards' line.
      tmpQ.setFromAxisAngle(UP, x < 0 ? Math.PI / 2 : -Math.PI / 2);
      tmpP.set(x, -0.18, z);
      tmpS.set(0.9, 0.8, 0.9);
      people.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
      people.setColorAt(n++, crowdColor.set(r() < 0.5 ? '#ff7a1a' : '#e8e04a'));
      // Camera body and a long lens pointed at the play.
      const out = x < 0 ? 1 : -1;
      benchParts.push({ geo: new BoxGeometry(0.16, 0.14, 0.14).translate(x + out * 0.18, 0.55, z), color: [0.03, 0.03, 0.035] });
      benchParts.push({ geo: new CylinderGeometry(0.05, 0.06, 0.42, 6).rotateZ(Math.PI / 2).translate(x + out * 0.45, 0.55, z), color: [0.03, 0.03, 0.035] });
    }
    people.count = n;
    people.castShadow = true;
    group.add(people);
    const bench = new Mesh(keep(merge(benchParts, [], true)), shellMat);
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);
  }

  // --- floodlight pylons -----------------------------------------------------
  const lattice = keep(latticeTexture());
  const pylonH = BIG_PITCH ? 46 : 34;
  lattice.repeat.set(2, pylonH / 4);
  const pylonMat = keep(new MeshLambertMaterial({ color: '#ff7a1a', map: lattice, transparent: false, alphaTest: 0.5, side: DoubleSide }));
  // Brighter than white when the lights are on, so the lamp faces bloom (post.ts) and read as lit.
  const lampMat = keep(new MeshBasicMaterial({ color: new Color('#fffbe8').multiplyScalar(atmo.lamps), fog: false }));
  const headMat = keep(new MeshLambertMaterial({ color: '#2a2d31' }));
  const pylonGeo = keep(new CylinderGeometry(0.5, 1.6, pylonH, 4, 1, true).translate(0, pylonH / 2, 0));
  const headGeo = keep(new BoxGeometry(6, 3.4, 0.6));
  // The 12 lamps of a head in one geometry: one draw call per pylon, not 12.
  const lampGeo = keep(
    merge(
      Array.from({ length: 12 }, (_, n) => ({ geo: new PlaneGeometry(1.1, 0.7).translate(-2.2 + Math.floor(n / 3) * 1.47, -1.05 + (n % 3) * 1.05, 0.31) })),
    ),
  );
  const heads: Group[] = [];
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
      headG.add(new Mesh(lampGeo, lampMat));
      pg.add(headG);
      group.add(pg);
      pg.updateMatrixWorld(true);
      heads.push(headG);
    }
  }
  // A soft bloom in front of each head (one instanced draw), brighter when the stadium erupts. High quality, or
  // whenever the lights are on.
  let glowMat: MeshBasicMaterial | null = null;
  const lights = heads.map((hd) => hd.getWorldPosition(new Vector3()));
  if (hi || atmo.lamps > 2) {
    const [gc, gg] = canvas(64, 64);
    const grd = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,248,220,1)');
    grd.addColorStop(0.35, 'rgba(255,240,200,.35)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    gg.fillStyle = grd;
    gg.fillRect(0, 0, 64, 64);
    glowMat = keep(new MeshBasicMaterial({ map: keep(tex(gc, 1)), transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
    const glow = new InstancedMesh(keep(new PlaneGeometry(1, 1)), glowMat, heads.length);
    heads.forEach((h, i) => glow.setMatrixAt(i, tmpM.copy(h.matrixWorld).multiply(tmpM2.makeTranslation(0, 0, 0.6).scale(tmpS.set(15, 11, 1)))));
    glow.frustumCulled = false;
    group.add(glow);
  }
  // Under the lights: a faint cone of light from each head down onto the pitch (one draw), brightest along its axis.
  if (atmo.beams > 0) {
    const cones: Part[] = [];
    for (const l of lights) {
      const to = new Vector3(-l.x * 0.35, 0, -l.z * 0.35);
      const dir = to.clone().sub(l);
      const len = dir.length();
      const g = new ConeGeometry(len * 0.36, len, 20, 1, true).translate(0, -len / 2, 0);
      // Apex at the lamp, opening toward the pitch.
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), dir.normalize());
      g.applyMatrix4(new Matrix4().compose(l, q, new Vector3(1, 1, 1)));
      cones.push({ geo: g });
    }
    const beamMat = keep(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        // The inside faces only (one layer, whichever side the camera is on), so cones never stack into a haze.
        side: BackSide,
        fog: false,
        toneMapped: false,
        uniforms: { uStrength: { value: 0.035 * atmo.beams } },
        vertexShader: 'varying vec3 vN; varying vec3 vV; varying float vH; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vH = w.y; vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader:
          'uniform float uStrength; varying vec3 vN; varying vec3 vV; varying float vH; void main(){ float face = pow(abs(dot(normalize(vN), normalize(vV))), 2.0); float fade = smoothstep(14.0, 38.0, vH); gl_FragColor = vec4(vec3(1.0, 0.97, 0.88) * uStrength * face * fade, 1.0); }',
      }),
    );
    const beams = new Mesh(keep(merge(cones)), beamMat);
    beams.frustumCulled = false;
    beams.renderOrder = 2;
    group.add(beams);
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

  // Nothing in the stadium moves (the crowd, flags and nets animate in their shaders and vertex
  // buffers): its matrices are computed once here, not every frame (Renderer3D keeps the scene's own
  // matrix fixed too, so nothing forces them).
  group.updateMatrixWorld(true);
  group.traverse((obj) => (obj.matrixAutoUpdate = false));

  const local = new Vector3();
  const ballLocal = new Vector3();
  return {
    group,
    stands,
    boards,
    lights,
    update(dt, time, s) {
      // The fans rise fast and settle slowly; under reduced motion they hold one still pose.
      const still = !!s.still;
      for (const side of [0, 1] as const) {
        const to = still ? 0 : clamp01(s.excite[side]);
        const now = side ? lit.y : lit.x;
        const k = still ? 1 : 1 - Math.exp(-dt * (to > now ? 8 : 0.9));
        lit.setComponent(side, now + (to - now) * k);
      }
      crowdU.uTime.value = still ? 0 : time;
      // LED boards: the side boards' panels slide along one every seven seconds; after a goal they flash the
      // scorers' panels, scrolling. The ends move with them. Held still under reduced motion.
      const scorer = lit.x > 0.85 ? 0 : lit.y > 0.85 ? 1 : -1;
      const sideMap = scorer >= 0 ? goalMaps[scorer] : adMap;
      if (boardMats.far.map !== sideMap) {
        boardMats.far.map = sideMap;
        boardMats.far.emissiveMap = sideMap;
        boardMats.far.needsUpdate = true;
      }
      if (!still) {
        const ph = time / 7;
        const k = Math.floor(ph);
        const slide = smoothstep01(Math.min(1, (ph - k) * 7 / 0.6));
        sideMap.offset.x = scorer >= 0 ? (time * 0.25) % 1 : ((k + slide) / 8) % 1;
        for (const m of [boardMats.left, boardMats.right]) (m.map as CanvasTexture).offset.x = ((k + slide) / 4) % 1;
        for (const m of ribbons) (m.map as CanvasTexture).offset.x = (time * 0.02) % 1;
      }
      crowdU.uExcite.value.copy(lit);
      if (glowMat) glowMat.opacity = Math.min(1, atmo.glow * (1 + 0.8 * Math.max(lit.x, lit.y)));
      crowdU.uFlash.value = still ? 0 : atmo.flashes * (0.4 + 0.6 * Math.max(lit.x, lit.y));
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
