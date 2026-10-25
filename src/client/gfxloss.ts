// WebGL context loss (a GPU or driver reset) on any screen that draws a match: a calm "Restoring
// graphics…" note over the pitch instead of a blank one, back to normal when the context returns, and
// a give-up after GFX_RESTORE_MS so the screen can carry on with the 2D renderer on a fresh canvas.

import { announce } from './a11y.ts';
import { PitchRenderer } from './render.ts';
import type { MatchRenderer } from './renderer.ts';
import { Renderer3D } from './r3d/renderer3d.ts';

/** A lost WebGL context not restored within this long: carry on in 2D. */
export const GFX_RESTORE_MS = 3000;

export interface GfxLossWatch {
  /** The context is lost right now (and not given up on yet). */
  readonly lost: boolean;
  dispose(): void;
}

/**
 * Watch a renderer's context. onLost/onRestored let the screen hold and resume what it shows;
 * onGiveUp runs once the wait is over (the note is gone by then) and should swap to 2D, e.g. with
 * fallback2D(). A 2D renderer has no context to lose: the watch does nothing.
 */
export function watchGfxLoss(r: MatchRenderer, host: HTMLElement, h: { onLost?(): void; onRestored?(): void; onGiveUp(): void }): GfxLossWatch {
  let lost = false;
  let timer = 0;
  let note: HTMLElement | null = null;
  const show = (on: boolean) => {
    if (on && !note) {
      note = document.createElement('div');
      note.className = 'gfx-note';
      note.setAttribute('role', 'status');
      note.textContent = 'Restoring graphics…';
      host.appendChild(note);
    }
    if (note) note.hidden = !on;
  };
  if (r instanceof Renderer3D) {
    r.onContextLost = () => {
      if (lost) return;
      lost = true;
      show(true);
      announce('Restoring graphics.');
      h.onLost?.();
      timer = window.setTimeout(() => {
        lost = false;
        show(false);
        h.onGiveUp();
      }, GFX_RESTORE_MS);
    };
    r.onContextRestored = () => {
      clearTimeout(timer);
      if (!lost) return;
      lost = false;
      show(false);
      h.onRestored?.();
    };
  }
  return {
    get lost() {
      return lost;
    },
    dispose() {
      clearTimeout(timer);
      note?.remove();
      if (r instanceof Renderer3D) r.onContextLost = r.onContextRestored = null;
    },
  };
}

/**
 * Dispose a renderer whose context is gone and put a 2D one on a fresh canvas in its place (a canvas
 * that had a WebGL context can't get a 2D one), keeping the canvas's id, class, role and labels.
 * Returns both; the caller rebinds anything that held the old canvas or renderer.
 */
export function fallback2D(old: HTMLCanvasElement, r: MatchRenderer): { canvas: HTMLCanvasElement; renderer: PitchRenderer } {
  r.dispose();
  const fresh = document.createElement('canvas');
  for (const a of ['id', 'class', 'tabindex', 'role', 'aria-roledescription', 'aria-label']) {
    const v = old.getAttribute(a);
    if (v !== null) fresh.setAttribute(a, v);
  }
  fresh.classList.remove('pitch-3d');
  const hadFocus = document.activeElement === old;
  old.replaceWith(fresh);
  const renderer = new PitchRenderer(fresh);
  fresh.dataset.renderer = '2d';
  fresh.dataset.fallback = 'context-lost';
  if (hadFocus) fresh.focus({ preventScroll: true });
  return { canvas: fresh, renderer };
}
