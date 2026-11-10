// Post-processing for the 3D view at high quality: the scene is drawn to a multisampled HDR target,
// bright parts (floodlight lamps, their glow, a sunlit white shirt) bleed a soft bloom, a light
// vignette frames the picture, and the final pass applies the same ACES tone mapping and sRGB
// output the renderer would have applied itself, so colours away from the bloom are unchanged (the
// kit-versus-grass model in kits.ts is fitted to them).
//
// Bloom is a dual-filter blur: a thresholded downsample to half size, three more halvings, then
// tent-filtered upsamples added back up the chain. Eight cheap full-screen passes in all.

import {
  AdditiveBlending,
  HalfFloatType,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from './three.ts';

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** Downsample with a 13-tap-ish box (four bilinear taps at half-texel offsets plus the centre); the first pass thresholds. */
const DOWN = `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; uniform bool uPrefilter;
varying vec2 vUv;
vec3 pre(vec3 c){
  if (!uPrefilter) return c;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * w;
}
void main(){
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;
  gl_FragColor = vec4(pre(min(c / 8.0, vec3(64.0))), 1.0);
}`;

/** Upsample with a 9-tap tent, added onto the next larger level. */
const UP = `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uScatter;
varying vec2 vUv;
void main(){
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, -o.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  gl_FragColor = vec4(c / 16.0 * uScatter, 1.0);
}`;

/** Scene plus bloom, vignette, then three's own tone mapping and output colour space (injected for a screen target). */
const COMPOSITE = `
uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uBloom; uniform float uVignette; uniform vec3 uTint;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom * uTint;
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.18, 0.75, dot(d, d) * 2.0);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface PostSettings {
  /** Bloom added on top of the scene (0 = none). */
  bloom: number;
  /** Linear brightness where bloom starts, and the soft knee below it. */
  threshold: number;
  knee: number;
  /** Darkening toward the corners, 0..1. */
  vignette: number;
}

const LEVELS = 4;

export class PostFX {
  private scene: WebGLRenderTarget;
  private mips: WebGLRenderTarget[] = [];
  private quad: Mesh;
  private quadScene = new Scene();
  private cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private down: ShaderMaterial;
  private up: ShaderMaterial;
  private comp: ShaderMaterial;
  private size = new Vector2();
  settings: PostSettings = { bloom: 0.5, threshold: 1.6, knee: 0.6, vignette: 0.22 };

  constructor(private gl: WebGLRenderer) {
    // Multisampled, so edges stay as clean as the canvas's own antialiasing made them.
    this.scene = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4, depthBuffer: true });
    for (let i = 0; i < LEVELS; i++) this.mips.push(new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }));
    const common = { vertexShader: VERT, depthTest: false, depthWrite: false };
    this.down = new ShaderMaterial({ ...common, fragmentShader: DOWN, blending: NoBlending, toneMapped: false, uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uPrefilter: { value: false } } });
    this.up = new ShaderMaterial({ ...common, fragmentShader: UP, blending: AdditiveBlending, toneMapped: false, uniforms: { tSrc: { value: null }, uTexel: { value: new Vector2() }, uScatter: { value: 0.85 } } });
    this.comp = new ShaderMaterial({ ...common, fragmentShader: COMPOSITE, blending: NoBlending, uniforms: { tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 0 }, uVignette: { value: 0 }, uTint: { value: [1, 0.97, 0.9] } } });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.comp);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Match the drawing buffer. */
  setSize(): void {
    this.gl.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    this.scene.setSize(w, h);
    for (let i = 0; i < LEVELS; i++) this.mips[i].setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)));
  }

  private pass(mat: ShaderMaterial, target: WebGLRenderTarget | null, clear: boolean): void {
    this.quad.material = mat;
    this.gl.setRenderTarget(target);
    if (clear) this.gl.clear(true, false, false);
    this.gl.render(this.quadScene, this.cam);
  }

  /** Draw `scene` through the effects to the canvas. */
  render(scene: Object3D, camera: Camera): void {
    const gl = this.gl;
    const s = this.settings;
    // Follow the drawing buffer (a resize, a pixel-ratio change from the governor or a new screen).
    gl.getDrawingBufferSize(this.size);
    if (Math.floor(this.size.x) !== this.scene.width || Math.floor(this.size.y) !== this.scene.height) this.setSize();
    gl.setRenderTarget(this.scene);
    gl.render(scene, camera);
    const bloomOn = s.bloom > 0.001;
    if (bloomOn) {
      // Down the chain: the first pass thresholds.
      let src: Texture = this.scene.texture;
      let sw = this.scene.width;
      let sh = this.scene.height;
      for (let i = 0; i < LEVELS; i++) {
        const u = this.down.uniforms;
        u.tSrc.value = src;
        u.uTexel.value.set(1 / sw, 1 / sh);
        u.uPrefilter.value = i === 0;
        u.uThreshold.value = s.threshold;
        u.uKnee.value = s.knee;
        this.pass(this.down, this.mips[i], false);
        src = this.mips[i].texture;
        sw = this.mips[i].width;
        sh = this.mips[i].height;
      }
      // Back up: each level blurred onto the one above it (additive).
      for (let i = LEVELS - 1; i > 0; i--) {
        const u = this.up.uniforms;
        u.tSrc.value = this.mips[i].texture;
        u.uTexel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
        this.pass(this.up, this.mips[i - 1], false);
      }
    }
    const c = this.comp.uniforms;
    c.tScene.value = this.scene.texture;
    c.tBloom.value = this.mips[0].texture;
    c.uBloom.value = bloomOn ? s.bloom : 0;
    c.uVignette.value = s.vignette;
    this.pass(this.comp, null, false);
  }

  dispose(): void {
    this.scene.dispose();
    for (const m of this.mips) m.dispose();
    this.down.dispose();
    this.up.dispose();
    this.comp.dispose();
    this.quad.geometry.dispose();
  }
}
