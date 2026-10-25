// Hand-written, partial type declarations for the parts of three.js r186 that
// Derby Day uses. Not the official @types/three (that is an npm package, and
// npm is not a dependency here). Members not listed are reachable through the
// index signatures, typed `any`, so a missing declaration never blocks a build;
// add precise types here when you start relying on something new.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const REVISION: string;

// Constants
export const DoubleSide: number;
export const BackSide: number;
export const FrontSide: number;
export const AdditiveBlending: number;
export const NormalBlending: number;
export const RepeatWrapping: number;
export const ClampToEdgeWrapping: number;
export const SRGBColorSpace: string;
export const LinearSRGBColorSpace: string;
export const ACESFilmicToneMapping: number;
export const AgXToneMapping: number;
export const NeutralToneMapping: number;
export const PCFSoftShadowMap: number;
export const PCFShadowMap: number;
export const LinearFilter: number;
export const LinearMipmapLinearFilter: number;
export const NearestFilter: number;
export const DynamicDrawUsage: number;

export class Vector2 {
  constructor(x?: number, y?: number);
  x: number;
  y: number;
  set(x: number, y: number): this;
  [k: string]: any;
}

export class Vector3 {
  constructor(x?: number, y?: number, z?: number);
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): this;
  setScalar(v: number): this;
  copy(v: Vector3): this;
  clone(): Vector3;
  add(v: Vector3): this;
  sub(v: Vector3): this;
  addScaledVector(v: Vector3, s: number): this;
  multiplyScalar(s: number): this;
  subVectors(a: Vector3, b: Vector3): this;
  crossVectors(a: Vector3, b: Vector3): this;
  normalize(): this;
  length(): number;
  lengthSq(): number;
  lerp(v: Vector3, t: number): this;
  distanceTo(v: Vector3): number;
  dot(v: Vector3): number;
  applyQuaternion(q: Quaternion): this;
  [k: string]: any;
}

export class Vector4 {
  constructor(x?: number, y?: number, z?: number, w?: number);
  [k: string]: any;
}

export class Quaternion {
  constructor(x?: number, y?: number, z?: number, w?: number);
  setFromAxisAngle(axis: Vector3, angle: number): this;
  setFromEuler(e: Euler): this;
  multiply(q: Quaternion): this;
  premultiply(q: Quaternion): this;
  normalize(): this;
  identity(): this;
  slerp(q: Quaternion, t: number): this;
  [k: string]: any;
}

export class Euler {
  constructor(x?: number, y?: number, z?: number, order?: string);
  x: number;
  y: number;
  z: number;
  order: string;
  set(x: number, y: number, z: number, order?: string): this;
  [k: string]: any;
}

export class Matrix4 {
  constructor();
  compose(p: Vector3, q: Quaternion, s: Vector3): this;
  makeTranslation(x: number, y: number, z: number): this;
  makeRotationY(a: number): this;
  [k: string]: any;
}

export class Color {
  constructor(c?: string | number | Color);
  r: number;
  g: number;
  b: number;
  set(c: string | number | Color): this;
  setRGB(r: number, g: number, b: number): this;
  setHSL(h: number, s: number, l: number): this;
  getHSL(target: { h: number; s: number; l: number }): { h: number; s: number; l: number };
  copy(c: Color): this;
  clone(): Color;
  lerp(c: Color, t: number): this;
  multiplyScalar(s: number): this;
  getHex(): number;
  getHexString(): string;
  [k: string]: any;
}

export const MathUtils: {
  clamp(v: number, a: number, b: number): number;
  lerp(a: number, b: number, t: number): number;
  damp(a: number, b: number, lambda: number, dt: number): number;
  degToRad(d: number): number;
  radToDeg(r: number): number;
  [k: string]: any;
};

export class Layers {
  set(n: number): void;
  enable(n: number): void;
  [k: string]: any;
}

export class Object3D {
  constructor();
  name: string;
  parent: Object3D | null;
  children: Object3D[];
  position: Vector3;
  rotation: Euler;
  quaternion: Quaternion;
  scale: Vector3;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
  renderOrder: number;
  matrixAutoUpdate: boolean;
  userData: Record<string, any>;
  layers: Layers;
  add(...o: Object3D[]): this;
  remove(...o: Object3D[]): this;
  traverse(fn: (o: Object3D) => void): void;
  lookAt(x: number | Vector3, y?: number, z?: number): void;
  updateMatrix(): void;
  updateMatrixWorld(force?: boolean): void;
  getWorldPosition(v: Vector3): Vector3;
  [k: string]: any;
}

