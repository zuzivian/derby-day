// Player lab: a dev page (not part of the game build) that lines up footballers in every
// animation state, lit like the match, for judging the models and animation up close.
//   bun run scripts/lab.ts   -> dist/lab.html
//   ?cam=close|broadcast|side  ?t=seconds (freeze the clock there)  ?kit=#rrggbb,#rrggbb
// window.__lab.at(t) renders the scene at clock t (deterministic), for screenshot scripts.

import { PlayerKit, createProceduralPlayer, keeperPair, lookFor, type AnimEvent, type PlayerContext, type SimBody } from './player3d.ts';
import { HALF_H, HALF_W, hash01 } from './space.ts';
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from './three.ts';

// Deterministic looks and gait phases.
let seed = 12345;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const q = new URLSearchParams(location.search);
const camMode = q.get('cam') ?? 'close';
const kitQ = (q.get('kit') ?? '#c8102e,#ffffff').split(',');

/** One lab slot: a label, a body moving (in place: the root is pinned, the velocity drives the gait) and scripted events. */
interface Slot {
  label: string;
  speed: number;
  /** Direction of travel relative to facing: 0 forwards, PI backwards, PI/2 sideways. */
  heading?: number;
  keeper?: boolean;
  hasBall?: boolean;
  keeperSet?: number;
  /** Re-fired every `every` seconds starting at `at`. */
  event?: (t0: number) => AnimEvent;
  at?: number;
  every?: number;
}

const SLOTS: Slot[] = [
  { label: 'idle', speed: 0 },
  { label: 'walk', speed: 1.6 },
  { label: 'jog', speed: 4 },
  { label: 'run', speed: 6.2 },
  { label: 'sprint', speed: 8.4 },
  { label: 'dribble', speed: 5, hasBall: true },
  { label: 'back', speed: 2.5, heading: Math.PI },
  { label: 'side', speed: 2.5, heading: Math.PI / 2 },
  { label: 'pass', speed: 0, event: (t0) => ({ kind: 'kick', style: 'pass', t0, dir: { x: 1, y: 0 }, power: 0.5 }), at: 0.2, every: 1.4 },
  { label: 'shot', speed: 3, event: (t0) => ({ kind: 'kick', style: 'shot', t0, dir: { x: 1, y: 0 }, power: 1 }), at: 0.2, every: 1.4 },
  { label: 'slide', speed: 0, event: (t0) => ({ kind: 'tackle', t0, failed: false, slide: true }), at: 0.2, every: 1.8 },
  { label: 'header', speed: 0, event: (t0) => ({ kind: 'header', t0 }), at: 0.2, every: 1.4 },
  { label: 'gk set', speed: 0, keeper: true, keeperSet: 1 },
  { label: 'dive', speed: 0, keeper: true, event: (t0) => ({ kind: 'dive', t0, side: 1, height: 0.8, reach: 1.2 }), at: 0.2, every: 2 },
  { label: 'celebrate', speed: 0, event: (t0) => ({ kind: 'celebrate', t0, style: 0 }), at: 0.2, every: 3 },
];

const W = innerWidth;
const H = innerHeight;
const gl = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(Math.min(2, devicePixelRatio));
gl.setSize(W, H);
gl.outputColorSpace = SRGBColorSpace;
gl.toneMapping = ACESFilmicToneMapping;
gl.toneMappingExposure = 1.05;
gl.shadowMap.enabled = true;
gl.shadowMap.type = PCFShadowMap;
document.body.style.margin = '0';
document.body.appendChild(gl.domElement);

