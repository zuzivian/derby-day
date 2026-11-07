// Ground-level match juice, drawn only: a soft halo under the ball so it can be found at broadcast
// distance (and on a phone, where it is a couple of pixels), and short expanding rings where a
// tackle bites or a hard shot is struck. One ring texture, two draw calls. Nothing here feeds
// back into the match. Rings are skipped under reduced motion; the halo is static, so it stays.

import { AdditiveBlending, CanvasTexture, Color, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from './three.ts';

/** Rings alive at once (a tackle and a shot at the same time is rare). */
const POOL = 6;
/** How long a ring lives, s, and how far it grows, m (from a quarter of that). */
const LIFE = 0.42;

function ringTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 18, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,1)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

interface Ring {
  x: number;
  z: number;
  age: number;
  reach: number;
  tint: Color;
}

export class GroundFx {
  /** The ball halo and the pooled rings: add both to the scene. */
  readonly halo: Mesh;
  readonly rings: InstancedMesh;
  private live: Ring[] = [];
  private spare: Ring[] = [];
  private m = new Matrix4();
  private c = new Color();
  private v = new Vector3();
  private tex: CanvasTexture;
  private geo = new PlaneGeometry(1, 1);

  constructor() {
    this.tex = ringTexture();
    this.halo = new Mesh(this.geo, new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.5 }));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.renderOrder = 0.9;
    this.rings = new InstancedMesh(this.geo, new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, blending: AdditiveBlending }), POOL);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 0.95;
    this.rings.count = 0;
    // Every instance needs a colour slot before the first draw (it is the ring's fade).
    for (let i = 0; i < POOL; i++) this.rings.setColorAt(i, this.c.setScalar(0));
  }

  /** The halo under the ball at scene x/z, `diameter` m wide, this opaque (0 hides it). */
  setHalo(x: number, z: number, diameter: number, opacity: number): void {
    this.halo.visible = opacity > 0.01;
    this.halo.position.set(x, 0.03, z);
    this.halo.scale.setScalar(diameter);
    (this.halo.material as MeshBasicMaterial).opacity = opacity;
  }

  /** A ring at scene x/z reaching `reach` m across, in `tint`. */
  spawn(x: number, z: number, reach: number, tint: string): void {
    const r = this.live.length >= POOL ? this.live.shift()! : this.spare.pop() ?? { x: 0, z: 0, age: 0, reach: 0, tint: new Color() };
    r.x = x;
    r.z = z;
    r.age = 0;
    r.reach = reach;
    r.tint.set(tint);
    this.live.push(r);
  }

  update(dt: number): void {
    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      if ((live[i].age += dt) >= LIFE) this.spare.push(live.splice(i, 1)[0]);
    }
    for (let i = 0; i < live.length; i++) {
      const r = live[i];
      const t = r.age / LIFE;
      const out = 1 - (1 - t) ** 3;
      const d = r.reach * (0.25 + 0.75 * out);
      this.m.makeRotationX(-Math.PI / 2).scale(this.v.set(d, d, d)).setPosition(r.x, 0.04, r.z);
      this.rings.setMatrixAt(i, this.m);
      this.rings.setColorAt(i, this.c.copy(r.tint).multiplyScalar(0.7 * (1 - t) ** 2));
    }
    this.rings.count = live.length;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.tex.dispose();
    (this.halo.material as MeshBasicMaterial).dispose();
    (this.rings.material as MeshBasicMaterial).dispose();
    this.rings.dispose();
  }
}
