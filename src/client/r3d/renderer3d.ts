// three.js match renderer. Reads sim state only, like the 2D PitchRenderer,
// and implements the same MatchRenderer interface (see ../renderer.ts).

import { BOX_DEPTH, BOX_W, GOAL_BOTTOM, GOAL_TOP, PENALTY_SPOT as PEN_SPOT } from '../../sim/constants.ts';
import { attackDir, oppGoal } from '../../sim/field.ts';
import { indirectPending } from '../../sim/rules.ts';
import type { MatchState, TeamSetup } from '../../sim/types.ts';
import type { Vec } from '../../sim/vec.ts';
import { grassClash } from '../kits.ts';
import type { MatchRenderer } from '../renderer.ts';
import type { RenderExtras } from '../render.ts';
import { AimLayer, type AimFrame } from './aim3d.ts';
import { MatchCamera, ZOOM_STEP, clampZoom, type CameraFocus, type CameraMode } from './camera3d.ts';
import { AnimDirector, inWall, keeperSet } from './director.ts';
import { PlayerDots, playerPx } from './dots3d.ts';
import { PlayerKit, colorDist, createProceduralPlayer, keeperPair, lookFor, type AnimEvent, type Player3D, type PlayerContext, type SimBody } from './player3d.ts';
import { HALF_H, HALF_W, hash01, prefersReducedMotion, sx, sz, wx, wy } from './space.ts';
import { buildStadium, type Stadium } from './stadium.ts';
import { QualityGovernor, type GovernorState } from './governor.ts';
import { FRAME_BUDGET, FRAME_PARTS } from './budget.ts';
import { watchPixelRatio, type PixelRatioWatch } from '../dpr.ts';
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  MeshStandardMaterial,
  PCFShadowMap,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from './three.ts';

export type Quality = 'low' | 'high';

export interface Renderer3DOptions {
  quality: Quality;
  /** Replays: lower, closer camera. */
  cinematic?: boolean;
}

/** Drawn a little larger than a real ball (0.11 m) so it reads at broadcast distance. */
const BALL_VIS_R = 0.15;
const CAMERA_KEY = 'derby-camera';
const ZOOM_KEY = 'derby-zoom';
/** Visual events with no sim cause linger on this clock, so they need their own lifetimes. */
const NO_EVENTS: AnimEvent[] = [];

function storedCamera(): CameraMode {
  try {
    return localStorage.getItem(CAMERA_KEY) === 'end' ? 'end' : 'broadcast';
  } catch {
    return 'broadcast';
  }
}

function storedZoom(): number {
  try {
    const v = localStorage.getItem(ZOOM_KEY);
    return v === null ? 1 : clampZoom(Number(v));
  } catch {
    return 1;
  }
}

/** An instant-replay camera: low from the side, or from behind the goal at that end (sim x 0 or PITCH_W). */
export interface ReplayShot {
  kind: 'low' | 'goal';
  /** Sim x of the goal line the shot looks out from ('goal'), or the goal the move ended at ('low'). */
  goalX: number;
}

/**
 * Should the camera pull back to the long view? When the human's side has a goal kick, or a free
 * kick in its own half, or the human's keeper holds the ball: the player is about to distribute it
 * and needs to see who is free up to and beyond halfway. Returns the ball's spot and the sim points
 * the frame must show (the ball, a little behind it, and touchline to touchline out to LONG_PAST
 * beyond halfway), or null. Pure, for tests.
 */
export function longView(s: MatchState, me: 0 | 1): { ball: Vec; points: Vec[]; kind: 'long' | 'corner' | 'setpiece' } | null {
  if (!s.humans[me] || (s.humans[0] && s.humans[1])) return null;
  const dir = attackDir(s, me);
  const r = s.restart;
  const b = s.ball;
  // Corners, either side's: the taker, the goal and the whole box (review of #15: the broadcast view
  // showed stands and sky, with the goal off the edge of the frame).
  if (r && r.kind === 'corner' && r.stage !== 'whistle') {
    const gx = r.spot.x < HALF_W ? 0 : HALF_W * 2;
    const inX = gx === 0 ? BOX_DEPTH : HALF_W * 2 - BOX_DEPTH;
    const pen = gx === 0 ? PEN_SPOT : HALF_W * 2 - PEN_SPOT;
    return {
      kind: 'corner',
      ball: { x: r.spot.x, y: r.spot.y },
      points: [{ x: r.spot.x, y: r.spot.y }, { x: gx, y: HALF_H - BOX_W / 2 }, { x: gx, y: HALF_H + BOX_W / 2 }, { x: inX, y: HALF_H - BOX_W / 2 }, { x: inX, y: HALF_H + BOX_W / 2 }, { x: pen + (gx === 0 ? 4 : -4), y: HALF_H }],
    };
  }
  // Free kicks in the taking side's attacking half, either side's: the taker and his run-up, the wall
  // and the goal it is aimed at. (The broadcast view lost the goal from 24 m out wide, or 35 m out.)
  // The wall is framed by its ends, 9.15 m out on the line to goal, not by the men walking into it,
  // so the frame holds still while they do.
  if (r && r.kind === 'freekick' && r.stage !== 'whistle') {
    const g = oppGoal(s, r.team);
    if (Math.abs(g.x - r.spot.x) < HALF_W) {
      const dx = g.x - r.spot.x;
      const dy = g.y - r.spot.y;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const wall = Math.min(WALL_DIST, l - 1);
      return {
        kind: 'setpiece',
        ball: { x: r.spot.x, y: r.spot.y },
        points: [
          { x: r.spot.x, y: r.spot.y },
          { x: r.spot.x - ux * RUN_UP, y: r.spot.y - uy * RUN_UP },
          { x: r.spot.x + ux * wall - uy * WALL_HALF, y: r.spot.y + uy * wall + ux * WALL_HALF },
          { x: r.spot.x + ux * wall + uy * WALL_HALF, y: r.spot.y + uy * wall - ux * WALL_HALF },
          { x: g.x, y: GOAL_TOP - 1 },
          { x: g.x, y: GOAL_BOTTOM + 1 },
        ],
      };
    }
  }
  let ball: Vec | null = null;
  if (r && r.team === me && r.stage !== 'whistle') {
    const own = dir > 0 ? r.spot.x < HALF_W : r.spot.x > HALF_W;
    if (r.kind === 'goalkick' || (r.kind === 'freekick' && own)) ball = r.spot;
  } else if (s.phase === 'play' && b.inHands && b.owner >= 0) {
    const k = s.players[b.owner];
    if (k.team === me && k.role === 'GK') ball = k.pos;
  }
  if (!ball) return null;
  const back = Math.max(0, Math.min(HALF_W * 2, ball.x - dir * 4));
  const past = HALF_W + dir * LONG_PAST;
  const near = HALF_H * 2 - LONG_TOUCH;
  return {
    kind: 'long',
    ball: { x: ball.x, y: ball.y },
    points: [{ x: ball.x, y: ball.y }, { x: back, y: LONG_TOUCH }, { x: back, y: near }, { x: past, y: LONG_TOUCH }, { x: past, y: near }],
  };
}

