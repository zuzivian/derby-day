// The match renderer interface, and the factory that picks 3D (three.js) or
// the 2D canvas fallback. Live matches, hot-seat, linked matches and the
// replay viewer all go through createMatchRenderer().

import type { MatchState } from '../sim/types.ts';
import type { Vec } from '../sim/vec.ts';
import { PitchRenderer, type RenderExtras } from './render.ts';
import { Renderer3D, type Quality } from './r3d/renderer3d.ts';
import { showToast } from './a11y.ts';

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

let toldFallback = false;
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
  let why: string | null = null;
  if (pref !== '2d') {
    const gl = probeWebGL();
    if (!gl.ok) why = 'webgl-unavailable';
    if (gl.ok) {
      try {
        const r = new Renderer3D(canvas, { quality: quality(gl.software), cinematic: opts.cinematic });
        // The 3D camera works at any aspect ratio, so phones in portrait get a taller pitch (hud.css).
        canvas.classList.add('pitch-3d');
        return r;
      } catch (e) {
        console.warn('3D renderer unavailable, using 2D', e);
        why = 'webgl-failed';
      }
    }
  }
  canvas.dataset.renderer = '2d';
  if (why) {
    // Not asked for 2D, but 3D is not possible here: say so (once a page load) instead of silently looking different.
    canvas.dataset.fallback = why;
    if (!toldFallback) showToast('3D view is not available on this device, so you are seeing the simple 2D view.', false, 6000);
    toldFallback = true;
  }
  return new PitchRenderer(canvas);
}

/** Wheel zoom: the zoom scales by exp(px * this) for px pixels of scroll (100 px ≈ ×1.13). */
export const WHEEL_ZOOM_PER_PX = Math.log(1.12) / 100;
/** A trackpad pinch arrives as a wheel event with ctrlKey and small deltas: this much more gain. */
export const PINCH_GAIN = 6;

/**
 * Is this ctrl+wheel a trackpad pinch (small, often fractional pixel deltas) rather than a mouse wheel
 * with Ctrl held (a notch is about 100 px, or lines/pages)? A mouse's ctrl+wheel is left to the browser's
 * page zoom, which people rely on.
 */
export const isPinch = (e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): boolean => e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50;

/** The camera zoom after one wheel event over the pitch (a trackpad pinch is a ctrl+wheel). */
export function wheelZoom(zoom: number, e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) * (e.ctrlKey ? PINCH_GAIN : 1);
  if (!px) return zoom;
  return zoom * Math.exp(Math.max(-150, Math.min(150, px)) * WHEEL_ZOOM_PER_PX);
}

/**
 * A small "Camera" chip on the pitch (and the V key) that switches between the broadcast and
 * end-to-end views, plus zoom: the mouse wheel over the pitch, the + / - keys (0 resets), and on
 * touch screens a pinch or the − / + buttons. The chip says what changed for a moment when the
 * view or zoom changes.
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
  // A trackpad pinch arrives as ctrl+wheel with no Control key pressed; a mouse wheel with Ctrl held
  // (even a smooth-scrolling one with small deltas) has a real Control keydown before it.
  let ctrlHeld = false;
  const onCtrl = (e: KeyboardEvent) => {
    if (e.key === 'Control') ctrlHeld = e.type === 'keydown';
  };
  const onBlur = () => {
    ctrlHeld = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key;
    if (k === '+' || k === '=' || k === '-' || k === '_' || k === '0') {
      // + zooms in (bigger players, less pitch), - zooms out, 0 back to the default.
      e.preventDefault();
      zoom(k === '0' ? 0 : k === '-' || k === '_' ? 1 : -1);
      return;
    }
    if (e.repeat) return;
    if (k.toLowerCase() === 'v') toggle();
  };
  // Wheel down (toward you) pulls the camera back, like map apps, and a trackpad pinch out zooms in. Zoom follows how far the wheel
  // or trackpad scrolls (a mouse notch of about 100 px is about one ZOOM_STEP), so a gentle trackpad
  // scroll zooms a little rather than jumping to a limit. Listened for on the whole pitch area, so
  // the HUD buttons over it don't scroll the page either.
  let flashAt = 0;
  const onWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement | null)?.closest('#pause')) return;
    // A mouse wheel with Ctrl held zooms the page as usual; a trackpad pinch (also ctrl+wheel) over
    // the pitch zooms the camera, not the page.
    if (e.ctrlKey && (ctrlHeld || !isPinch(e))) return;
    e.preventDefault();
    const z = wheelZoom(r.zoom, e);
    if (z === r.zoom) return;
    r.setZoom(z);
    label();
    const now = performance.now();
    if (now - flashAt > 120) {
      flashAt = now;
      flash(`Zoom ${Math.round(r.zoom * 100)}%`);
    }
  };
  const wheelEl = canvas?.parentElement ?? canvas;
  // Pinch to zoom on touch screens: two fingers on the pitch scale the zoom by how far apart they
  // move (spreading them shows less pitch, like a map). One finger still steers (input.ts).
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d0: number; z0: number } | null = null;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) pinch = { d0: Math.max(20, spread()), z0: r.zoom };
  };
  const onMove = (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      r.setZoom(pinch.z0 * (pinch.d0 / Math.max(20, spread())));
      label();
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return;
    if (pinch && touches.size < 2) {
      pinch = null;
      flash(`Zoom ${Math.round(r.zoom * 100)}%`);
    }
  };
  // On-screen zoom buttons (shown on touch screens, hud.css), so zoom needs neither wheel nor keys.
  const zoomBox = document.createElement('span');
  zoomBox.className = 'pitch-zoom';
  zoomBox.innerHTML = '<button type="button" data-zoom="1" aria-label="Zoom out: more pitch">−</button><button type="button" data-zoom="-1" aria-label="Zoom in: bigger players">+</button>';
  zoomBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]');
    if (b) zoom(Number(b.dataset.zoom) as 1 | -1);
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onCtrl);
  window.addEventListener('keyup', onCtrl);
  window.addEventListener('blur', onBlur);
  wheelEl?.addEventListener('wheel', onWheel, { passive: false });
  canvas?.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  const anchor = wrap.querySelector('#pause');
  anchor ? wrap.insertBefore(btn, anchor) : wrap.appendChild(btn);
  btn.after(zoomBox);
  return () => {
    clearTimeout(flashTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onCtrl);
    window.removeEventListener('keyup', onCtrl);
    window.removeEventListener('blur', onBlur);
    wheelEl?.removeEventListener('wheel', onWheel);
    canvas?.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    btn.remove();
    zoomBox.remove();
  };
}
