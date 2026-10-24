// Which keys a focused control keeps from the game (review of #19): a focused HUD button keeps Space
// and Enter, but WASD and the arrows still move the player.

import { describe, expect, test } from 'bun:test';
import { controlKeepsKey } from '../src/client/input.ts';

const canvas = {};
const el = (tagName: string, attrs: { type?: string; role?: string; editable?: boolean } = {}) => ({
  tagName,
  type: attrs.type,
  isContentEditable: !!attrs.editable,
  getAttribute: (n: string) => (n === 'role' ? (attrs.role ?? null) : null),
}) as unknown as EventTarget;

const GAME = ['w', 'a', 's', 'd', 'e', 'f', 'c', 'q'];
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

describe('controlKeepsKey', () => {
  test('the canvas and nothing focused keep nothing', () => {
    for (const k of [...GAME, ...ARROWS, ' ', 'Enter']) {
      expect(controlKeepsKey(canvas as EventTarget, canvas, k)).toBe(false);
      expect(controlKeepsKey(null, canvas, k)).toBe(false);
      expect(controlKeepsKey(el('DIV'), canvas, k)).toBe(false);
    }
  });

  test('buttons, checkboxes and links keep Space and Enter only', () => {
    for (const c of [el('BUTTON'), el('A'), el('INPUT', { type: 'checkbox' }), el('DIV', { role: 'button' }), el('SPAN', { role: 'switch' })]) {
      expect(controlKeepsKey(c, canvas, ' ')).toBe(true);
      expect(controlKeepsKey(c, canvas, 'Enter')).toBe(true);
      for (const k of [...GAME, ...ARROWS]) expect(controlKeepsKey(c, canvas, k)).toBe(false);
    }
  });

  test('radios, sliders and selects also keep the arrows, not WASD', () => {
    for (const c of [el('SELECT'), el('INPUT', { type: 'radio' }), el('INPUT', { type: 'range' }), el('DIV', { role: 'radio' })]) {
      for (const k of [' ', 'Enter', ...ARROWS]) expect(controlKeepsKey(c, canvas, k)).toBe(true);
      for (const k of GAME) expect(controlKeepsKey(c, canvas, k)).toBe(false);
    }
  });

  test('text fields keep every key', () => {
    for (const c of [el('INPUT', { type: 'text' }), el('INPUT'), el('TEXTAREA'), el('DIV', { editable: true })]) {
      for (const k of [...GAME, ...ARROWS, ' ', 'Enter']) expect(controlKeepsKey(c, canvas, k)).toBe(true);
    }
  });
});