/** The long view shows this far past halfway, metres. */
export const LONG_PAST = 20;
/** And touchline to touchline, but for this strip along each (where nobody stands at a set piece). */
export const LONG_TOUCH = 3;
/** A free kick's set-piece view: the wall stands this far from the ball (Law 13), this far either side of the line to goal. */
const WALL_DIST = 9.15;
const WALL_HALF = 3;
/** And the taker's run-up, this far behind the ball. */
const RUN_UP = 2.5;

/** Football with a panel pattern: dark pentagons round the 12 icosahedron vertices. */
function ballGeometry(): IcosahedronGeometry {
  const g = new IcosahedronGeometry(BALL_VIS_R, 3);
  const ico = new IcosahedronGeometry(1, 0);
  const pos = ico.attributes.position;
  const verts: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    if (!verts.some((w) => w.distanceTo(v) < 1e-3)) verts.push(v);
  }
  ico.dispose();
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new Vector3();
  for (let i = 0; i < p.count; i += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(new Vector3(p.getX(i + k), p.getY(i + k), p.getZ(i + k)));
    c.normalize();
    const dark = verts.some((v) => v.dot(c) > 0.94);
    const shade = dark ? 0.06 : 0.96;
    for (let k = 0; k < 3; k++) col.set([shade, shade, dark ? 0.08 : 0.94], (i + k) * 3);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function blobTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function teamKey(t: TeamSetup): string {
  return `${t.name}|${t.primary}|${t.secondary}|${t.players.map((p) => p.id).join(',')}`;
}

/** A player's body for picking a click: a vertical cylinder this wide (m) from the grass to this height. */
export const PICK_BODY_R = 0.38;
export const PICK_BODY_TOP = 1.9;

/** Which players a press may pick: `me`'s team-mates but never the man he steers, or the opponents; nobody sent off. */
export function pickable(s: MatchState, me: 0 | 1, who: 'mates' | 'opponents'): boolean[] {
  const mine = s.controlled[me];
  return s.players.map((p) => !p.sentOff && p.i !== mine && (who === 'mates' ? p.team === me : p.team !== me));
}

/**
 * The first body a ray meets, as an index into `bodies` (scene x, z of each player's feet), or -1.
 * Bodies are vertical cylinders PICK_BODY_R wide from the grass to PICK_BODY_TOP, entered through
 * the side or the top.
 */
export function pickBody(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, bodies: readonly ({ x: number; z: number } | null)[]): number {
  let best = -1;
  let bestT = Infinity;
  const r2 = PICK_BODY_R * PICK_BODY_R;
  for (let i = 0; i < bodies.length; i++) {
    const c = bodies[i];
    if (!c) continue;
    let t = Infinity;
    // Through the top: where the ray crosses the head's height.
    if (Math.abs(d.y) > 1e-9) {
      const tt = (PICK_BODY_TOP - o.y) / d.y;
      const px = o.x + d.x * tt - c.x;
      const pz = o.z + d.z * tt - c.z;
      if (tt > 0 && px * px + pz * pz <= r2) t = tt;
    }
    // Through the side.
    const ox = o.x - c.x;
    const oz = o.z - c.z;
    const a = d.x * d.x + d.z * d.z;
    if (a > 1e-12) {
      const b = ox * d.x + oz * d.z;
      const disc = b * b - a * (ox * ox + oz * oz - r2);
      if (disc >= 0) {
        const ts = (-b - Math.sqrt(disc)) / a;
        const y = o.y + d.y * ts;
        if (ts > 0 && y >= 0 && y <= PICK_BODY_TOP && ts < t) t = ts;
      }
    }
    if (t < bestT) {
      bestT = t;
      best = i;
    }
  }
  return best;
}

export class Renderer3D implements MatchRenderer {
  readonly kind = '3d' as const;
  /** The 3D view moves on its own (camera, crowd), so callers should draw every frame. */
  readonly continuous = true;
  private gl: WebGLRenderer;
  private scene = new Scene();
  private cam = new MatchCamera();
  private sun: DirectionalLight;
  private stadium: Stadium | null = null;
  private kit = new PlayerKit();
  private players: Player3D[] = [];
  private referee: Player3D | null = null;
  private teamsKey = '';
  private ball: Mesh;
  private blob: Mesh;
  private ballQ = new Quaternion();
  private blobMat: MeshBasicMaterial;
  /** Ghost balls behind a fast shot, newest first. */
  private trail: InstancedMesh;
  private trailPts: Vector3[] = [];
  private trailSpare: Vector3[] = [];
  // Scratch objects refilled every frame, so the render loop doesn't allocate them (GC pauses).
  private axis = new Vector3();
  private pctx: PlayerContext = { time: 0, dtSim: 0, lead: 0, keeperSet: 0, throwHold: false, holding: false, hasBall: false, wall: false, reducedMotion: false };
  private refBody: SimBody = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, facing: { x: 1, y: 0 } };
  private stadiumFrame = { excite: [0, 0] as [number, number], ball: { x: 0, y: 0, z: 0, speed: 0 } };
  private focus: CameraFocus = { x: 0, z: 0, vx: 0, vz: 0, air: 0, attack: 0, phase: '', close: null, humanDir: 1, long: null, replay: null };
  private aimFrame = { heads: [] } as unknown as AimFrame;
  private feet: InstancedMesh | null = null;
  private m4 = new Matrix4();
  private aim: AimLayer | null = null;
  private director = new AnimDirector();
  private raycaster = new Raycaster();
  private ground = new Plane(new Vector3(0, 1, 0), 0);
  private ndc = new Vector2();
  private hit = new Vector3();
  private cssW = 1;
  private cssH = 1;
  private clock: number | null = null;
  private rate = 1;
  private lastTick = -1;
  private lastNow = 0;
  private lastState: MatchState | null = null;
  private heads: Vector3[] = [];
  /** Shirt-coloured dots over the players when they are drawn too small to read (dots3d.ts). */
  private dots: PlayerDots | null = null;
  private dotsOn: boolean | null = null;
  private reduced = prefersReducedMotion();
  private celebrate: { i: number; until: number } | null = null;
  /** The referee turns to the player he is booking until this clock time. */
  private cardFace: { player: number; until: number } | null = null;
  private lost = false;
  /** null with ?governor=off (tooling: fixed quality for measurements). */
  private governor: QualityGovernor | null = null;
  private shadowEvery = 1;
  private frameNo = 0;
  private pixelRatio: number;
  private fpsAt = 0;
  private fpsFrames = 0;
  /** Frames in the last whole second of stats, and the CPU ms they spent per part (FRAME_PARTS order). */
  private fpsLast = 0;
  private partMs = new Float64Array(FRAME_PARTS.length);
  private me: 0 | 1 = 0;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: Renderer3DOptions,
  ) {
    const hi = opts.quality === 'high';
    this.gl = new WebGLRenderer({ canvas, antialias: hi, powerPreference: 'high-performance', stencil: false });
    // Software rendering (low): no shadow maps, and a slightly reduced resolution.
    this.pixelRatio = this.basePixelRatio();
    this.gl.setPixelRatio(this.pixelRatio);
    // A new screen or browser zoom: re-pick the ratio, so the pitch stays sharp (or stops overdrawing).
    this.dpr = watchPixelRatio(() => {
      this.pixelRatio = Math.min(this.basePixelRatio(), this.pixelCap);
      this.gl.setPixelRatio(this.pixelRatio);
      this.resize();
    });
    this.cleanup.push(() => this.dpr.dispose());
    this.gl.outputColorSpace = SRGBColorSpace;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.enabled = hi;
    this.gl.shadowMap.type = PCFShadowMap;
    if (!/[?&]governor=off\b/.test(location.search)) this.governor = new QualityGovernor({ shadows: hi, pixelRatio: this.pixelRatio, minRatio: hi ? 0.75 : 0.55, now: performance.now() });
    this.prefMode = storedCamera();
    this.cam.mode = this.prefMode;
    this.cam.zoom = storedZoom();
    this.cam.cinematic = !!opts.cinematic;

    const scene = this.scene;
    // Matrices: draw() updates the scene's once a frame itself (players, then the few things placed
    // after them), so three's render() doesn't walk all ~600 objects a second time. The scene itself
    // never moves, which also lets the static stadium skip its matrices (stadium.ts).
    scene.matrixAutoUpdate = false;
    scene.matrixWorldAutoUpdate = false;
    scene.background = new Color('#9cc8f0');
    scene.fog = new Fog('#c6dcf0', 220, 1100);
    const hemi = new HemisphereLight('#d6ebff', '#4d7d3a', 1.5);
    scene.add(hemi);
    // Low afternoon sun from behind the camera's left shoulder: players lit from the front, long
    // diagonal shadows away up the pitch, the near stand's shadow across the near touchline.
    this.sun = new DirectionalLight('#fff1dc', 2.3);
    this.sun.castShadow = hi;
    const sm = hi ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const ext = hi ? 42 : 46;
    const sc = this.sun.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.sun.shadow.camera.layers.enable(1);
    scene.add(this.sun, this.sun.target);
    const fill = new DirectionalLight('#dce8ff', 0.35);
    fill.position.set(30, 40, 60);
    scene.add(fill);

    // Drawn in the transparent pass (fully opaque) after the player dots, so the ball is never
    // hidden under one (dots3d.ts DOT_ORDER); its shadow blob (renderOrder 1) comes after them too.
    this.ball = new Mesh(ballGeometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0, transparent: true } as Record<string, unknown>));
    this.ball.renderOrder = 1.5;
    this.ball.castShadow = true;
    this.blobMat = new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, toneMapped: false });
    this.blob = new Mesh(new PlaneGeometry(1, 1), this.blobMat.clone());
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
    this.trail = new InstancedMesh(new IcosahedronGeometry(BALL_VIS_R, 1), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }), 10);
    this.trail.frustumCulled = false;
    this.trail.count = 0;
    scene.add(this.ball, this.blob, this.trail);

    const onLost = (e: Event) => {
      e.preventDefault();
      if (this.disposed) return;
      this.lost = true;
      this.onContextLost?.();
    };
    const onRestored = () => {
      if (this.disposed) return;
      this.lost = false;
      this.onContextRestored?.();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanup.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    });
    canvas.dataset.renderer = '3d';
    canvas.dataset.quality = opts.quality;
    // The GPU side of this quality's frame budget (budget.ts), for tests and devtools next to data-calls and data-tris.
    canvas.dataset.budgetCalls = String(FRAME_BUDGET[opts.quality].calls);
    canvas.dataset.budgetTris = String(FRAME_BUDGET[opts.quality].tris);
    // Tooling hook for screenshots and probes: ?debug3d exposes the renderer.
    if (/[?&]debug3d\b/.test(location.search)) (window as unknown as Record<string, unknown>).__derby3d = this;
  }

  private prefMode: CameraMode = 'broadcast';

  /** The GPU dropped the context (a driver reset, too many contexts): the pitch can't be drawn until it is restored. */
  onContextLost: (() => void) | null = null;
  /** The context is back; three re-uploads everything on the next draw. */
  onContextRestored: (() => void) | null = null;

  /** Is the GL context lost right now? */
  get contextLost(): boolean {
    return this.lost && !this.disposed;
  }

  /** Software rendering (low): a slightly reduced resolution. */
  private basePixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return this.opts.quality === 'high' ? Math.min(2, dpr) : Math.min(1, dpr) * 0.8;
  }

  private dpr: PixelRatioWatch;
  /** The most the slow-machine step-down allows (Infinity until it steps). */
  private pixelCap = Infinity;

  get cameraMode(): CameraMode {
    return this.prefMode;
  }

  private cutCount = 0;
  /** While performance.now() is before this, the view is being re-framed on its own (a zoom, the long view coming or going). */
  private reframeUntil = 0;

  /** WorldPicker.cuts: bumped on a cut and on every frame of an automatic re-framing (see input.ts). */
  cuts(): number {
    return this.cutCount;
  }

  setCameraMode(m: CameraMode): void {
    this.cutCount++;
    this.prefMode = m;
    this.cam.mode = m;
    this.cam.snap();
    try {
      localStorage.setItem(CAMERA_KEY, m);
    } catch {
      /* private mode */
    }
  }

  /** The player's zoom, a multiplier on the framing width: above 1 shows more pitch. */
  get zoom(): number {
    return this.cam.zoom;
  }

  /** Set the zoom (clamped to ZOOM_MIN..ZOOM_MAX) and remember it in this browser. Returns the new value. */
  setZoom(z: number): number {
    this.cam.zoom = clampZoom(z);
    this.reframeUntil = performance.now() + 1200;
    try {
      localStorage.setItem(ZOOM_KEY, this.cam.zoom.toFixed(3));
    } catch {
      /* private mode */
    }
    return this.cam.zoom;
  }

  /** One zoom step: out (1) shows more pitch, in (-1) less. */
  zoomStep(dir: 1 | -1): number {
    return this.setZoom(this.cam.zoom * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
  }

  /** Instant replays: the replay camera to use, or null for the normal match cameras. */
  replayShot: ReplayShot | null = null;

  private longHold: { ball: Vec; points: Vec[]; kind: 'long' | 'corner' | 'setpiece'; until: number } | null = null;

  /** Tooling: is the long view on this frame? */
  longViewOn = false;

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    // Setting canvas.width, even to the same value, reallocates the drawing buffer: skip no-op resizes.
    const pr = this.gl.getPixelRatio();
    if (w === this.cssW && h === this.cssH && this.canvas.width === Math.floor(w * pr)) return;
    this.cssW = w;
    this.cssH = h;
    this.gl.setSize(w, h, false);
  }

  toWorld(cssX: number, cssY: number): Vec {
    const cam = this.cam.camera;
    this.ndc.set((cssX / this.cssW) * 2 - 1, -(cssY / this.cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, cam);
    const ray = this.raycaster.ray;
    let x: number;
    let z: number;
    if (ray.direction.y < -0.02 && ray.intersectPlane(this.ground, this.hit)) {
      x = this.hit.x;
      z = this.hit.z;
    } else {
      // Above the horizon: take the far end of the ray's ground track.
      x = cam.position.x + ray.direction.x * 200;
      z = cam.position.z + ray.direction.z * 200;
    }
    const m = 6;
    return { x: Math.max(-m, Math.min(HALF_W * 2 + m, wx(x))), y: Math.max(-m, Math.min(HALF_H * 2 + m, wy(z))) };
  }

  /**
   * A press on a player's body (not just his feet) picks him: his feet in world metres, or null if the
   * ray meets no one. `who`: our team-mates (never the man we steer) or the opponents.
   */
  pickPlayer(cssX: number, cssY: number, who: 'mates' | 'opponents'): Vec | null {
    const s = this.lastState;
    if (!s) return null;
    this.ndc.set((cssX / this.cssW) * 2 - 1, -(cssY / this.cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.cam.camera);
    const can = pickable(s, this.me, who);
    const bodies = this.players.map((m, i) => (can[i] && m.object.visible ? m.object.position : null));
    const i = pickBody(this.raycaster.ray.origin, this.raycaster.ray.direction, bodies);
    if (i < 0) return null;
    const at = this.players[i].object.position;
    return { x: wx(at.x), y: wy(at.z) };
  }

  screenDir(d: Vec): Vec {
    return this.cam.screenDir(d, (this.lastState ? attackDir(this.lastState, this.me) : this.me === 0 ? 1 : -1) as 1 | -1);
  }

  /** Frames per second over the last second, for tooling. */
  fps = 0;

  private build(s: MatchState): void {
    const key = `${teamKey(s.teams[0])}#${teamKey(s.teams[1])}#${s.players.length}`;
    if (key === this.teamsKey && this.stadium) return;
    this.teamsKey = key;
    if (!this.stadium) {
      const aniso = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
      this.stadium = buildStadium({ teams: s.teams, quality: this.opts.quality, anisotropy: aniso });
      this.scene.add(this.stadium.group);
    }
    for (const p of this.players) p.dispose();
    this.players = [];
    // Both keepers' kits, chosen together so they also differ from each other.
    const keepers = keeperPair(s.teams[0].primary, s.teams[1].primary);
    const kits = ([0, 1] as const).map((t) => {
      const team = s.teams[t];
      const numberColor = colorDist(team.primary, team.secondary) > 110 ? team.secondary : colorDist(team.primary, '#ffffff') > 200 ? '#ffffff' : '#111111';
      const shorts = colorDist(team.secondary, team.primary) > 60 ? team.secondary : '#f5f5f5';
      const keeper = keepers[t];
      // A kit too close to the grass as drawn gets a dark rim round its players (kits.ts grassClash).
      return {
        field: { shirt: team.primary, shorts, socks: team.primary, trim: numberColor, rim: grassClash(team.primary) },
        keeper: { ...keeper, rim: grassClash(keeper.shirt) },
      };
    });
    for (const p of s.players) {
      const keeper = p.role === 'GK';
      const kit = keeper ? kits[p.team].keeper : kits[p.team].field;
      const look = lookFor(p.id, kit, p.number, keeper, (salt) => hash01(p.id + p.name, salt));
      const model = createProceduralPlayer(this.kit, look);
      model.object.traverse((o) => (o.castShadow = o.castShadow || false));
      this.scene.add(model.object);
      this.players.push(model);
    }
    this.heads = s.players.map(() => new Vector3());
    // Without shadow maps, players get a soft blob under their feet instead.
    if (this.opts.quality === 'low') {
      this.feet?.geometry.dispose();
      this.feet?.removeFromParent();
      this.feet = new InstancedMesh(new PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2), this.blobMat, s.players.length + 1);
      this.feet.frustumCulled = false;
      this.feet.renderOrder = 1;
      this.scene.add(this.feet);
    }
    this.aim?.dispose();
    this.aim = new AimLayer(s.players.length);
    this.scene.add(this.aim.group);
    this.dots?.dispose();
    this.dots = new PlayerDots(s.players.map((p) => (p.role === 'GK' ? kits[p.team].keeper : kits[p.team].field).shirt));
    this.scene.add(this.dots.object);
    this.director.reset(s);
  }

  prepare(s: MatchState): void {
    if (this.lost) return;
    this.build(s);
    // Compile every program now, including overlays that are hidden until the pointer moves or a
    // kick is charged: on a software GPU each first-use compile is a visible stall mid-match.
    const hidden: Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.gl.compile(this.scene, this.cam.camera);
    for (const o of hidden) o.visible = false;
    this.draw(s, { cursor: null, charge: 0, showCursor: false });
    // Wait for the GPU to finish those compiles and uploads here, during set-up, instead of the
    // match's first frames stalling on them.
    this.gl.getContext().finish();
  }

  draw(s: MatchState, x: RenderExtras): void {
    if (this.lost) return;
    this.dpr.check();
    const t0 = performance.now();
    this.build(s);
    const now = t0 / 1000;
    const dt = this.lastNow ? Math.min(0.1, Math.max(0, now - this.lastNow)) : 1 / 60;
    this.lastNow = now;
    this.me = x.team ?? (s.humans[0] || !s.humans[1] ? 0 : 1);
    // Two humans on one screen, or nobody playing: the side view suits everyone.
    const mode: CameraMode = (s.humans[0] && s.humans[1]) || (!s.humans[0] && !s.humans[1]) ? 'broadcast' : this.prefMode;
    if (mode !== this.cam.mode) {
      this.cam.mode = mode;
      this.cam.snap();
    }

    // Animation clock: runs smoothly at the rate sim ticks arrive, stops when they stop.
    const tickTime = s.tick / 60;
    const jumped = this.lastState !== s || this.lastTick < 0 || s.tick < this.lastTick || s.tick - this.lastTick > 45;
    if (jumped || this.clock === null) {
      this.clock = tickTime;
      this.rate = 1;
      if (jumped) {
        // A different state or a seek (an instant replay starting or ending): booking cards, the
        // referee's turn and a celebration belong to the old timeline (a card replay used to show
        // the card over the offender before the foul had happened in it).
        this.aim?.clearCards();
        this.cardFace = null;
        this.celebrate = null;
        this.cam.snap();
        this.cutCount++;
      }
    } else {
      const adv = (s.tick - this.lastTick) / 60;
      const inst = dt > 0 ? adv / dt : 1;
      this.rate += (Math.min(1.6, inst) - this.rate) * Math.min(1, dt * 6);
    }
    const prevClock = this.clock;
    let clock = this.clock + dt * this.rate;
    clock = Math.max(tickTime - 3 / 60, Math.min(tickTime + 1 / 60, clock));
    if (!jumped) clock = Math.max(prevClock, clock);
    this.clock = clock;
    const dtSim = jumped ? 0 : clock - prevClock;
    // How far past the tick to draw things (extrapolated by velocity): the match loop's exact time since
    // the tick when it gives one (RenderExtras.since), else this clock's estimate.
    const lead = Math.max(-1 / 60, Math.min(1 / 60, x.since ?? clock - tickTime));
    this.lastTick = s.tick;
    this.lastState = s;

    const dir = this.director.update(s, clock);
    const restart = s.restart;
    const b = s.ball;
    // Who has the ball in his hands: a keeper holding it (ball.inHands), the thrower at a throw-in,
    // or a keeper carrying it out to the spot for a goal kick.
    const taker = restart && restart.taker >= 0 ? s.players[restart.taker] : null;
    const throwTaker = restart?.kind === 'throwin' && taker && (restart.stage === 'ready' || Math.hypot(taker.pos.x - restart.spot.x, taker.pos.y - restart.spot.y) < 1.2) ? taker.i : -1;
    const gkCarry = restart?.kind === 'goalkick' && restart.stage !== 'ready' && taker && taker.role === 'GK' && Math.hypot(taker.pos.x - restart.spot.x, taker.pos.y - restart.spot.y) > 0.8 ? taker.i : -1;
    const handsOf = throwTaker >= 0 ? throwTaker : gkCarry >= 0 ? gkCarry : b.inHands && b.owner >= 0 ? b.owner : -1;
    for (const c of dir.cards) {
      if (c.player >= 0) this.cardFace = { player: c.player, until: clock + 2.4 };
      if (c.player >= 0 && !s.players[c.player].sentOff) this.aim?.card(c.player, c.color, clock + 3);
    }

    const tPlayers = performance.now();
    // Players. A player sent off is parked far off the pitch by the sim: not drawn.
    for (const p of s.players) {
      const model = this.players[p.i];
      model.object.visible = !p.sentOff;
      if (p.sentOff) continue;
      const throwHold = p.i === throwTaker && (b.inHands || b.owner === p.i || restart?.stage === 'ready');
      const c = this.pctx;
      c.time = clock;
      c.dtSim = dtSim;
      c.lead = lead;
      c.keeperSet = keeperSet(s, p);
      c.throwHold = throwHold;
      c.holding = p.i === handsOf && !throwHold;
      c.hasBall = b.owner === p.i;
      c.wall = inWall(s, p);
      c.armUp = false;
      c.reducedMotion = this.reduced;
      model.update(dt, p, dir.events[p.i] ?? NO_EVENTS, c);
      const ev = dir.events[p.i];
      if (ev) for (const e of ev) if (e.kind === 'celebrate') this.celebrate = { i: p.i, until: clock + 2.4 };
    }

    // The referee, in black. While showing a card he turns to the player.
    const ref = s.referee;
    if (ref) {
      let facing = ref.facing;
      if (this.cardFace && clock < this.cardFace.until) {
        const q = s.players[this.cardFace.player];
        if (q && !q.sentOff) facing = { x: q.pos.x - ref.pos.x, y: q.pos.y - ref.pos.y };
      }
      if (!this.referee) {
        this.referee = createProceduralPlayer(this.kit, {
          shirt: '#151515',
          shorts: '#101010',
          socks: '#151515',
          trim: '#f4dc1c',
          skin: '#d9a77f',
          hair: '#2b1c12',
          hairStyle: 1,
          boots: '#111111',
          bootSole: '#2a2a2a',
          bootAccent: '#f4dc1c',
          gloves: null,
          longSleeves: false,
          number: null,
          height: 1,
          build: 0,
        });
        this.scene.add(this.referee.object);
      }
      const rb = this.refBody;
      rb.pos = ref.pos;
      rb.vel = ref.vel;
      rb.facing = facing;
      const c = this.pctx;
      c.time = clock;
      c.dtSim = dtSim;
      c.lead = lead;
      c.keeperSet = 0;
      c.throwHold = c.holding = c.hasBall = c.wall = false;
      c.armUp = indirectPending(s);
      c.reducedMotion = this.reduced;
      this.referee.update(dt, rb, dir.referee, c);
    } else if (this.referee) {
      this.referee.dispose();
      this.referee = null;
    }

    this.scene.updateMatrixWorld();
    for (const p of s.players) this.players[p.i].headTop(this.heads[p.i]);
    if (this.feet) {
      for (const p of s.players) {
        const o = this.players[p.i].object.position;
        if (p.sentOff) this.m4.makeTranslation(0, -50, 0);
        else this.m4.makeTranslation(o.x + 0.25, 0.015, o.z - 0.2);
        this.feet.setMatrixAt(p.i, this.m4);
      }
      this.feet.count = s.players.length;
      this.feet.instanceMatrix.needsUpdate = true;
    }

    // Ball: in someone's hands (see handsOf), or where the sim has it.
    const holder = b.owner >= 0 ? s.players[b.owner] : null;
    const inHands = handsOf >= 0;
    if (inHands) {
      this.players[handsOf].handsWorld(this.ball.position);
      this.ball.position.y += 0.02;
    } else {
      // At someone's feet the ball moves on with him (his model is extrapolated too), else with its own velocity.
      const v = holder ? holder.vel : b.vel;
      const bx = b.pos.x + v.x * lead;
      const by = b.pos.y + v.y * lead;
      this.ball.position.set(sx(bx), BALL_VIS_R + b.z, sz(by));
    }
    // Spin: roll with ground speed; keep a gentle spin in the air.
    const sp = Math.hypot(b.vel.x, b.vel.y);
    if (sp > 0.05 && dtSim > 0 && !inHands) {
      const axis = this.axis.set(b.vel.y / sp, 0, -b.vel.x / sp);
      const ang = (sp * dtSim) / BALL_VIS_R;
      this.ballQ.setFromAxisAngle(axis, b.z > 0.05 ? ang * 0.6 : ang);
      this.ball.quaternion.premultiply(this.ballQ);
    }
    // Trail behind fast, free balls (shots, hard passes), fading as it shrinks.
    if (sp > 14 && b.owner < 0 && s.phase === 'play' && dtSim > 0) {
      // Recycle the oldest point (a pool of 10 vectors, no allocation per frame).
      const pt = this.trailPts.length >= 10 ? this.trailPts.pop()! : this.trailSpare.pop() ?? new Vector3();
      this.trailPts.unshift(pt.copy(this.ball.position));
    } else if (this.trailPts.length && (dtSim > 0 || jumped)) this.trailSpare.push(this.trailPts.pop()!);
    for (let i = 0; i < this.trailPts.length; i++) {
      const p = this.trailPts[i];
      const k = 1 - i / 11;
      this.m4.makeScale(k, k, k).setPosition(p.x, p.y, p.z);
      this.trail.setMatrixAt(i, this.m4);
    }
    this.trail.count = Math.max(0, this.trailPts.length - 1);
    this.trail.instanceMatrix.needsUpdate = true;
    const h = Math.max(0, this.ball.position.y - BALL_VIS_R);
    this.blob.position.set(this.ball.position.x, 0.02, this.ball.position.z);
    this.blob.scale.setScalar(0.5 + h * 0.12);
    (this.blob.material as MeshBasicMaterial).opacity = Math.max(0.15, 0.9 - h * 0.18);

    const tStadium = performance.now();
    // Nets and crowd.
    const lastGoal = s.events.length ? s.events[s.events.length - 1] : null;
    const celebrating = s.phase === 'goal' && lastGoal ? lastGoal.team : -1;
    const owner = holder ? holder.team : -1;
    const st = this.stadiumFrame;
    for (const team of [0, 1] as const) {
      const nearGoal = owner === team && Math.abs(b.pos.x - oppGoal(s, team).x) < 18;
      st.excite[team] = celebrating === team ? 1 : nearGoal ? 0.45 : 0.08;
    }
    st.ball.x = this.ball.position.x;
    st.ball.y = this.ball.position.z;
    st.ball.z = h;
    st.ball.speed = sp;
    if (this.stadium) {
      if (dir.goal) this.stadium.ripple(dir.goal.side, this.ball.position, dir.goal.speed);
      this.stadium.update(dt, clock, st);
    }

    const tScene = performance.now();
    // Camera.
    if (this.celebrate && (clock > this.celebrate.until || s.phase !== 'goal')) this.celebrate = null;
    const cel = this.celebrate ? s.players[this.celebrate.i] : null;
    // The camera follows what is drawn (extrapolated, as above), not the tick positions, which step
    // every 1/60 s and would make the follow judder on a fast screen.
    const fv = holder ? holder.vel : b.vel;
    let focusX = (holder ? holder.pos.x * 0.6 + b.pos.x * 0.4 : b.pos.x) + fv.x * lead;
    let focusY = (holder ? holder.pos.y * 0.6 + b.pos.y * 0.4 : b.pos.y) + fv.y * lead;
    // Set pieces: frame what matters. A corner or free kick shows the spot and the box it is aimed at,
    // a throw-in the thrower and the play in front of him.
    if (restart && restart.stage !== 'whistle') {
      const gx = oppGoal(s, restart.team).x;
      const k = restart.kind === 'corner' ? 0.2 : restart.kind === 'freekick' || restart.kind === 'penalty' ? 0.3 : 0;
      focusX = restart.spot.x + (gx - restart.spot.x) * k;
      focusY = restart.spot.y + (HALF_H - restart.spot.y) * (restart.kind === 'throwin' ? 0.2 : k);
    }
    // A booking: frame the referee and the player he is showing the card to.
    if (this.cardFace && clock < this.cardFace.until && s.referee) {
      const q = s.players[this.cardFace.player];
      if (q && !q.sentOff) {
        focusX = (q.pos.x + s.referee.pos.x) / 2;
        focusY = (q.pos.y + s.referee.pos.y) / 2;
      }
    }
    // Replays follow the ball itself, tightly.
    if (this.replayShot) {
      focusX = b.pos.x + b.vel.x * lead;
      focusY = b.pos.y + b.vel.y * lead;
    }
    // The long view holds a moment after the kick, so the player sees the ball arrive, then eases back.
    let lv = this.replayShot ? null : longView(s, this.me);
    if (lv) this.longHold = { ...lv, until: clock + 0.9 };
    else if (this.longHold && !this.replayShot && !jumped && clock < this.longHold.until && s.phase === 'play') lv = this.longHold;
    else this.longHold = null;
    if (!!lv !== this.longViewOn) this.reframeUntil = t0 + 1200;
    // A re-framing (a zoom easing in, the long view coming or going) re-takes a still pointer's point
    // once, when it has settled, rather than every frame while it moves (which let a runner drift).
    if (this.reframeUntil && t0 >= this.reframeUntil) {
      this.reframeUntil = 0;
      this.cutCount++;
    }
    this.longViewOn = !!lv;
    const camName = this.replayShot ? `replay-${this.replayShot.kind}` : lv ? lv.kind : this.cam.mode;
    if (this.canvas.dataset.camera !== camName) this.canvas.dataset.camera = camName;
    const rs = this.replayShot;
    // One focus object, refilled each frame; only the rarer parts (celebration, long view, replay) allocate.
    const f = this.focus;
    f.x = sx(focusX);
    f.z = sz(focusY);
    f.vx = b.vel.x;
    f.vz = b.vel.y;
    f.air = b.z;
    f.attack = holder && s.phase === 'play' ? attackDir(s, holder.team) : 0;
    f.phase = s.phase;
    f.close = cel && !this.replayShot ? { x: sx(cel.pos.x), z: sz(cel.pos.y) } : null;
    f.humanDir = attackDir(s, this.me) as 1 | -1;
    f.long = lv ? { points: lv.points.map((p) => ({ x: sx(p.x), z: sz(p.y) })), corner: lv.kind !== 'long' } : null;
    f.replay = rs ? { kind: rs.kind, goalX: sx(rs.goalX) } : null;
    this.cam.update(
      dt,
      f,
      this.cssW / this.cssH,
      this.cssW,
      this.reduced,
    );
    const camPos = this.cam.camera.position;
    const camDist = camPos.distanceTo(this.cam.target);
    if (this.stadium) {
      const st = this.stadium.stands;
      // A stand the camera sits in or looks through goes to layer 1: still casting its
      // shadow on the pitch (the sun's shadow camera sees layer 1), but not drawn.
      const bd = this.stadium.boards;
      const near = camPos.z < HALF_H + 4;
      const far = camPos.z > -HALF_H - 4;
      const left = camPos.x > -HALF_W - 4;
      const right = camPos.x < HALF_W + 4;
      this.standLayer(st.near, near);
      this.standLayer(st.far, far);
      this.standLayer(st.left, left);
      this.standLayer(st.right, right);
      // The boards between the camera and the pitch would hide the near touchline: same treatment.
      this.standLayer(bd.near, near);
      this.standLayer(bd.far, far);
      this.standLayer(bd.left, left);
      this.standLayer(bd.right, right);
    }

    // Shadows follow the view, snapped to texels so they don't shimmer.
    const tgt = this.cam.target;
    const texel = (this.sun.shadow.camera.right * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(tgt.x / texel) * texel;
    const fz = Math.round((tgt.z - 6) / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx - 55, 70, fz + 78);
    this.sun.target.updateMatrixWorld();

    if (this.aim) {
      const af = this.aimFrame;
      af.s = s;
      af.x = x;
      af.heads = this.heads;
      af.ball = this.ball.position;
      af.time = clock;
      af.reduced = this.reduced;
      af.camDist = camDist;
      this.aim.update(af);
    }
    this.edgeMarks(s, !!x.noAim);
    // The controlled player has his own marker; the sent off have left.
    const dotted = (i: number) => !s.players[i].sentOff && !(s.humans[s.players[i].team] && s.controlled[s.players[i].team] === i);
    this.dots?.update(this.heads, dotted, playerPx(this.cam.camera, this.cam.target, this.cssH), this.pixelRatio);
    const dotsOn = !!this.dots?.object.visible;
    if (dotsOn !== this.dotsOn) this.canvas.dataset.dots = (this.dotsOn = dotsOn) ? 'on' : 'off';

    // Placed after the scene's matrix pass above: the ball, its shadow blob, the sun and the overlays.
    this.ball.updateMatrixWorld();
    this.blob.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.aim?.group.updateMatrixWorld();
    // Governor step: the shadow map is redrawn every shadowEvery-th frame only (the shadow pass is
    // a second draw of every caster).
    if (this.shadowEvery > 1) this.gl.shadowMap.needsUpdate = ++this.frameNo % this.shadowEvery === 0;
    const tSubmit = performance.now();
    this.gl.render(this.scene, this.cam.camera);

    // Frame stats, and the quality governor: slow machines step down (governor.ts).
    const tEnd = performance.now();
    const ms = tEnd - t0;
    // Where the frame's CPU time went, by the parts of FRAME_BUDGET (budget.ts).
    const pm = this.partMs;
    pm[0] += tPlayers - t0;
    pm[1] += tStadium - tPlayers;
    pm[2] += tScene - tStadium;
    pm[3] += tSubmit - tScene;
    pm[4] += tEnd - tSubmit;
    const level = this.governor?.sample(ms, dt * 1000, t0);
    if (level) this.applyLevel(level);
    this.fpsFrames++;
    if (t0 - this.fpsAt > 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (t0 - this.fpsAt || 1000));
      this.fpsAt = t0;
      this.fpsLast = this.fpsFrames;
      this.fpsFrames = 0;
      this.canvas.dataset.fps = String(this.fps);
      this.canvas.dataset.cpuMs = ms.toFixed(1);
      this.canvas.dataset.calls = String(this.gl.info.render.calls);
      this.canvas.dataset.tris = String(this.gl.info.render.triangles);
      // Average ms per frame over the last second, e.g. "setup:0.2 players:1.1 stadium:0.3 scene:0.4 submit:2.0".
      this.canvas.dataset.parts = FRAME_PARTS.map((k, i) => `${k}:${(pm[i] / (this.fpsLast || 1)).toFixed(2)}`).join(' ');
      pm.fill(0);
    }
  }

  private applyLevel(st: GovernorState): void {
    this.shadowEvery = st.shadowEvery;
    this.gl.shadowMap.autoUpdate = st.shadowEvery === 1;
    // Level 0 is no cap at all, so a devicePixelRatio change still picks the full ratio.
    this.pixelCap = st.level === 0 ? Infinity : st.pixelRatio;
    const ratio = Math.min(this.basePixelRatio(), this.pixelCap);
    if (ratio !== this.pixelRatio) {
      this.pixelRatio = ratio;
      this.gl.setPixelRatio(ratio);
      this.resize();
    }
    this.canvas.dataset.governor = String(st.level);
  }

  private disposed = false;

  private standLayer(o: Object3D, shown: boolean): void {
    if (o.userData.shown === shown) return;
    o.userData.shown = shown;
    o.traverse((c) => c.layers.set(shown ? 0 : 1));
  }

  private marks: HTMLElement[] = [];
  private markV = new Vector3();

  /**
   * The man a human steers is sometimes off-screen (a cone click can pick a teammate the camera
   * isn't showing): then an arrow with his name sits on the frame edge, pointing at him.
   */
  private edgeMarks(s: MatchState, hide: boolean): void {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const both = s.humans[0] && s.humans[1];
    for (const t of [0, 1] as const) {
      const i = s.humans[t] ? s.controlled[t] : -1;
      let el = this.marks[t];
      const p = i >= 0 ? s.players[i] : null;
      const head = i >= 0 ? this.heads[i] : null;
      const v = this.markV;
      let off = false;
      if (p && head && !hide && !p.sentOff) {
        v.copy(head).project(this.cam.camera);
        // Behind the camera, the projection mirrors: flip it so the arrow still points the right way.
        if (v.z > 1) v.set(-v.x, -v.y, v.z);
        off = Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
      }
      if (!off) {
        if (el && !el.hidden) el.hidden = true;
        continue;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'edge-mark';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<i></i><span></span>';
        wrap.appendChild(el);
        this.marks[t] = el;
      }
      // Push the point onto the inset frame edge along the line from the centre.
      const k = Math.max(Math.abs(v.x) / 0.9, Math.abs(v.y) / 0.82);
      const ex = v.x / k;
      const ey = v.y / k;
      el.hidden = false;
      el.style.left = `${((ex + 1) / 2) * this.cssW}px`;
      el.style.top = `${((1 - ey) / 2) * this.cssH}px`;
      el.style.setProperty('--a', `${Math.atan2(-v.y, v.x)}rad`);
      el.style.setProperty('--c', both && t === 1 ? '#22d3ee' : '#ff8a1c');
      const name = el.querySelector('span')!;
      if (name.textContent !== p!.name) name.textContent = p!.name;
    }
  }

  /**
   * three.js keeps a few module-level singletons that every renderer uploads: the Sprite quad
   * geometry and the DFG lookup texture of the standard material. Each WebGLRenderer hangs a dispose
   * listener on them that closes over its GL context, so after a match they would pin that context,
   * its canvas, the detached match DOM and every closure on it (about 3 MB of heap and 10-20 MB of
   * canvas backing per match). Disposing every geometry and every texture uniform the scene uses,
   * singletons included, fires those listeners and removes them. A singleton is re-uploaded by the
   * next renderer that draws it, so this is safe with another renderer alive.
   */
  private releaseShared(): void {
    const geos = new Set<{ dispose(): void }>();
    const textures = new Set<{ dispose(): void }>();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) geos.add(m.geometry);
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        const uniforms = (this.gl.properties.get(mat) as { uniforms?: Record<string, { value: unknown }> }).uniforms;
        for (const u of Object.values(uniforms ?? {})) {
          const v = u?.value as { isTexture?: boolean; dispose(): void } | null;
          if (v && v.isTexture) textures.add(v);
        }
      }
    });
    for (const g of geos) g.dispose();
    for (const t of textures) t.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lost = true;
    for (const c of this.cleanup) c();
    this.releaseShared();
    for (const p of this.players) p.dispose();
    this.referee?.dispose();
    this.kit.dispose();
    this.aim?.dispose();
    this.dots?.dispose();
    this.stadium?.dispose();
    this.ball.geometry.dispose();
    (this.ball.material as MeshStandardMaterial).dispose();
    this.blob.geometry.dispose();
    this.trail.geometry.dispose();
    (this.trail.material as MeshBasicMaterial).dispose();
    this.trail.dispose();
    (this.blob.material as MeshBasicMaterial).dispose();
    this.blobMat.map?.dispose();
    this.blobMat.dispose();
    this.feet?.geometry.dispose();
    this.feet?.dispose();
    this.sun.shadow.map?.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
    delete this.canvas.dataset.renderer;
    for (const m of this.marks) m?.remove();
  }
}
