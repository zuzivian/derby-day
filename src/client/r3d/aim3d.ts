// Aim feedback and overhead indicators, all world-anchored: the pointer ring,
// the target reticle and aim wedge, pass/through/chip previews, the marker
// and ground ring under the controlled player, stamina bars and name tags.

import { AIR_DRAG, CHIP_Z0, GRAVITY, RETREAT } from '../../sim/constants.ts';
import { pickTeammate } from '../../sim/human.ts';
import { humanPass, kickAim, loftPlan, pointerPass, strikePath } from '../../sim/kicks.ts';
import { freeKickPlan, setPieceDelivery } from '../../sim/match.ts';
import type { MatchPlayer, MatchState } from '../../sim/types.ts';
import { GAUGE_COLORS, kickGauge } from '../power.ts';
import type { RenderExtras } from '../render.ts';
import { clamp01, sx, sz } from './space.ts';
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Material,
} from './three.ts';

export const ORANGE = '#ff8a1c';
/** Controlled-player colours: home orange (yellow ring), away cyan when two humans share a screen. */
const MARK: [string, string] = [ORANGE, '#22d3ee'];
const RING: [string, string] = ['#ffd60a', '#22d3ee'];
/** Parsed once: Color.set('#hex') parses the string (and allocates) every call, and these are set every frame. */
const colorCache = new Map<string, Color>();
const col = (hex: string): Color => {
  let c = colorCache.get(hex);
  if (!c) colorCache.set(hex, (c = new Color(hex)));
  return c;
};

const TEAMS = [0, 1] as const;

const flat = (m: Object3D, y = 0.03) => {
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
};

function overlay(color: string, opacity = 1, depthTest = true): MeshBasicMaterial {
  // forceSinglePass: a transparent double-sided material is otherwise drawn twice (back, then front),
  // and three rebuilds its program parameters on each pass; flat overlays don't need the two passes.
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest, side: DoubleSide, forceSinglePass: true, toneMapped: false });
}