export class Group extends Object3D {}
export class Scene extends Object3D {
  background: Color | Texture | null;
  fog: Fog | null;
}

export class Fog {
  constructor(color: string | number | Color, near?: number, far?: number);
  color: Color;
  near: number;
  far: number;
}

export class Camera extends Object3D {
  updateProjectionMatrix(): void;
}

export class PerspectiveCamera extends Camera {
  constructor(fov?: number, aspect?: number, near?: number, far?: number);
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

export class OrthographicCamera extends Camera {
  constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

export class Light extends Object3D {
  color: Color;
  intensity: number;
}
export class AmbientLight extends Light {
  constructor(color?: string | number, intensity?: number);
}
export class HemisphereLight extends Light {
  constructor(sky?: string | number, ground?: string | number, intensity?: number);
  groundColor: Color;
}
export class DirectionalLight extends Light {
  constructor(color?: string | number, intensity?: number);
  target: Object3D;
  shadow: {
    camera: OrthographicCamera;
    mapSize: Vector2;
    bias: number;
    normalBias: number;
    radius: number;
    [k: string]: any;
  };
}

export class Texture {
  constructor(...args: any[]);
  image: any;
  wrapS: number;
  wrapT: number;
  repeat: Vector2;
  offset: Vector2;
  anisotropy: number;
  colorSpace: string;
  magFilter: number;
  minFilter: number;
  generateMipmaps: boolean;
  needsUpdate: boolean;
  clone(): this;
  dispose(): void;
  [k: string]: any;
}
export class CanvasTexture extends Texture {
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, ...rest: any[]);
}
export class DataTexture extends Texture {}

export class BufferAttribute {
  constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
  array: any;
  count: number;
  itemSize: number;
  needsUpdate: boolean;
  setUsage(u: number): this;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
  setXYZ(i: number, x: number, y: number, z: number): this;
  [k: string]: any;
}
export class Float32BufferAttribute extends BufferAttribute {
  constructor(array: ArrayLike<number> | number, itemSize: number, normalized?: boolean);
}
export class InstancedBufferAttribute extends BufferAttribute {}

export class BufferGeometry {
  constructor();
  attributes: Record<string, BufferAttribute>;
  index: BufferAttribute | null;
  setAttribute(name: string, a: BufferAttribute): this;
  getAttribute(name: string): BufferAttribute;
  setIndex(i: BufferAttribute | number[] | null): this;
  translate(x: number, y: number, z: number): this;
  rotateX(a: number): this;
  rotateY(a: number): this;
  rotateZ(a: number): this;
  scale(x: number, y: number, z: number): this;
  computeVertexNormals(): void;
  computeBoundingSphere(): void;
  toNonIndexed(): BufferGeometry;
  clone(): this;
  dispose(): void;
  [k: string]: any;
}
export class PlaneGeometry extends BufferGeometry {
  constructor(w?: number, h?: number, ws?: number, hs?: number);
}
export class BoxGeometry extends BufferGeometry {
  constructor(w?: number, h?: number, d?: number, ws?: number, hs?: number, ds?: number);
}
export class CylinderGeometry extends BufferGeometry {
  constructor(rt?: number, rb?: number, h?: number, radial?: number, hs?: number, open?: boolean, thetaStart?: number, thetaLength?: number);
}
export class ConeGeometry extends BufferGeometry {
  constructor(r?: number, h?: number, radial?: number, hs?: number, open?: boolean);
}
export class SphereGeometry extends BufferGeometry {
  constructor(r?: number, ws?: number, hs?: number, phiStart?: number, phiLength?: number, thetaStart?: number, thetaLength?: number);
}
export class IcosahedronGeometry extends BufferGeometry {
  constructor(r?: number, detail?: number);
}
export class OctahedronGeometry extends BufferGeometry {
  constructor(r?: number, detail?: number);
}
export class DodecahedronGeometry extends BufferGeometry {
  constructor(r?: number, detail?: number);
}
export class CapsuleGeometry extends BufferGeometry {
  constructor(r?: number, length?: number, capSegments?: number, radialSegments?: number, heightSegments?: number);
}
export class RingGeometry extends BufferGeometry {
  constructor(inner?: number, outer?: number, thetaSegments?: number, phiSegments?: number, thetaStart?: number, thetaLength?: number);
}
export class CircleGeometry extends BufferGeometry {
  constructor(r?: number, segments?: number, thetaStart?: number, thetaLength?: number);
}
export class TorusGeometry extends BufferGeometry {
  constructor(r?: number, tube?: number, radial?: number, tubular?: number, arc?: number);
}

export class Material {
  constructor(params?: Record<string, any>);
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
  depthTest: boolean;
  side: number;
  visible: boolean;
  needsUpdate: boolean;
  toneMapped: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  onBeforeCompile: (shader: { uniforms: Record<string, { value: any }>; vertexShader: string; fragmentShader: string }, renderer?: any) => void;
  customProgramCacheKey: () => string;
  dispose(): void;
  clone(): this;
  [k: string]: any;
}
export class MeshBasicMaterial extends Material {
  color: Color;
  map: Texture | null;
}
export class MeshLambertMaterial extends Material {
  color: Color;
  map: Texture | null;
  emissive: Color;
}
export class MeshStandardMaterial extends Material {
  color: Color;
  map: Texture | null;
  emissive: Color;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
}
export class ShaderMaterial extends Material {
  uniforms: Record<string, { value: any }>;
  vertexShader: string;
  fragmentShader: string;
}
export class SpriteMaterial extends Material {
  color: Color;
  map: Texture | null;
}
export class LineBasicMaterial extends Material {
  color: Color;
}
export class PointsMaterial extends Material {}

export class Mesh extends Object3D {
  constructor(geometry?: BufferGeometry, material?: Material | Material[]);
  geometry: BufferGeometry;
  material: Material;
}
export class InstancedMesh extends Mesh {
  constructor(geometry: BufferGeometry, material: Material, count: number);
  count: number;
  instanceMatrix: BufferAttribute;
  instanceColor: BufferAttribute | null;
  setMatrixAt(i: number, m: Matrix4): void;
  setColorAt(i: number, c: Color): void;
}
export class Sprite extends Object3D {
  constructor(material?: SpriteMaterial);
  material: SpriteMaterial;
  center: Vector2;
}
export class Line extends Object3D {
  constructor(geometry?: BufferGeometry, material?: Material);
  geometry: BufferGeometry;
  material: Material;
}
export class LineSegments extends Line {}
export class Points extends Object3D {
  constructor(geometry?: BufferGeometry, material?: Material);
  geometry: BufferGeometry;
  material: Material;
}

export class Sphere {
  constructor(center?: Vector3, radius?: number);
  center: Vector3;
  radius: number;
  [k: string]: any;
}
export class Plane {
  constructor(normal?: Vector3, constant?: number);
  [k: string]: any;
}
export class Ray {
  origin: Vector3;
  direction: Vector3;
  intersectPlane(p: Plane, target: Vector3): Vector3 | null;
  [k: string]: any;
}
export class Raycaster {
  constructor();
  ray: Ray;
  setFromCamera(coords: Vector2, camera: Camera): void;
  [k: string]: any;
}

export class WebGLRenderer {
  constructor(params?: {
    canvas?: HTMLCanvasElement;
    context?: WebGL2RenderingContext;
    antialias?: boolean;
    alpha?: boolean;
    powerPreference?: string;
    preserveDrawingBuffer?: boolean;
    stencil?: boolean;
    depth?: boolean;
    failIfMajorPerformanceCaveat?: boolean;
  });
  domElement: HTMLCanvasElement;
  shadowMap: { enabled: boolean; type: number; autoUpdate: boolean; needsUpdate: boolean };
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: string;
  info: { render: { calls: number; triangles: number; frame: number }; memory: { geometries: number; textures: number }; [k: string]: any };
  capabilities: { getMaxAnisotropy(): number; maxTextureSize: number; [k: string]: any };
  setPixelRatio(r: number): void;
  getPixelRatio(): number;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setClearColor(c: string | number | Color, alpha?: number): void;
  render(scene: Object3D, camera: Camera): void;
  compile(scene: Object3D, camera: Camera): void;
  dispose(): void;
  forceContextLoss(): void;
  getContext(): WebGL2RenderingContext;
  [k: string]: any;
}

export class Bone extends Object3D {
  readonly isBone: true;
}
export class Skeleton {
  constructor(bones: Bone[], boneInverses?: Matrix4[]);
  bones: Bone[];
  dispose(): void;
  [k: string]: any;
}
export class SkinnedMesh extends Mesh {
  constructor(geometry?: BufferGeometry, material?: Material);
  skeleton: Skeleton;
  bind(skeleton: Skeleton, bindMatrix?: Matrix4): void;
}
