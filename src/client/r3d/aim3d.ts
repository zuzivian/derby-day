// Aim feedback and overhead indicators, all world-anchored: the pointer ring,
// the target reticle and aim wedge, pass/through/chip previews, the marker
// and ground ring under the controlled player, stamina bars and name tags.

import { AIR_DRAG, CHIP_Z0, GRAVITY } from '../../sim/constants.ts';
import { pickTeammate } from '../../sim/human.ts';
import { humanPass, loftPlan, pointerPass } from '../../sim/kicks.ts';
import type { MatchPlayer, MatchState } from '../../sim/types.ts';
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

const flat = (m: Object3D, y = 0.03) => {
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  return m;
};

function overlay(color: string, opacity = 1, depthTest = true): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest, side: DoubleSide, toneMapped: false });
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

const WEDGE_FRAG = `
uniform vec3 color; uniform float opacity; varying vec2 vUv;
void main(){ float a = opacity * (0.85 - 0.6 * vUv.x) * smoothstep(0.0, 0.08, vUv.x); float edge = 1.0 - abs(vUv.y - 0.5) * 2.0; gl_FragColor = vec4(color, a * (0.55 + 0.45 * smoothstep(0.0, 0.35, edge))); }`;
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

function nameTexture(text: string): { tex: CanvasTexture; aspect: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = `italic 800 44px 'Barlow', 'Arial Narrow', Arial, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w;
  c.height = 64;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(text, w / 2, 34);
  g.fillStyle = ORANGE;
  g.fillText(text, w / 2, 34);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return { tex, aspect: w / 64 };
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
  private pointer: Mesh;
  private reticle: Group;
  private wedge: Mesh;
  private wedgeMat: ShaderMaterial;
  private recvRing: Mesh;
  private switchRing: Mesh;
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
  private m4 = new Matrix4();

  constructor(nPlayers: number) {
    const keepM = <T extends Material>(m: T) => (this.mats.push(m), m);
    const keepG = <T extends BufferGeometry>(g: T) => (this.geos.push(g), g);

    // Orange ring at the pointer.
    this.pointer = flat(new Mesh(keepG(new RingGeometry(0.42, 0.56, 40)), keepM(overlay(ORANGE, 0.95))), 0.04) as Mesh;
    this.pointer.renderOrder = 5;

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
        uniforms: { color: { value: new Color('#ffffff') }, opacity: { value: 0.5 } },
        vertexShader: UV_VERT,
        fragmentShader: WEDGE_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.wedge = new Mesh(keepG(wedgeGeometry()), this.wedgeMat);
    this.wedge.position.y = 0.035;
    this.wedge.renderOrder = 4;

    this.recvRing = flat(new Mesh(keepG(new RingGeometry(0.85, 1.0, 40)), keepM(overlay('#ffffff', 0.75))), 0.04) as Mesh;
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

    this.group.add(this.pointer, this.reticle, this.wedge, this.recvRing, this.switchRing, this.chipDots, this.chipRing, ...this.markers, ...this.rings, this.bars);
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
      this.names.set(p.i, sp);
      this.group.add(sp);
    }
    return sp;
  }

  /** Show a booking over this player for a while. */
  card(player: number, color: 'yellow' | 'red', until: number): void {
    let c = this.cards.get(player);
    if (!c) {
      const mat = new SpriteMaterial({ color: color === 'red' ? '#e11d2e' : '#ffd60a', depthTest: false, toneMapped: false });
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
    const live = s.phase === 'play' || s.phase === 'kickoff';
    const hasBall = !!ctrl && s.ball.owner === ctrl.i && s.phase === 'play';
    const cursor = x.cursor;
    // World overlays grow a little with camera distance so they stay readable when zoomed out.
    const k = Math.max(0.8, Math.min(1.5, f.camDist / 40));

    this.pointer.visible = !!cursor && x.showCursor && live;
    if (cursor && this.pointer.visible) {
      this.pointer.position.set(sx(cursor.x), 0.04, sz(cursor.y));
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
    let wedgeColor = '#ffffff';
    let wedgeAlpha = 0.42;
    if (ctrl && hasBall && aimAt) {
      tx = aimAt.x;
      ty = aimAt.y;
      if (armed?.kind === 'loft') {
        // Lofted ball: the real flight as dots in the air, and the landing ring.
        const plan = loftPlan(s.ball.pos, aimAt, armed.power);
        this.chipArc(s.ball.pos, plan.landing, plan.speed, plan.vz);
        tx = plan.landing.x;
        ty = plan.landing.y;
      } else if (armed?.kind === 'shot') {
        // Shot: a firmer wedge toward the pointer that warms to red past the sweet spot.
        showWedge = true;
        showRet = pointerOn;
        wedgeColor = armed.power > 0.85 ? '#ff5a3c' : '#ffffff';
        wedgeAlpha = 0.3 + 0.5 * x.charge;
      } else {
        // A click (or Space) would pass here.
        const r = pointerOn && cursor ? pointerPass(s, ctrl, cursor) : humanPass(s, ctrl, aimAt);
        tx = r.target.x;
        ty = r.target.y;
        showWedge = true;
        showRet = pointerOn;
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
        this.wedge.scale.set(L, 1, Math.min(2.2, 0.6 + L * 0.06));
        this.wedge.rotation.y = -Math.atan2(dz, dx);
        this.wedgeMat.uniforms.color.value.set(wedgeColor);
        this.wedgeMat.uniforms.opacity.value = wedgeAlpha;
      }
    } else if (ctrl && !hasBall && pointerOn && cursor && s.phase === 'play') {
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
    const ctrls = ([0, 1] as const).filter((t) => s.humans[t] && s.controlled[t] >= 0);
    for (const t of [0, 1] as const) {
      const on = ctrls.includes(t);
      const mk = this.markers[t];
      const rg = this.rings[t];
      mk.visible = on;
      rg.visible = on;
      if (!on) continue;
      const p = s.players[s.controlled[t]];
      const c = both ? t : 0;
      mk.material.color.set(MARK[c]);
      (rg.material as MeshBasicMaterial).color.set(RING[c]);
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
    for (const [i, c] of this.cards) {
      const head = f.heads[i];
      c.sprite.visible = f.time < c.until && !!head;
      if (head) c.sprite.position.set(head.x, head.y + 0.85, head.z);
    }
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
    this.bars.dispose();
    this.chipDots.dispose();
    this.group.removeFromParent();
  }
}
