// The match renderer interface, and the factory that picks 3D (three.js) or
// the 2D canvas fallback. Live matches, hot-seat, linked matches and the
// replay viewer all go through createMatchRenderer().

import type { MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import { PitchRenderer, type RenderExtras } from './render.ts';
import { Renderer3D, type Quality } from './r3d/renderer3d.ts';

export interface MatchRenderer {
  readonly kind: '2d' | '3d';
  /** True when the picture changes with time even if the state does not (camera, crowd): draw every frame. */
  readonly continuous: boolean;
  /** Match the drawing buffer to the canvas's CSS size. */
  resize(): void;
  /** CSS pixel position inside the canvas to world metres on the pitch plane (mouse picking). */
  toWorld(cssX: number, cssY: number): Vec;
  /**
   * Build and draw once now, before the loop starts, so shader compiles and texture uploads (slow
   * on software GPUs) happen while the screen is being set up rather than in the first seconds of play.
   */
  prepare(s: MatchState): void;
  /** Draw one frame. Reads the state, never writes it. */
  draw(s: MatchState, extras: RenderExtras): void;
  /** A keyboard direction in screen terms (x right, y down) to world terms for the current view. */
  screenDir(d: Vec): Vec;
  /** Free GPU resources and listeners. */
  dispose(): void;
}

export type RendererPref = '2d' | '3d' | 'auto';

const PREF_KEY = 'derby-renderer';

function query(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** ?renderer=2d|3d, then localStorage, then auto. */
export function rendererPref(): RendererPref {
  const q = query('renderer');
  if (q === '2d' || q === '3d') return q;
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === '2d' || v === '3d') return v;
  } catch {
    /* storage blocked */
  }
  return 'auto';
}

export function setRendererPref(p: RendererPref): void {
  try {
    if (p === 'auto') localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, p);
  } catch {
    /* storage blocked */
  }
}

let probed: { ok: boolean; software: boolean } | null = null;

/** WebGL2 on a throwaway canvas, so a failure leaves the real canvas free for 2D. */
export function probeWebGL(): { ok: boolean; software: boolean } {
  if (probed) return probed;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return (probed = { ok: false, software: false });
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    probed = { ok: true, software: /swiftshader|llvmpipe|software|basic render/i.test(name) };
  } catch {
    probed = { ok: false, software: false };
  }
  return probed;
}

function quality(software: boolean): Quality {
  const q = query('quality');
  if (q === 'low' || q === 'high') return q;
  try {
    const v = localStorage.getItem('derby-quality');
    if (v === 'low' || v === 'high') return v;
  } catch {
    /* storage blocked */
  }
  return software ? 'low' : 'high';
}

export function createMatchRenderer(canvas: HTMLCanvasElement, opts: { cinematic?: boolean } = {}): MatchRenderer {
  const pref = rendererPref();
  if (pref !== '2d') {
    const gl = probeWebGL();
    if (gl.ok) {
      try {
        const r = new Renderer3D(canvas, { quality: quality(gl.software), cinematic: opts.cinematic });
        // The 3D camera works at any aspect ratio, so phones in portrait get a taller pitch (hud.css).
        canvas.classList.add('pitch-3d');
        return r;
      } catch (e) {
        console.warn('3D renderer unavailable, using 2D', e);
      }
    }
  }
  canvas.dataset.renderer = '2d';
  return new PitchRenderer(canvas);
}

/**
 * A small "Camera" chip on the pitch (and the V key) that switches between the broadcast and
 * end-to-end views, plus zoom: the mouse wheel over the pitch and the + / - keys (0 resets). The
 * chip is faint until used, and says what changed for a moment when the view or zoom changes.
 * Only for the 3D renderer; returns cleanup.
 */
export function mountCameraToggle(wrap: HTMLElement, r: MatchRenderer, canvas?: HTMLCanvasElement): () => void {
  if (!(r instanceof Renderer3D)) return () => {};
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pitch-cam';
  btn.id = 'cam-btn';
  btn.setAttribute('aria-keyshortcuts', 'V');
  btn.title = 'Switch camera (V). Zoom: mouse wheel or + / -';
  let flashTimer = 0;
  const viewName = () => (r.cameraMode === 'end' ? 'End' : 'Side');
  const label = () => {
    btn.textContent = `Cam: ${viewName()}`;
    btn.setAttribute('aria-label', `Camera: ${viewName().toLowerCase()} view, zoom ${Math.round(r.zoom * 100)} percent. Press V to switch.`);
  };
  // Say what changed, then settle back to the faint chip.
  const flash = (text: string) => {
    btn.textContent = text;
    btn.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      btn.classList.remove('flash');
      label();
    }, 1400);
  };
  label();
  const toggle = () => {
    r.setCameraMode(r.cameraMode === 'end' ? 'broadcast' : 'end');
    label();
    flash(`Camera: ${viewName()}`);
  };
  const zoom = (dir: 1 | -1 | 0) => {
    const z = dir === 0 ? r.setZoom(1) : r.zoomStep(dir);
    label();
    flash(`Zoom ${Math.round(z * 100)}%`);
  };
  btn.addEventListener('click', (e) => {
    toggle();
    if (e.detail > 0) btn.blur();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key;
    if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0') {
      // + shows more pitch (zooms out), - less, 0 back to the default.
      e.preventDefault();
      zoom(k === '0' ? 0 : k === '-' || k === '_' ? -1 : 1);
      return;
    }
    if (e.repeat) return;
    if (k.toLowerCase() === 'v') toggle();
  };
  // Wheel down (toward you) pulls the camera back, like map apps. One step per notch, whatever the
  // device's delta, so a trackpad fling doesn't jump from one limit to the other.
  let wheelAt = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // pinch-zoom of the page
    e.preventDefault();
    const now = performance.now();
    if (Math.abs(e.deltaY) < 1 || now - wheelAt < 70) return;
    wheelAt = now;
    zoom(e.deltaY > 0 ? 1 : -1);
  };
  window.addEventListener('keydown', onKey);
  canvas?.addEventListener('wheel', onWheel, { passive: false });
  const anchor = wrap.querySelector('#pause');
  anchor ? wrap.insertBefore(btn, anchor) : wrap.appendChild(btn);
  return () => {
    clearTimeout(flashTimer);
    window.removeEventListener('keydown', onKey);
    canvas?.removeEventListener('wheel', onWheel);
    btn.remove();
  };
}