const scene = new Scene();
scene.background = new Color('#9cc8f0');
scene.add(new HemisphereLight('#d6ebff', '#4d7d3a', 1.5));
const sun = new DirectionalLight('#fff1dc', 2.3);
sun.position.set(-40, 60, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const fill = new DirectionalLight('#dce8ff', 0.35);
fill.position.set(30, 40, 60);
scene.add(fill);

// Striped grass.
const gc = document.createElement('canvas');
gc.width = 64;
gc.height = 64;
const g2 = gc.getContext('2d')!;
g2.fillStyle = '#5f9a3c';
g2.fillRect(0, 0, 64, 64);
g2.fillStyle = '#6aa844';
g2.fillRect(0, 0, 32, 64);
const gt = new CanvasTexture(gc);
gt.wrapS = gt.wrapT = RepeatWrapping;
gt.repeat.set(8, 8);
gt.colorSpace = SRGBColorSpace;
const ground = new Mesh(new PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new MeshStandardMaterial({ map: gt, roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);

const kit = new PlayerKit();
const [gkA] = keeperPair(kitQ[0], '#2222cc');
const field = { shirt: kitQ[0], shorts: kitQ[1], socks: kitQ[0], trim: kitQ[1] };
// ?pick=0,1,2: only these slots (by index or label), re-centred.
const pickQ = q.get('pick');
const picked = pickQ ? SLOTS.filter((s, i) => pickQ.split(',').some((k) => k === String(i) || k === s.label)) : SLOTS;
const SPACING = camMode === 'close' ? 1.9 : 2.1;
const x0 = (-(picked.length - 1) * SPACING) / 2;
const players = picked.map((sl, j) => {
  const i = SLOTS.indexOf(sl);
  const look = lookFor(`p${i}`, sl.keeper ? gkA : field, sl.keeper ? 1 : 2 + i, !!sl.keeper, (salt) => hash01(`lab${i}`, salt));
  const m = createProceduralPlayer(kit, look);
  scene.add(m.object);
  // Every player faces +x (screen right in the side view), so all are seen in profile from the side camera.
  return { sl, m, x: x0 + j * SPACING };
});
const ball = new Mesh(new SphereGeometry(0.15, 16, 12), new MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 }));
ball.castShadow = true;
scene.add(ball);

const cam = new PerspectiveCamera(camMode === 'broadcast' ? 18 : 24, W / H, 0.1, 500);
function placeCamera() {
  if (camMode === 'broadcast') {
    // Roughly the match's broadcast camera: high up the side, looking down across the pitch.
    cam.position.set(0, 26, 52);
    cam.lookAt(0, 0, 0);
  } else if (camMode === 'face') {
    // Head and shoulders of the first picked player, from the front-right.
    cam.fov = 14;
    cam.updateProjectionMatrix();
    cam.position.set(x0 + 3.2, 2.0, 2.2);
    cam.lookAt(x0, 1.65, 0);
  } else if (camMode === 'side') {
    const span = Math.max(4, picked.length * SPACING);
    const d = (span / 2 / Math.tan((12 * Math.PI) / 180)) * 0.7;
    cam.position.set(0, 1.0, d);
    cam.lookAt(0, 0.95, 0);
  } else {
    // Three-quarter view from the front-left, a little above.
    const span = Math.max(4, picked.length * SPACING);
    const d = span / 2 / Math.tan((12 * Math.PI) / 180) * 0.62;
    cam.position.set(d * 0.32, d * 0.16 + 0.6, d);
    cam.lookAt(0, 0.95, 0);
  }
}
placeCamera();

/** Body moving at speed along the slot's heading while facing +x (sim x right, sim y down = scene z). */
function bodyFor(sl: Slot): SimBody {
  const hd = sl.heading ?? 0;
  return { pos: { x: HALF_W, y: HALF_H }, vel: { x: Math.cos(hd) * sl.speed, y: Math.sin(hd) * sl.speed }, facing: { x: 1, y: 0 }, sprinting: sl.speed > 7, role: sl.keeper ? 'GK' : 'CM' } as SimBody;
}

const ctx: PlayerContext = { time: 0, dtSim: 1 / 60, lead: 0, keeperSet: 0, throwHold: false, holding: false, hasBall: false, wall: false, reducedMotion: false };

let clock = 0;
function step(dt: number) {
  const prev = clock;
  clock += dt;
  for (const p of players) {
    const sl = p.sl;
    const evs: AnimEvent[] = [];
    if (sl.event && sl.at !== undefined) {
      const every = sl.every ?? 1e9;
      // Fire for each repeat whose start falls in (prev, clock].
      const k = Math.floor((clock - sl.at) / every);
      const start = sl.at + k * every;
      if (k >= 0 && start > prev && start <= clock) evs.push(sl.event(start));
    }
    ctx.time = clock;
    ctx.dtSim = dt;
    ctx.keeperSet = sl.keeperSet ?? 0;
    ctx.hasBall = !!sl.hasBall;
    const body = bodyFor(sl);
    p.m.update(dt, body, evs, ctx);
    // Pin the player to its slot (the model places itself at the sim position, here the origin).
    p.m.object.position.x += p.x;
    p.m.object.updateMatrixWorld(true);
    if (sl.hasBall) ball.position.set(p.x + 0.75, 0.15, 0);
    ball.visible = players.some((pp) => pp.sl.hasBall);
  }
}

function render() {
  gl.render(scene, cam);
}

/** Render the scene at clock t from a fresh start (deterministic for screenshots). */
function at(t: number) {
  while (clock + 1e-9 < t) step(Math.min(1 / 60, t - clock));
  render();
}

declare global {
  interface Window {
    __lab: { at: (t: number) => void; ready: boolean; labels: string[] };
  }
}
window.__lab = { at, ready: true, labels: picked.map((s) => s.label) };

const frozen = q.get('t');
if (frozen !== null) at(Number(frozen));
else {
  let last = performance.now();
  const loop = (now: number) => {
    step(Math.min(0.05, (now - last) / 1000));
    last = now;
    render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