/** Wedge from the player (narrow) to the target (wide), fading toward the tip. */
function wedgeGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  // x along the aim (0..1), z across; uv.x carries the fade.
  g.setAttribute('position', new Float32BufferAttribute([0, 0, -0.1, 1, 0, -0.45, 1, 0, 0.45, 0, 0, 0.1], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/**
 * The aim wedge doubles as the power gauge (src/client/power.ts): lit in the band's colour from the
 * player out to `fill` of its length, a faint white track beyond, a bright line at the fill's head
 * and a small notch where the sweet spot ends.
 */
const WEDGE_FRAG = `
uniform vec3 color; uniform vec3 track; uniform float opacity; uniform float fill; uniform float tick; varying vec2 vUv;
void main(){
  float x = vUv.x;
  float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float body = smoothstep(0.0, 0.06, x) * (0.55 + 0.45 * smoothstep(0.0, 0.35, edge));
  float lit = 1.0 - smoothstep(fill - 0.01, fill + 0.01, x);
  float head = (1.0 - smoothstep(0.0, 0.018, abs(x - fill))) * step(0.02, fill);
  float notch = (1.0 - smoothstep(0.0, 0.006, abs(x - tick))) * step(tick, 0.99) * step(0.6, 1.0 - edge);
  vec3 c = mix(track, color, max(lit, head));
  c = mix(c, vec3(1.0), notch * 0.9);
  float a = opacity * body * mix(0.38, 1.0, lit);
  a = max(a, head * 0.95 * opacity + 0.0);
  a = max(a, notch * 0.8);
  gl_FragColor = vec4(c, a);
}`;
const UV_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

/** Stamina bars: camera-facing quads, one instance per player, fill per instance. */
const BAR_VERT = `
attribute float aFill;
attribute float aAlpha;
varying vec2 vUv; varying float vFill; varying float vAlpha;
void main(){
  vUv = uv; vFill = aFill; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy;
  gl_Position = projectionMatrix * mv;
}`;
const BAR_FRAG = `
varying vec2 vUv; varying float vFill; varying float vAlpha;
uniform vec3 fillA; uniform vec3 fillLow;
void main(){
  vec2 px = vUv;
  float border = step(px.x, 0.03) + step(0.97, px.x) + step(px.y, 0.14) + step(0.86, px.y);
  vec3 fill = mix(fillLow, fillA, smoothstep(0.2, 0.45, vFill));
  vec3 c = px.x < vFill ? fill : vec3(0.06);
  c = border > 0.0 ? vec3(0.02) : c;
  if (vAlpha < 0.01) discard;
  gl_FragColor = vec4(c, 0.92 * vAlpha);
}`;

/** Downward triangle, white (tinted by the sprite colour) with a dark rim. */
function triangleTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 56;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.moveTo(6, 6);
  g.lineTo(58, 6);
  g.lineTo(32, 50);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.75)';
  g.stroke();
  g.fillStyle = '#ffffff';
  g.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function whiteTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 2, 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Name tag: orange on a dark pill, so it reads over grass, kits and the stands. The text is
 *  NAME_FONT / 64 of the sprite's height (see NAME_MIN_PX). */
const NAME_FONT = 40;
function nameTexture(text: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = `italic 800 ${NAME_FONT}px 'Barlow', 'Arial Narrow', Arial, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 36;
  c.width = w;
  c.height = 64;
  g.fillStyle = 'rgba(8,12,11,.72)';
  g.beginPath();
  g.roundRect(3, 6, w - 6, 52, 12);
  g.fill();
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(0,0,0,.9)';
  g.strokeText(text, w / 2, 33);
  g.fillStyle = ORANGE;
  g.fillText(text, w / 2, 33);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return { tex, aspect: w / 64 };
}

/** The tag never draws smaller than this on screen (CSS px of sprite height: 13 px text). */
const NAME_MIN_PX = Math.round((13 * 64) / NAME_FONT);
const tagPos = new Vector3();
/** Grow a name tag that the camera would draw too small to read (far zoom, a short canvas). */
export function keepTagLegible(this: Sprite, r: { domElement: HTMLCanvasElement }, _s: unknown, cam: { fov?: number; matrixWorldInverse: Matrix4 }): void {
  if (!cam.fov) return;
  const depth = -this.getWorldPosition(tagPos).applyMatrix4(cam.matrixWorldInverse).z;
  const h = r.domElement.clientHeight;
  if (depth <= 0 || !h) return;
  const px = (this.scale.y * h) / (2 * depth * Math.tan((cam.fov * Math.PI) / 360));
  if (px >= NAME_MIN_PX) return;
  const grow = NAME_MIN_PX / px;
  this.scale.x *= grow;
  this.scale.y *= grow;
  this.updateMatrixWorld();
}

export interface AimFrame {
  s: MatchState;
  x: RenderExtras;
  /** Scene positions of each player's head top (for overhead items). */
  heads: Vector3[];
  /** Ball centre in scene space. */
  ball: Vector3;
  time: number;
  reduced: boolean;
  /** Camera distance to its target, for sizing world-space overlays. */
  camDist: number;
}

export class AimLayer {
  readonly group = new Group();
  private mats: Material[] = [];
  private geos: BufferGeometry[] = [];
  private pointer: Group;
  private reticle: Group;
  private wedge: Mesh;
  private wedgeMat: ShaderMaterial;
  private recvRing: Mesh;
  private switchRing: Mesh;
  private retreat: Mesh;
  private chipDots: InstancedMesh;
  private chipRing: Mesh;
  private markers: Sprite[] = [];
  private rings: Mesh[] = [];
  private bars: InstancedMesh;
  private fill: Float32Array;
  private alpha: Float32Array;
  private names = new Map<number, Sprite>();
  private nameTex: CanvasTexture[] = [];
  private cards = new Map<number, { sprite: Sprite; until: number }>();
  /** Plain white, so a card sprite shares the textured sprite program prepare() compiles (no mid-match compile on the first booking). */
  private white = whiteTexture();
  private m4 = new Matrix4();

  constructor(nPlayers: number) {
    const keepM = <T extends Material>(m: T) => (this.mats.push(m), m);
    const keepG = <T extends BufferGeometry>(g: T) => (this.geos.push(g), g);

    // Orange ring at the pointer.
    // The pointer: a light ring with a dark outline, so it reads on any grass (the plain orange ring was
    // 1.15:1 against the pitch, 1.08:1 for protanopia; the OS cursor is hidden over the pitch).
    this.pointer = new Group();
    const ptrDark = flat(new Mesh(keepG(new RingGeometry(0.34, 0.66, 40)), keepM(overlay('#000000', 0.7))), 0.039);
    const ptrLight = flat(new Mesh(keepG(new RingGeometry(0.42, 0.57, 40)), keepM(overlay('#ffe2b8', 1))), 0.041);
    ptrDark.renderOrder = 5;
    ptrLight.renderOrder = 6;
    this.pointer.add(ptrDark, ptrLight);

    // White reticle: circle with four ticks.
    this.reticle = new Group();
    const retMat = keepM(overlay('#ffffff', 0.95));
    const circ = flat(new Mesh(keepG(new RingGeometry(0.62, 0.72, 40)), retMat), 0.045);
    this.reticle.add(circ);
    const tickG = keepG(new PlaneGeometry(0.45, 0.1));
    for (let i = 0; i < 4; i++) {
      const t = new Mesh(tickG, retMat);
      t.rotation.x = -Math.PI / 2;
      const a = (i * Math.PI) / 2;
      t.position.set(Math.cos(a) * 0.95, 0.045, Math.sin(a) * 0.95);
      t.rotation.z = a;
      this.reticle.add(t);
    }
    this.reticle.renderOrder = 5;

    this.wedgeMat = keepM(
      new ShaderMaterial({
        uniforms: { color: { value: new Color('#ffffff') }, track: { value: new Color('#ffffff') }, opacity: { value: 0.5 }, fill: { value: 0 }, tick: { value: 1 } },
        vertexShader: UV_VERT,
        fragmentShader: WEDGE_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        forceSinglePass: true,
      }),
    );
    this.wedge = new Mesh(keepG(wedgeGeometry()), this.wedgeMat);
    this.wedge.position.y = 0.035;
    this.wedge.renderOrder = 4;

    this.recvRing = flat(new Mesh(keepG(new RingGeometry(0.85, 1.0, 40)), keepM(overlay('#ffffff', 0.75))), 0.04) as Mesh;
    // Pale blue, not white, so it doesn't read as a pitch marking.
    this.retreat = flat(new Mesh(keepG(new RingGeometry(RETREAT - 0.06, RETREAT + 0.06, 96)), keepM(overlay('#9fd4ff', 0.6))), 0.03) as Mesh;
    this.retreat.renderOrder = 3;
    this.switchRing = flat(new Mesh(keepG(new RingGeometry(0.9, 1.08, 40)), keepM(overlay('#ffd60a', 0.9))), 0.04) as Mesh;

    this.chipDots = new InstancedMesh(keepG(new SphereGeometry(0.09, 8, 6)), keepM(new MeshBasicMaterial({ color: '#8cdcff', transparent: true, opacity: 0.9, toneMapped: false })), 28);
    this.chipDots.frustumCulled = false;
    this.chipRing = flat(new Mesh(keepG(new RingGeometry(0.75, 0.92, 40)), keepM(overlay('#8cdcff', 0.95))), 0.045) as Mesh;

    for (const t of [0, 1]) {
      const tex = triangleTexture();
      this.nameTex.push(tex);
      const m = new Sprite(keepM(new SpriteMaterial({ map: tex, color: MARK[t], depthTest: false, transparent: true, toneMapped: false })));
      m.center.set(0.5, 0);
      m.renderOrder = 20;
      this.markers.push(m);
      const r = flat(new Mesh(keepG(new RingGeometry(0.62, 0.78, 40)), keepM(overlay(RING[t], 0.95))), 0.035) as Mesh;
      r.renderOrder = 3;
      this.rings.push(r);
    }

    const barMat = keepM(
      new ShaderMaterial({
        uniforms: { fillA: { value: new Color(ORANGE) }, fillLow: { value: new Color('#ff3b2a') } },
        vertexShader: BAR_VERT,
        fragmentShader: BAR_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    const barGeo = keepG(new PlaneGeometry(0.85, 0.13));
    this.fill = new Float32Array(nPlayers);
    this.alpha = new Float32Array(nPlayers);
    barGeo.setAttribute('aFill', new InstancedBufferAttribute(this.fill, 1));
    barGeo.setAttribute('aAlpha', new InstancedBufferAttribute(this.alpha, 1));
    this.bars = new InstancedMesh(barGeo, barMat, nPlayers);
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 19;

    this.group.add(this.pointer, this.reticle, this.wedge, this.recvRing, this.switchRing, this.retreat, this.chipDots, this.chipRing, ...this.markers, ...this.rings, this.bars);
  }

  private name(p: MatchPlayer): Sprite {
    let sp = this.names.get(p.i);
    if (!sp) {
      const { tex, aspect } = nameTexture(p.name);
      this.nameTex.push(tex);
      const mat = new SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false });
      this.mats.push(mat);
      sp = new Sprite(mat);
      sp.scale.set(0.5 * aspect, 0.5, 1);
      sp.renderOrder = 21;
      sp.center.set(0.5, 0);
      sp.onBeforeRender = keepTagLegible as Sprite['onBeforeRender'];
      this.names.set(p.i, sp);
      this.group.add(sp);
    }
    return sp;
  }

  /** Show a booking over this player for a while. */
  /** Hide every booking card (a jump in the timeline: an instant replay starts or ends). */
  clearCards(): void {
    for (const c of this.cards.values()) {
      c.until = -Infinity;
      c.sprite.visible = false;
    }
  }

  card(player: number, color: 'yellow' | 'red', until: number): void {
    let c = this.cards.get(player);
    if (!c) {
      const mat = new SpriteMaterial({ map: this.white, color: color === 'red' ? '#e11d2e' : '#ffd60a', depthTest: false, toneMapped: false });
      this.mats.push(mat);
      c = { sprite: new Sprite(mat), until };
      c.sprite.scale.set(0.32, 0.45, 1);
      c.sprite.renderOrder = 22;
      this.group.add(c.sprite);
      this.cards.set(player, c);
    }
    c.sprite.material.color.set(color === 'red' ? '#e11d2e' : '#ffd60a');
    c.until = until;
  }

  update(f: AimFrame): void {
    const { s, x } = f;
    const me: 0 | 1 = x.team ?? (s.humans[0] || !s.humans[1] ? 0 : 1);
    const both = s.humans[0] && s.humans[1];
    const ctrl = s.controlled[me] >= 0 && s.humans[me] ? s.players[s.controlled[me]] : null;
    const live = s.phase === 'play' || s.phase === 'kickoff' || s.phase === 'restart';
    // A human taking a set piece aims it like any other kick.
    const hasBall = !x.noAim && !!ctrl && s.ball.owner === ctrl.i && (s.phase === 'play' || (s.phase === 'restart' && s.restart?.stage === 'ready'));
    const cursor = x.cursor;
    // World overlays grow a little with camera distance so they stay readable when zoomed out.
    const k = Math.max(0.8, Math.min(1.5, f.camDist / 40));

    this.pointer.visible = !!cursor && x.showCursor && live && !x.noAim;
    if (cursor && this.pointer.visible) {
      this.pointer.position.set(sx(cursor.x), 0, sz(cursor.y));
      this.pointer.scale.setScalar(k);
    }

    // Aim: wedge from the player toward the target, reticle at the target.
    let showWedge = false;
    let showRet = false;
    this.recvRing.visible = false;
    this.chipDots.visible = false;
    this.chipRing.visible = false;
    const pointerOn = !!cursor && x.showCursor;
    // Keys: aim where the player faces (that is where Space passes and F shoots).
    const aimAt = pointerOn ? cursor : ctrl ? { x: ctrl.pos.x + ctrl.facing.x * 14, y: ctrl.pos.y + ctrl.facing.y * 14 } : null;
    const armed = x.armed;
    this.switchRing.visible = false;
    let tx = 0;
    let ty = 0;
    let wedgeAlpha = 0.6;
    const gauge = hasBall ? kickGauge(s, x) : null;
    if (ctrl && hasBall && aimAt) {
      tx = aimAt.x;
      ty = aimAt.y;
      showWedge = true;
      showRet = pointerOn;
      if (armed?.kind === 'loft' && armed.at) {
        // A cross from a corner or a free kick: its real flight as dots (driven or floated, swung by the drag),
        // and the ring where it comes down, where the button went down.
        const plan = setPieceDelivery(s, ctrl, armed.at, armed.power, armed.curl ?? 0);
        this.dotPath(strikePath(plan.from, plan, this.chipDots.count - 1));
        this.chipRing.visible = true;
        this.chipRing.position.set(sx(plan.landing.x), 0.045, sz(plan.landing.y));
        tx = plan.landing.x;
        ty = plan.landing.y;
        showRet = false;
        wedgeAlpha = 0.75;
      } else if (armed?.kind === 'loft') {
        // Lofted ball: the real flight as dots in the air, and the landing ring. The wedge under it
        // runs to the landing spot, lit as far as the hold has charged.
        const plan = loftPlan(s.ball.pos, pointerOn ? kickAim(s.ball.pos, ctrl, aimAt, 40) : aimAt, armed.power);
        this.chipArc(s.ball.pos, plan.landing, plan.speed, plan.vz);
        tx = plan.landing.x;
        ty = plan.landing.y;
        showRet = false;
        wedgeAlpha = 0.75;
      } else if (armed?.kind === 'shot' && armed.at) {
        // Over a free kick: the strike's real flight as dots (over the wall and dipping, bent by the drag),
        // and the ring where it crosses the goal line. The wedge points the way it sets off.
        const plan = freeKickPlan(s, ctrl, armed.at, armed.power, armed.curl ?? 0);
        const pts = strikePath(plan.from, plan, this.chipDots.count - 1);
        this.dotPath(pts);
        const end = pts[pts.length - 1];
        this.chipRing.visible = true;
        this.chipRing.position.set(sx(end.x), 0.045, sz(end.y));
        tx = plan.from.x + plan.dir.x * 6;
        ty = plan.from.y + plan.dir.y * 6;
        showRet = false;
        wedgeAlpha = 0.85;
      } else if (armed?.kind === 'shot') {
        // Shot: a firmer wedge toward the pointer, filling with power, green to amber to red.
        if (pointerOn) ({ x: tx, y: ty } = kickAim(s.ball.pos, ctrl, aimAt, 20));
        wedgeAlpha = 0.85;
      } else {
        // A click (or Space) would pass here, at the pace the wedge shows.
        const r = pointerOn && cursor ? pointerPass(s, ctrl, cursor) : humanPass(s, ctrl, aimAt);
        tx = r.target.x;
        ty = r.target.y;
        if (r.receiver >= 0) {
          const m = s.players[r.receiver];
          this.recvRing.visible = true;
          this.recvRing.position.set(sx(m.pos.x), 0.04, sz(m.pos.y));
        }
      }
      if (showWedge) {
        const ox = sx(ctrl.pos.x);
        const oz = sz(ctrl.pos.y);
        const dx = sx(tx) - ox;
        const dz = sz(ty) - oz;
        const L = Math.max(0.5, Math.hypot(dx, dz));
        this.wedge.position.set(ox, 0.035, oz);
        this.wedge.scale.set(L, 1, Math.min(2.4, 0.7 + L * 0.06) * Math.max(1, k * 0.9));
        this.wedge.rotation.y = -Math.atan2(dz, dx);
        const u = this.wedgeMat.uniforms;
        u.color.value.copy(col(gauge ? GAUGE_COLORS[gauge.band] : '#ffffff'));
        u.fill.value = gauge ? gauge.fill : 0;
        u.tick.value = gauge ? gauge.tick : 1;
        u.opacity.value = wedgeAlpha;
        (this.chipRing.material as MeshBasicMaterial).color.copy(col(gauge && armed?.kind === 'loft' ? GAUGE_COLORS[gauge.band] : '#8cdcff'));
      }
    } else if (ctrl && !hasBall && pointerOn && cursor && s.phase === 'play' && !x.noAim) {
      // No ball: who a left click would switch to.
      const pick = x.switchTo ?? pickTeammate(s, me, cursor);
      if (pick >= 0 && pick !== ctrl.i) {
        const m = s.players[pick];
        this.switchRing.visible = true;
        this.switchRing.position.set(sx(m.pos.x), 0.04, sz(m.pos.y));
        this.switchRing.scale.setScalar(1 + (f.reduced ? 0 : Math.sin(f.time * 6) * 0.06));
      }
    }
    if (showRet) {
      this.reticle.position.set(sx(tx), 0, sz(ty));
      this.reticle.scale.setScalar(k);
      this.reticle.rotation.y = f.reduced ? 0 : f.time * 0.8;
    }
    this.wedge.visible = showWedge;
    this.reticle.visible = showRet;

    // Controlled players: marker over the head and a ring on the ground.
    for (const t of TEAMS) {
      const on = s.humans[t] && s.controlled[t] >= 0;
      const mk = this.markers[t];
      const rg = this.rings[t];
      mk.visible = on;
      rg.visible = on;
      if (!on) continue;
      const p = s.players[s.controlled[t]];
      const c = both ? t : 0;
      mk.material.color.copy(col(MARK[c]));
      (rg.material as MeshBasicMaterial).color.copy(col(RING[c]));
      const head = f.heads[p.i];
      const bob = f.reduced ? 0 : Math.sin(f.time * 4) * 0.06;
      mk.position.set(head.x, head.y + 0.55 * k + bob, head.z);
      mk.scale.set(0.55 * k, 0.46 * k, 1);
      rg.position.set(head.x, 0.035, head.z);
    }

    // Stamina bars over the human team(s); names over the controlled player and whoever is near the ball.
    const bx = s.ball.pos.x;
    const by = s.ball.pos.y;
    const showBarsFor = (p: MatchPlayer) => s.humans[p.team];
    for (const p of s.players) {
      const head = f.heads[p.i];
      if (p.sentOff) {
        this.alpha[p.i] = 0;
        const n = this.names.get(p.i);
        if (n) n.visible = false;
        continue;
      }
      const isCtrl = s.humans[p.team] && s.controlled[p.team] === p.i;
      const near = Math.hypot(p.pos.x - bx, p.pos.y - by) < 6;
      const level = clamp01((p.energy - 0.4) / 0.6);
      const bar = showBarsFor(p) && live;
      this.fill[p.i] = p.winded ? Math.min(level, 0.18) : level;
      this.alpha[p.i] = bar ? (isCtrl ? 1 : 0.75) : 0;
      this.m4.makeTranslation(head.x, head.y + 0.28 * k, head.z);
      this.bars.setMatrixAt(p.i, this.m4);
      const showName = live && (isCtrl || (near && s.ball.owner === p.i));
      const existing = this.names.get(p.i);
      if (showName) {
        const sp = this.name(p);
        sp.visible = true;
        sp.position.set(head.x, head.y + (isCtrl ? 1.3 : 0.45) * k, head.z);
        sp.scale.set(0.5 * k * (sp.material.map!.image.width / 64), 0.5 * k, 1);
      } else if (existing) existing.visible = false;
    }
    this.bars.instanceMatrix.needsUpdate = true;
    (this.bars.geometry.attributes.aFill as InstancedBufferAttribute).needsUpdate = true;
    (this.bars.geometry.attributes.aAlpha as InstancedBufferAttribute).needsUpdate = true;
    // Free kicks and corners: the 9.15 m the defending side must give, while it is being set up.
    const r = s.restart;
    const ring = !!r && (r.kind === 'freekick' || r.kind === 'corner') && r.stage !== 'whistle';
    this.retreat.visible = ring;
    if (r && ring) this.retreat.position.set(sx(r.spot.x), 0.03, sz(r.spot.y));
    for (const [i, c] of this.cards) {
      const head = f.heads[i];
      c.sprite.visible = f.time < c.until && !!head && !s.players[i]?.sentOff;
      if (head) c.sprite.position.set(head.x, head.y + 0.85, head.z);
    }
  }

  /** Dots along a path in the air (world metres, z up). */
  private dotPath(pts: { x: number; y: number; z: number }[]): void {
    const n = Math.min(this.chipDots.count, pts.length);
    for (let i = 0; i < n; i++) {
      this.m4.makeTranslation(sx(pts[i].x), Math.max(0.1, pts[i].z + 0.12), sz(pts[i].y));
      this.chipDots.setMatrixAt(i, this.m4);
    }
    this.chipDots.instanceMatrix.needsUpdate = true;
    this.chipDots.visible = true;
  }

  private chipArc(from: { x: number; y: number }, landing: { x: number; y: number }, speed: number, vz0: number): void {
    // The real flight: horizontal drag, gravity, from CHIP_Z0.
    const dx = landing.x - from.x;
    const dy = landing.y - from.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    const n = this.chipDots.count;
    let z = CHIP_Z0;
    let vz = vz0;
    let v = speed;
    let d = 0;
    const flight = (2 * vz0 + Math.sqrt(4 * vz0 * vz0 + 8 * GRAVITY * CHIP_Z0)) / (2 * GRAVITY);
    const dt = flight / (n - 1);
    for (let i = 0; i < n; i++) {
      this.m4.makeTranslation(sx(from.x + ux * d), Math.max(0.1, z + 0.12), sz(from.y + uy * d));
      this.chipDots.setMatrixAt(i, this.m4);
      d += v * dt;
      v *= 1 - AIR_DRAG * dt;
      vz -= GRAVITY * dt;
      z += vz * dt;
    }
    this.chipDots.instanceMatrix.needsUpdate = true;
    this.chipDots.visible = true;
    this.chipRing.visible = true;
    this.chipRing.position.set(sx(landing.x), 0.045, sz(landing.y));
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
    for (const t of this.nameTex) t.dispose();
    this.white.dispose();
    this.bars.dispose();
    this.chipDots.dispose();
    this.group.removeFromParent();
  }
}
