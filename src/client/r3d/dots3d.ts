// Player dots, for when players are too small on screen to read: the long view on an upright phone
// draws them about 4 to 5 px tall (review of #19). Then each player gets a disc over his head in his
// shirt colour, with a dark outline so it reads on the grass, the same size on screen however far
// away he is. All of them are one draw call (Points). They fade in as players shrink below DOT_BELOW
// px tall and are gone above it, so the normal broadcast view is unchanged.

import { clamp01 } from './space.ts';
import { BufferAttribute, BufferGeometry, CanvasTexture, Color, Points, PointsMaterial, SRGBColorSpace, Vector3, type PerspectiveCamera } from './three.ts';

/** Dots show when a player would be drawn shorter than this, CSS px (fully in by DOT_BELOW - DOT_FADE). */
export const DOT_BELOW = 11;
export const DOT_FADE = 3;
/**
 * Draw order: after the pitch and the players (the dots ignore depth, so they show over them), but
 * before the shadow blobs (1), the ball (1.5) and the aim layer (3 and up: the controlled player's
 * ring and marker, the pointer, the wedge), so none of those is ever covered by a dot.
 */
export const DOT_ORDER = 0.9;
/** Dot diameter, CSS px. */
export const DOT_PX = 10;

/** How tall a 1.8 m player standing at the camera's target is drawn, in CSS px. */
export function playerPx(cam: PerspectiveCamera, target: Vector3, cssH: number): number {
  const a = tmpA.set(target.x, 0, target.z).project(cam);
  const b = tmpB.set(target.x, 1.8, target.z).project(cam);
  return Math.abs(b.y - a.y) * 0.5 * cssH;
}
const tmpA = new Vector3();
const tmpB = new Vector3();

/** How much of the dots to show for players drawn this many px tall: 0 (none) to 1. */
export function dotAlpha(px: number): number {
  return clamp01((DOT_BELOW - px) / DOT_FADE);
}

/** White disc with a dark rim (the vertex colour tints the white; the rim stays dark). */
function discTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fillStyle = '#0b0b0b';
  g.fill();
  g.beginPath();
  g.arc(32, 32, 21, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class PlayerDots {
  readonly object: Points;
  private geo = new BufferGeometry();
  private mat: PointsMaterial;
  private tex = discTexture();
  private pos: Float32Array;
  private col: Float32Array;

  /** One colour per player (his shirt), in player index order. */
  constructor(colors: string[]) {
    const n = colors.length;
    this.pos = new Float32Array(n * 3);
    // RGBA: a player without a dot has alpha 0 (moving his dot away instead would still draw it,
    // as the dots ignore depth).
    this.col = new Float32Array(n * 4);
    const c = new Color();
    colors.forEach((hex, i) => {
      c.set(hex);
      this.col.set([c.r, c.g, c.b, 1], i * 4);
    });
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new BufferAttribute(this.col, 4));
    this.mat = new PointsMaterial({ size: DOT_PX, sizeAttenuation: false, map: this.tex, vertexColors: true, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.05, toneMapped: false } as Record<string, unknown>);
    this.object = new Points(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = DOT_ORDER;
    this.object.visible = false;
  }

  /**
   * Place the dots just over the players' heads. `px` is how tall a player is drawn (playerPx),
   * `show` says which players get one (not the sent off, nor the one under the controlled marker),
   * `pixelRatio` the renderer's (point sizes are in device pixels).
   */
  update(heads: readonly Vector3[], show: (i: number) => boolean, px: number, pixelRatio: number): void {
    const alpha = dotAlpha(px);
    this.object.visible = alpha > 0;
    if (!alpha) return;
    this.mat.opacity = alpha;
    (this.mat as unknown as { size: number }).size = DOT_PX * pixelRatio;
    // Lift each dot by half its size plus a pixel, in metres at this scale, so it sits on the head.
    const lift = ((DOT_PX / 2 + 1) * 1.8) / Math.max(1, px);
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      this.pos[i * 3] = h.x;
      this.pos[i * 3 + 1] = h.y + lift;
      this.pos[i * 3 + 2] = h.z;
      this.col[i * 4 + 3] = show(i) ? 1 : 0;
    }
    (this.geo.attributes.position as BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
    this.object.removeFromParent();
  }
}
